import { fileURLToPath } from "node:url";

// Use only within an explicitly authorized, bounded focused invocation.
export default {
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: [
      "tests/cpu-capacity.test.ts",
      "tests/worker-threads-setting.test.ts",
      "tests/config-command.test.ts",
      "tests/worker-pool-resilience.test.ts",
    ],
    // Nested suite names can be separated by " > ", unlike JSON fullName fields.
    testNamePattern:
      "effective CPU capacity|worker threads setting|config command.*worker threads|global indexing CPU admission|file retry admission",
    globalSetup: [],
    maxWorkers: 1,
    fileParallelism: false,
  },
};
