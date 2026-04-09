# Known Limitations

Verified 2026-04-08.

## LLM server crash not handled

If llama-server dies, the PID file still points to a dead process. `ensure()` in `src/lib/llm/server.ts` recovers on next use via `healthy()` HTTP check + `start()`, but there is no proactive monitoring during idle periods. No automatic restart between calls.

## No dead-letter tracking

Files that repeatedly fail processing are dropped after 5 retries (`MAX_RETRIES` in `batch-processor.ts`) with a `console.warn` showing the drop count. No persistent record is kept — the in-memory `retryCount` map is the only tracking, and it's lost on restart.

