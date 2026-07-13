// Shared ignore patterns for filesystem walks.
// Keep JSON files (package.json, tsconfig.json, etc.) but skip lockfiles and obvious binaries.
export const DEFAULT_IGNORE_PATTERNS = [
  "*.lock",
  "*.bin",
  "*.ipynb",
  "*.pyc",
  "*.onnx",
  // Non-code text files (gmax is for CODE search)
  "*.txt",
  "*.log",
  "*.csv",
  // Safety nets for nested non-git folders
  // Use bare names so the `ignore` library matches the directory itself
  // (prevents descending into it), not just files inside it.
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "__pycache__",
  "coverage",
  "venv",
  ".venv",
  "site-packages",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".nuxt",
  ".gradle",
  ".m2",
  "vendor",
  "lancedb",
  ".claude",
  ".gmax",
  ".gmax.json",
  // Minified/generated assets
  "*.min.js",
  "*.min.css",
  "*.map",
  "*.wasm",
  // Machine-generated source (floods the index + ranks codegen as god nodes).
  // Content-based @generated/DO-NOT-EDIT header sniff (file-utils.ts) catches the
  // rest; these are the unambiguous filename/dir conventions.
  "**/__generated__/**", // Relay / graphql-codegen
  "**/Generated/**", // Apollo iOS, Xcode codegen
  "*.graphql.swift", // Apollo iOS operations
  "*.pb.go", // protobuf (Go)
  "*.pb.cc",
  "*.pb.h", // protobuf (C++)
  "*_pb2.py",
  "*_pb2.pyi",
  "*_pb2_grpc.py", // protobuf (Python)
  "*.g.dart",
  "*.freezed.dart",
  "*.gr.dart", // Dart codegen
  "*.designer.cs", // C# designer
  "*.generated.ts",
  "*.generated.tsx", // graphql-codegen / common TS
  // graphql-codegen client-preset output dir (emits no @generated banner, so
  // the header sniff can't catch these — match the canonical filenames).
  "**/gql/graphql.ts",
  "**/gql/gql.ts",
  "**/gql/fragment-masking.ts",
  // Test fixtures and benchmark data
  "**/fixtures/**",
  "**/benchmark/**",
  "**/testdata/**",
  "**/__fixtures__/**",
  "**/__snapshots__/**",
  // Lockfiles across ecosystems
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "composer.lock",
  "Cargo.lock",
  "Gemfile.lock",
  // Security: Sensitive files that should never be indexed
  ".env",
  ".env.*",
  "*.key",
  "*.pem",
  "*.p12",
  "*.pfx",
  "*.p8",
  "**/.ssh/**",
  "id_rsa",
  "id_ed25519",
  "*.pub",
  "**/.gnupg/**",
  "*.gpg",
  "**/.aws/**",
  "**/.gcloud/**",
  "**/.azure/**",
  "secrets.*",
  "credentials.*",
  // IDE and OS files
  ".DS_Store",
  "**/*.tmp.*",
  "**/*.sb-*",
  "**/.idea/**",
  "**/.vscode/**",
  "Thumbs.db",
];
