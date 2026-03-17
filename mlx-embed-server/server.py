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
warnings.filterwarnings("ignore", message=".*PyTorch.*")
warnings.filterwarnings("ignore", message=".*resource_tracker.*")
logging.getLogger("huggingface_hub").setLevel(logging.ERROR)




import mlx.core as mx
import uvicorn
from fastapi import FastAPI
from mlx_embeddings import load
from pydantic import BaseModel
from transformers import AutoTokenizer

MODEL_ID = os.environ.get(
    "MLX_EMBED_MODEL", "ibm-granite/granite-embedding-small-english-r2"
)
PORT = int(os.environ.get("MLX_EMBED_PORT", "8100"))
MAX_BATCH = int(os.environ.get("MLX_EMBED_MAX_BATCH", "64"))
IDLE_TIMEOUT_S = int(os.environ.get("MLX_EMBED_IDLE_TIMEOUT", "1800"))  # 30 min

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
    return normalized


def load_model():
    global model, tokenizer
    print(f"[mlx-embed] Loading {MODEL_ID}...")
    model, _ = load(MODEL_ID)
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID)
    _ = embed_texts(["warm up"])
    print("[mlx-embed] Model ready on Metal GPU.")


async def idle_watchdog():
    while True:
        await asyncio.sleep(60)
        if time.time() - last_activity > IDLE_TIMEOUT_S:
            print("[mlx-embed] Idle timeout, shutting down")
            os._exit(0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    asyncio.create_task(idle_watchdog())
    yield


app = FastAPI(lifespan=lifespan)


class EmbedRequest(BaseModel):
    texts: list[str]


class EmbedResponse(BaseModel):
    vectors: list[list[float]]
    dim: int


@app.post("/embed")
async def embed(request: EmbedRequest) -> EmbedResponse:
    global last_activity
    last_activity = time.time()

    texts = request.texts[:MAX_BATCH]

    async with _mlx_lock:
        vectors = embed_texts(texts)
        vectors_list = vectors.tolist()

    return EmbedResponse(
        vectors=vectors_list,
        dim=len(vectors_list[0]) if vectors_list else 0,
    )


@app.get("/health")
async def health():
    global last_activity
    last_activity = time.time()
    return {"status": "ok", "model": MODEL_ID}


def main():
    # Bail early if port is already taken
    if is_port_in_use(PORT):
        print(f"[mlx-embed] Port {PORT} already in use — server is already running.")
        return

    print(f"[mlx-embed] Starting on port {PORT}")

    # Clean shutdown — exit immediately, skip uvicorn's noisy teardown
    def handle_signal(sig, frame):
        print("[mlx-embed] Stopped.")
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
