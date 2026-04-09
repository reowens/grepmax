# Known Limitations

Verified 2026-04-09.

## Project registry writes not serialized

`project-registry.ts` reads and writes `projects.json` without file-level locking. Concurrent `gmax add` from multiple terminals can corrupt the registry via interleaved read-modify-write. The daemon serializes via `withProjectLock` and `saveRegistry` uses atomic write (tmp + rename), so the risk is limited to concurrent CLI usage. Low severity.
