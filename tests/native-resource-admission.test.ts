import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VectorDB } from "../src/lib/store/vector-db";
import { resourceBudget } from "../src/lib/utils/resource-budget";

const h = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("../src/lib/store/lance-sdk", () => ({
  connect: h.connect,
  Session: class {},
  Index: {},
}));

describe("native connections hold one cross-client resource reservation", () => {
  const dirs: string[] = [];
  const dbs: VectorDB[] = [];
  const make = (readOnly = false) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-native-budget-"));
    dirs.push(dir);
    const db = new VectorDB(dir, 384, undefined, {
      readOnly,
      indexCacheMb: 32,
      metadataCacheMb: 16,
    });
    dbs.push(db);
    return db as any;
  };
  afterEach(async () => {
    for (const db of dbs.splice(0)) await db.close().catch(() => {});
    for (const dir of dirs.splice(0))
      fs.rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });
  it("refuses before opening native state when the shared budget denies", async () => {
    vi.mocked(resourceBudget.reserve).mockImplementationOnce(() => {
      throw Error("budget exceeded");
    });
    await expect(make().getDb()).rejects.toThrow("budget exceeded");
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("coalesces concurrent opens and retains the charge until native close settles", async () => {
    const release = vi.fn();
    vi.mocked(resourceBudget.reserve).mockReturnValueOnce({
      attach: vi.fn(),
      release,
    });
    let opened!: (value: any) => void;
    let closed!: () => void;
    const connection = {
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            closed = resolve;
          }),
      ),
    };
    h.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          opened = resolve;
        }),
    );
    const db = make();
    const a = db.getDb();
    const b = db.getDb();
    await vi.waitFor(() => expect(h.connect).toHaveBeenCalledOnce());
    expect(resourceBudget.reserve).toHaveBeenCalledExactlyOnceWith(
      48,
      "native-store",
    );
    opened(connection);
    expect(await a).toBe(await b);
    const close = db.close({ requireClosed: true });
    await vi.waitFor(() => expect(connection.close).toHaveBeenCalledOnce());
    expect(release).not.toHaveBeenCalled();
    closed();
    await close;
    expect(release).toHaveBeenCalledOnce();
  });
  it("keeps bounded retained-index reads available without heavy admission", async () => {
    h.connect.mockResolvedValueOnce({ close: vi.fn(async () => {}) });
    await make(true).getDb();
    expect(resourceBudget.reserve).not.toHaveBeenCalled();
  });
});
