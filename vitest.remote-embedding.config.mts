import { defineConfig } from "vitest/config";

// No grammar preparation/global setup: this selection uses fake bytes/models only.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/remote-embedding-routing.test.ts", "tests/remote-embedding-executor.test.ts", "tests/remote-embedding-artifacts.test.ts"],
    setupFiles: ["tests/remote-embedding-setup.ts"],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
