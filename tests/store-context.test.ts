import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import {
  currentStoreContext,
  storeInventory,
  withStoreContext,
} from "../src/lib/utils/store-context";

it("isolates concurrent store contexts and inventories without opening indexes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmax-context-"));
  const oldHome = process.env.HOME;
  const oldGmaxHome = process.env.GMAX_HOME;
  try {
    process.env.HOME = dir;
    const stores = ["a", "b"].map((name) => ({
      prefix: path.join(dir, name),
      home: path.join(dir, `store-${name}`),
    }));
    fs.mkdirSync(path.join(dir, ".gmax"));
    fs.writeFileSync(
      path.join(dir, ".gmax", "stores.json"),
      JSON.stringify({ stores }),
    );
    for (const store of stores) {
      fs.mkdirSync(store.home);
      fs.writeFileSync(path.join(store.home, "projects.json"), "[]");
      fs.writeFileSync(
        path.join(store.home, "config.json"),
        JSON.stringify({
          modelTier: "small",
          vectorDim: 384,
          embedMode: "cpu",
        }),
      );
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await Promise.all(
      stores.map((store, i) =>
        withStoreContext(store.prefix, async (context) => {
          if (i === 1) release();
          await gate;
          expect(currentStoreContext()).toBe(context);
          expect(context.home).toBe(store.home);
          expect(context.secondary).toBe(true);
          expect(fs.existsSync(context.lancedbDir)).toBe(false);
        }),
      ),
    );
    expect(currentStoreContext()).toBeUndefined();
    expect(process.env.GMAX_HOME).toBe(oldGmaxHome);
    const offline = {
      prefix: `/Volumes/gmax-absent-${process.pid}/repos`,
      home: `/Volumes/gmax-absent-${process.pid}/store`,
    };
    const inventory = storeInventory([...stores, offline]);
    expect(inventory.map((item) => item.state)).toEqual([
      "mounted",
      "mounted",
      "offline",
    ]);
    fs.writeFileSync(
      path.join(dir, ".gmax", "stores.json"),
      JSON.stringify({ stores: [...stores, offline] }),
    );
    expect(() => withStoreContext(offline.prefix, async () => {})).toThrow(
      "not mounted",
    );
    expect(fs.existsSync(offline.home)).toBe(false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
