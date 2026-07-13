"""MLX-accelerated embedding server for grepmax.

Serves granite-embedding-small-english-r2 on Apple Silicon GPU via MLX.
gmax workers call POST /embed with {"texts": [...]} and get back {"vectors": [...]}.
Falls through to ONNX CPU if this server isn't running.

IMPORTANT: All MLX operations must run on a single thread. FastAPI async
endpoints run on the event loop thread, avoiding the Metal thread-safety
crashes that occur when uvicorn's sync threadpool dispatches concurrent
GPU operations.
"""

import asyncio
import logging
import os
import signal
import socket
import time
import warnings
from contextlib import asynccontextmanager

# Suppress all HF/transformers/tqdm noise before any imports touch them
os.environ["TRANSFORMERS_NO_ADVISORY_WARNINGS"] = "1"
os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
os.environ["HF_HUB_VERBOSITY"] = "error"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"

# Auto-enable offline mode when the model is already cached, so steady-state
# startups don't HEAD-check huggingface.co (annoying firewall prompts, slow
# starts on flaky networks). First run with an empty cache stays online so
# the model can be fetched. Force one or the other with GMAX_HF_ONLINE=1
# or GMAX_HF_OFFLINE=1.
def _hf_cache_has_model(model_id: str) -> bool:
    hf_home = os.environ.get("HF_HOME") or os.path.expanduser(
        os.path.join("~", ".cache", "huggingface")
    )
    cache_dir = os.path.join(
        hf_home, "hub", "models--" + model_id.replace("/", "--")
    )
    return os.path.isdir(cache_dir) and bool(os.listdir(cache_dir))

_model_id_for_cache_check = os.environ.get(
    "MLX_EMBED_MODEL", "ibm-granite/granite-embedding-small-english-r2"
)
if os.environ.get("GMAX_HF_OFFLINE") == "1" or (
    os.environ.get("GMAX_HF_ONLINE") != "1"
    and _hf_cache_has_model(_model_id_for_cache_check)
):
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
warnings.filterwarnings("ignore", message=".*PyTorch.*")
warnings.filterwarnings("ignore", message=".*resource_tracker.*")
logging.getLogger("huggingface_hub").setLevel(logging.ERROR)

logging.basicConfig(
    format="%(asctime)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    level=logging.INFO,
)
logger = logging.getLogger("mlx-embed")


import mlx.core as mx
import uvicorn
from fastapi import FastAPI, HTTPException
from mlx_embeddings import load
from pydantic import BaseModel
from transformers import AutoTokenizer

MODEL_ID = os.environ.get(
    "MLX_EMBED_MODEL", "ibm-granite/granite-embedding-small-english-r2"
)
OWNER_TOKEN = os.environ.get("GMAX_EMBED_OWNER_TOKEN")
PORT = int(os.environ.get("MLX_EMBED_PORT", "8100"))
MAX_BATCH = int(os.environ.get("MLX_EMBED_MAX_BATCH", "64"))
IDLE_TIMEOUT_S = int(os.environ.get("MLX_EMBED_IDLE_TIMEOUT", "1800"))  # 30 min
DEBUG = os.environ.get("GMAX_DEBUG") == "1"

model = None
tokenizer = None
last_activity = time.time()

# Serialize all MLX GPU operations — Metal is not thread-safe
_mlx_lock = asyncio.Lock()


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def embed_texts(texts: list[str]) -> mx.array:
    """Tokenize, forward pass, L2 normalize.

    mlx_embeddings model already does mean pooling internally —
    last_hidden_state is (batch, dim), not (batch, seq, dim).
    """
    encoded = tokenizer(
        texts, padding=True, truncation=True, max_length=256, return_tensors="np"
    )
    input_ids = mx.array(encoded["input_ids"])
    attention_mask = mx.array(encoded["attention_mask"])

    outputs = model(input_ids=input_ids, attention_mask=attention_mask)

    # text_embeds is the pooled output; fall back to last_hidden_state
    if hasattr(outputs, "text_embeds") and outputs.text_embeds is not None:
        pooled = outputs.text_embeds
    else:
        pooled = outputs.last_hidden_state

    # L2 normalize
    norms = mx.sqrt(mx.sum(pooled * pooled, axis=-1, keepdims=True))
    norms = mx.maximum(norms, 1e-12)
    normalized = pooled / norms
    mx.eval(normalized)

    # Free intermediate tensors and clear Metal GPU cache to prevent memory leak
    del input_ids, attention_mask, outputs, pooled, norms
    mx.clear_cache()

    return normalized


