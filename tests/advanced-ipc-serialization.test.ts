import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

function receiveAdvancedPayload(): Promise<Record<string, unknown>> {
  const script = `
    const backing = new Uint8Array([90, 91, 5, 200, 15, 92]);
    process.send({
      buffer: Buffer.from([1, 2, 3]),
      float32: new Float32Array([1.5, -2.25]),
      int8: new Int8Array([3, -4]),
      uint8: new Uint8Array([5, 200]),
      subarray: backing.subarray(2, 5),
    }, () => process.disconnect());
  `;
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "advanced",
  });

  return new Promise((resolve, reject) => {
    let received = false;
    child.once("error", reject);
    child.once("message", (message) => {
      received = true;
      resolve(message as Record<string, unknown>);
    });
    child.once("exit", (code, signal) => {
      if (!received) {
        reject(
          new Error(
            `IPC fixture exited before sending (code=${code}, signal=${signal})`,
          ),
        );
      }
    });
  });
}

describe("advanced child-process serialization", () => {
  it("preserves buffers, typed arrays, and subarray byte ranges", async () => {
    const payload = await receiveAdvancedPayload();

    expect(Buffer.isBuffer(payload.buffer)).toBe(true);
    expect(Array.from(payload.buffer as Buffer)).toEqual([1, 2, 3]);
    expect(payload.float32).toBeInstanceOf(Float32Array);
    expect(Array.from(payload.float32 as Float32Array)).toEqual([1.5, -2.25]);
    expect(payload.int8).toBeInstanceOf(Int8Array);
    expect(Array.from(payload.int8 as Int8Array)).toEqual([3, -4]);
    expect(payload.uint8).toBeInstanceOf(Uint8Array);
    expect(Array.from(payload.uint8 as Uint8Array)).toEqual([5, 200]);
    expect(payload.subarray).toBeInstanceOf(Uint8Array);
    expect(Array.from(payload.subarray as Uint8Array)).toEqual([5, 200, 15]);
  });
});
