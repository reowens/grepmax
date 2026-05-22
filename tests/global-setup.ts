// Tree-sitter grammars are normally downloaded by `gmax setup` on first run.
// In CI (and on a dev machine that hasn't run setup yet), they're absent, so
// TreeSitterChunker silently falls back to a chunker that doesn't extract
// definedSymbols — and tests like tests/chunking.test.ts fail. ensureGrammars
// is idempotent (skips files already on disk), so this is a no-op when the
// grammars are already cached at ~/.gmax/grammars/.
import { ensureGrammars } from "../src/lib/index/grammar-loader";

export default async function globalSetup(): Promise<void> {
  await ensureGrammars(() => {}, { silent: true });
}