def load_model():
    global model, tokenizer
    logger.info(f"[mlx-embed] Loading {MODEL_ID}...")
    model, _ = load(MODEL_ID)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    _ = embed_texts(["warm up"])
    logger.info("[mlx-embed] Model ready on Metal GPU.")


async def idle_watchdog():
    while True:
        await asyncio.sleep(60)
        if DEBUG:
            active_mb = mx.metal.get_active_memory() / (1024 * 1024)
            cache_mb = mx.metal.get_cache_memory() / (1024 * 1024)
            idle_s = time.time() - last_activity
            logger.info(
                f"[mlx-embed] watchdog: idle={idle_s:.0f}s "
                f"active={active_mb:.0f}MB cache={cache_mb:.0f}MB"
            )
        if time.time() - last_activity > IDLE_TIMEOUT_S:
            logger.info("[mlx-embed] Idle timeout, shutting down")
            os._exit(0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    asyncio.create_task(idle_watchdog())
    yield


app = FastAPI(lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str]
    expected_model: str | None = None


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    dim: int
    model: str


@app.post("/embed")
async def embed(request: EmbedRequest) -> EmbedResponse:
    global last_activity
    last_activity = time.time()

    if len(request.texts) > MAX_BATCH:
        raise HTTPException(
            status_code=413,
            detail=f"Batch contains {len(request.texts)} texts; maximum is {MAX_BATCH}",
        )
    if request.expected_model and request.expected_model != MODEL_ID:
        raise HTTPException(
            status_code=409,
            detail=f"Requested model {request.expected_model} is not loaded",
        )

    texts = request.texts
    start = time.monotonic()

    async with _mlx_lock:
        vectors = embed_texts(texts)
        vectors_list = vectors.tolist()
        del vectors

    elapsed_ms = (time.monotonic() - start) * 1000
    if DEBUG:
        active_mb = mx.metal.get_active_memory() / (1024 * 1024)
        cache_mb = mx.metal.get_cache_memory() / (1024 * 1024)
        logger.info(
            f"[mlx-embed] embed {len(texts)} texts → {elapsed_ms:.0f}ms "
            f"(active={active_mb:.0f}MB cache={cache_mb:.0f}MB)"
        )

    return EmbedResponse(
        vectors=vectors_list,
        dim=len(vectors_list[0]) if vectors_list else 0,
        model=MODEL_ID,
    )


@app.get("/health")
async def health():
    global last_activity
    last_activity = time.time()
    response = {"status": "ok", "model": MODEL_ID}
    if OWNER_TOKEN:
        response["owner"] = OWNER_TOKEN
    return response


def main():
    # Set process name for Activity Monitor
    proc_name = os.environ.get("GMAX_PROCESS_NAME", "gmax-embed")
    try:
        from setproctitle import setproctitle
        setproctitle(proc_name)
    except ImportError:
        pass

    # Bail early if port is already taken
    if is_port_in_use(PORT):
        logger.info(f"[mlx-embed] Port {PORT} already in use — server is already running.")
        return

    logger.info(f"[mlx-embed] Starting on port {PORT}")

    # Clean shutdown — exit immediately, skip uvicorn's noisy teardown
    def handle_signal(sig, frame):
        logger.info("[mlx-embed] Stopped.")
        # Kill the resource_tracker child process before exit to prevent
        # its spurious "leaked semaphore" warning (Python 3.13 bug)
        try:
            from multiprocessing.resource_tracker import _resource_tracker
            if _resource_tracker._pid is not None:
                os.kill(_resource_tracker._pid, signal.SIGKILL)
        except Exception:
            pass
        os._exit(0)

    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
