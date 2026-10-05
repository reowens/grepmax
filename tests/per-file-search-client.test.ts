import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/utils/daemon-client", () => ({
  sendDaemonCommand: vi.fn(),
}));

import { parseCliPerFile } from "../src/lib/search/per-file";
import { sendDaemonCommand } from "../src/lib/utils/daemon-client";
import { sendSearchCommand } from "../src/lib/utils/daemon-search";

const send = vi.mocked(sendDaemonCommand);
beforeEach(() => send.mockReset());
describe("request-scoped per-file protocol", () => {
  it("does not add a handshake to ordinary search", async () => {
    send.mockResolvedValue({ ok: true, data: [] });
    const command = { cmd: "search", query: "handler" };
    await sendSearchCommand(command);
    expect(send).toHaveBeenCalledExactlyOnceWith(command, undefined);
  });
  it("checks capability and preserves request cancellation and timeout", async () => {
    send
      .mockResolvedValueOnce({ ok: true, capabilities: { perFileSearch: 1 } })
      .mockResolvedValueOnce({ ok: true, data: [] });
    const command = { cmd: "search-v2", maxPerFile: 6 };
    const options = { signal: new AbortController().signal, timeoutMs: 100 };
    await sendSearchCommand(command, options);
    expect(send.mock.calls).toEqual([
      [{ cmd: "ping" }, options],
      [command, options],
    ]);
  });
  it("refuses old live daemons without issuing the search", async () => {
    send.mockResolvedValue({ ok: true, capabilities: { readVerbs: 1 } });
    expect(
      await sendSearchCommand({ cmd: "search", maxPerFile: 6 }),
    ).toMatchObject({
      ok: false,
      error: "unsupported per-file retrieval control",
      hint: expect.stringContaining("restart"),
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("preserves unavailable-daemon errors for existing fallback policy", async () => {
    send.mockResolvedValue({ ok: false, error: "ENOENT" });
    expect(await sendSearchCommand({ cmd: "search", maxPerFile: 6 })).toEqual({
      ok: false,
      error: "ENOENT",
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    "0",
    "-1",
    "1.5",
    "6junk",
    "1e2",
    "",
    " ",
    "Infinity",
    "9007199254740992",
  ])("rejects CLI input %s", (input) => {
    expect(() => parseCliPerFile(input)).toThrow("--per-file");
  });
  it("keeps omitted and explicit values distinct", () => {
    expect(parseCliPerFile(undefined)).toBeUndefined();
    expect(parseCliPerFile("3")).toBe(3);
    expect(parseCliPerFile("6")).toBe(6);
  });
});
