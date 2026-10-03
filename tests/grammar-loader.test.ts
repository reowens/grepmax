import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: h.existsSync,
  mkdirSync: h.mkdirSync,
  writeFileSync: h.writeFileSync,
}));
vi.mock("../src/lib/core/languages", () => ({
  LANGUAGES: [
    { grammar: { name: "scala", url: "https://example.invalid/scala.wasm" } },
  ],
}));

import { ensureGrammars } from "../src/lib/index/grammar-loader";

beforeEach(() => {
  vi.useFakeTimers();
  h.existsSync.mockReset().mockReturnValue(false);
  h.mkdirSync.mockReset();
  h.writeFileSync.mockReset();
  h.fetch.mockReset();
  vi.stubGlobal("fetch", h.fetch);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("grammar downloads", () => {
  it("retries a transient HTTP failure and writes only a complete response", async () => {
    h.fetch
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(8),
      });
    const pending = ensureGrammars(() => {}, { silent: true, strict: true });
    await vi.advanceTimersByTimeAsync(500);
    await pending;
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(h.writeFileSync).toHaveBeenCalledOnce();
  });
  it("bounds retries and reports required missing grammars directly", async () => {
    h.fetch.mockResolvedValue({ ok: false, status: 404 });
    const pending = expect(
      ensureGrammars(() => {}, { silent: true, strict: true }),
    ).rejects.toThrow("Required grammars could not be downloaded: scala");
    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.writeFileSync).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      "  Error downloading scala:",
      expect.objectContaining({ message: expect.stringContaining("HTTP 404") }),
    );
  });
  it("keeps runtime fallback available after transport failures", async () => {
    h.fetch.mockRejectedValue(new Error("ECONNRESET"));
    const pending = ensureGrammars(() => {}, { silent: true });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(pending).resolves.toBeUndefined();
    expect(h.fetch).toHaveBeenCalledTimes(3);
    expect(h.writeFileSync).not.toHaveBeenCalled();
  });
  it("does not redownload cached grammars", async () => {
    h.existsSync.mockReturnValue(true);
    await ensureGrammars(() => {}, { silent: true, strict: true });
    expect(h.fetch).not.toHaveBeenCalled();
  });
});
