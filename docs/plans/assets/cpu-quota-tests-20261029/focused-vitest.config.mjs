export default {
  "root": "<repo>",
  "test": {
    "environment": "node",
    "setupFiles": [
      "<repo>/tests/setup.ts"
    ],
    "include": [
      "tests/cpu-capacity.test.ts",
      "tests/worker-threads-setting.test.ts",
      "tests/config-command.test.ts",
      "tests/worker-pool-resilience.test.ts"
    ],
    "testNamePattern": "effective CPU capacity|worker threads setting|config command worker threads|global indexing CPU admission|file retry admission",
    "globalSetup": [],
    "maxWorkers": 1,
    "fileParallelism": false
  }
};
