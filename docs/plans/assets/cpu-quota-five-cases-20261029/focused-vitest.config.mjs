import { fileURLToPath } from "node:url";

export default {
  "root": fileURLToPath(new URL("../../../../", import.meta.url)),
  "test": {
    "environment": "node",
    "setupFiles": [
      "./tests/setup.ts"
    ],
    "include": [
      "tests/cpu-capacity.test.ts",
      "tests/config-command.test.ts"
    ],
    "testNamePattern": "^(?:effective CPU capacity > handles root membership and rejects unsafe or non-unified membership|config command > worker threads > stores a valid count and says a daemon restart applies it|config command > worker threads > auto removes the stored value|config command > worker threads > rejects a count outside 1\\.\\.cores|config command > worker threads > shows the value and its source)$",
    "globalSetup": [],
    "maxWorkers": 1,
    "fileParallelism": false
  }
};
