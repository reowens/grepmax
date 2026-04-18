// Intentionally a no-op.
//
// Previously this ran `gmax watch stop` on every Claude SessionEnd. With
// multiple concurrent Claude sessions sharing one daemon, that meant *any*
// session ending killed the daemon for every *other* session — silently
// breaking their search/index and forcing repeated daemon restarts.
//
// The daemon's own 30-minute idle timeout handles cleanup when nothing is
// using it, so SessionEnd has no work to do here.
