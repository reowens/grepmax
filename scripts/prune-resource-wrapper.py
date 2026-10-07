"""CI-only accounting around the unchanged prune helper, in the same process.

Keeping the helper in this process preserves its real Node lease-owner parent.
The sidecar is outside the Lance table. SIGKILL/termination may prevent it from
being written; the harness records sampled RSS/thread counts for those cases.
"""
import json
from pathlib import Path
import resource
import runpy
import sys
import time

root = Path(sys.argv[sys.argv.index("--store") + 1])
helper = Path(__file__).resolve().parents[1] / "lance-maintenance" / "prune.py"
started = time.monotonic()
try:
    runpy.run_path(str(helper), run_name="__main__")
finally:
    usage = resource.getrusage(resource.RUSAGE_SELF)
    evidence = {"elapsedMs": round((time.monotonic() - started) * 1000),
                "peakRssBytes": int(usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024)),
                "cpuUserSeconds": usage.ru_utime, "cpuSystemSeconds": usage.ru_stime,
                "blockInputs": usage.ru_inblock, "blockOutputs": usage.ru_oublock,
                "measurement": "per-process RSS, not macOS physical footprint"}
    (root.parent / "helper-resources.json").write_text(json.dumps(evidence))
