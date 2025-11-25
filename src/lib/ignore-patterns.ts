// Shared ignore patterns for filesystem walks.
// Keep JSON files (package.json, tsconfig.json, etc.) but skip lockfiles and obvious binaries.
export const DEFAULT_IGNORE_PATTERNS = [
  "*.lock",
  "*.bin",
  "*.ipynb",
  "*.pyc",
  "*.txt",
  "*.onnx",
  // Safety nets for nested non-git folders
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "__pycache__",
  "coverage",
  "venv",
  // Lockfiles across ecosystems
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "Gemfile.lock",
];
