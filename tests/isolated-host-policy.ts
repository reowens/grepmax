import { afterAll, vi } from "vitest";

// Native fixtures use temporary stores and their own safety receipt directory.
// A real operator stop is neither cleared nor used as test data.
vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-fixture-policy-"));
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    ...actual,
    PATHS: {
      ...actual.PATHS,
      sharedRoot: root,
      autostartDisabledFile: path.join(root, "autostart-disabled"),
    },
  };
});
