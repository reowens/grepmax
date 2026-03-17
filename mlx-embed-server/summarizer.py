"""MLX-accelerated code summarizer for grepmax.

Runs Qwen3-Coder-30B-A3B on Apple Silicon GPU to generate one-line
summaries of code chunks during indexing. Summaries are stored in
LanceDB and returned in search results.

IMPORTANT: All MLX operations must run on a single thread. FastAPI async
endpoints run on the event loop thread, avoiding Metal thread-safety crashes.
"""

import asyncio
import logging
import os
import re
import signal
import socket
import time
import warnings
from contextlib import asynccontextmanager

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
from mlx_lm import load, generate
from pydantic import BaseModel

MODEL_ID = os.environ.get(
    "MLX_SUMMARY_MODEL",
    "lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-MLX-4bit",
)
PORT = int(os.environ.get("MLX_SUMMARY_PORT", "8101"))
IDLE_TIMEOUT_S = int(os.environ.get("MLX_SUMMARY_IDLE_TIMEOUT", "1800"))  # 30 min
MAX_TOKENS = 40  # summaries are ~20 tokens, one line

model = None
tokenizer = None
last_activity = time.time()

_mlx_lock = asyncio.Lock()

SYSTEM_PROMPT = """You are a code summarizer. Given a code chunk, produce exactly one line describing what it does.
Be specific about business logic, services, and side effects. Do not describe syntax.
Do not use phrases like "This function" or "This code". Start with a verb. /no_think"""

def build_prompt(code: str, language: str, file: str, symbols: list[str] | None = None) -> str:
    parts = [f"Language: {language}", f"File: {file}"]
    if symbols:
        parts.append(f"Defines: {', '.join(symbols)}")
    parts.append(f"\n```\n{code}\n```")
    return "\n".join(parts)


def is_port_in_use(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def summarize_chunk(code: str, language: str, file: str, symbols: list[str] | None = None) -> str:
    """Generate a one-line summary for a code chunk."""
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_prompt(code, language, file, symbols)},
    ]
    prompt = tokenizer.apply_chat_template(
        messages, tokenize=False, add_generation_prompt=True
    )
    response = generate(
        model,
        tokenizer,
        prompt=prompt,
        max_tokens=MAX_TOKENS,
        verbose=False,
    )
    # Strip thinking tokens if present
    text = re.sub(r"<think>.*?</think>", "", response, flags=re.DOTALL).strip()
    if not text:
        text = response.strip()
    # Take first line only, strip whitespace
    summary = text.split("\n")[0].strip()
    # Remove common prefixes the model might add
    for prefix in ["Summary: ", "summary: ", "- "]:
        if summary.startswith(prefix):
            summary = summary[len(prefix):]
    return summary


def load_model():
    global model, tokenizer
    print(f"[summarizer] Loading {MODEL_ID}...")
    model, tokenizer = load(MODEL_ID)
    # Warm up
    _ = summarize_chunk("function hello() { return 'world'; }", "javascript", "test.js")
    print("[summarizer] Model ready on Metal GPU.")


async def idle_watchdog():
    while True:
        await asyncio.sleep(60)
        if time.time() - last_activity > IDLE_TIMEOUT_S:
            print("[summarizer] Idle timeout, shutting down")
            os._exit(0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    asyncio.create_task(idle_watchdog())
    yield


app = FastAPI(lifespan=lifespan)


class ChunkInput(BaseModel):
    code: str
    language: str = "unknown"
    file: str = ""
    symbols: list[str] = []


class SummarizeRequest(BaseModel):
    chunks: list[ChunkInput]


class SummarizeResponse(BaseModel):
    summaries: list[str]


@app.post("/summarize")
async def summarize(request: SummarizeRequest) -> SummarizeResponse:
    global last_activity
    last_activity = time.time()

    summaries = []
    async with _mlx_lock:
        for chunk in request.chunks:
            try:
                summary = summarize_chunk(chunk.code, chunk.language, chunk.file, chunk.symbols or None)
                summaries.append(summary)
            except Exception as e:
                summaries.append(f"(summary failed: {e})")

    return SummarizeResponse(summaries=summaries)


@app.get("/health")
async def health():
    # Health check must NOT acquire _mlx_lock — it must respond instantly
    # even when a summarization is in progress
    global last_activity
    last_activity = time.time()
    return {"status": "ok", "model": MODEL_ID}


def main():
    if is_port_in_use(PORT):
        print(f"[summarizer] Port {PORT} already in use — server is already running.")
        return

    print(f"[summarizer] Starting on port {PORT}")

    def handle_signal(sig, frame):
        print("[summarizer] Stopped.")
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
