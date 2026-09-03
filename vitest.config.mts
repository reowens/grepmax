import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    // Agent worktrees live under .claude/worktrees (gitignored) and carry a
    // full copy of tests/. Without this exclude, vitest run from the main
    // tree discovers and runs that copy too, and the preversion gate fails
    // on tests that never belonged to this checkout.
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
