import { describe, expect, it } from "vitest";
import {
  gpuEmbedModelStatus,
  onnxModelStatus,
  summarizerServerStatus,
  summaryCoverageStatus,
} from "../src/lib/utils/doctor-status";

describe("summaryCoverageStatus", () => {
  it("reports INFO (opt-in) when nothing is summarized — not FAIL", () => {
    const s = summaryCoverageStatus(0, 265960);
    expect(s.symbol).toBe("INFO");
    expect(s.message).toContain("never enabled");
    expect(s.message).toContain("opt-in");
  });

  it("stays a WARN for a partial/stalled backfill below 90%", () => {
    const s = summaryCoverageStatus(50, 100);
    expect(s.symbol).toBe("WARN");
    expect(s.message).toBe("Summary coverage: 50/100 (50%)");
  });

  it("WARNs (not 'never enabled') when a few summaries round down to 0%", () => {
    // 1/265960 rounds to 0% but the summarizer HAS run — a stalled backfill,
    // which is a real warning, not an unexercised opt-in.
    const s = summaryCoverageStatus(1, 265960);
    expect(s.symbol).toBe("WARN");
    expect(s.message).not.toContain("never enabled");
  });

  it("is ok at >=90% coverage", () => {
    expect(summaryCoverageStatus(90, 100).symbol).toBe("ok");
    expect(summaryCoverageStatus(100, 100).symbol).toBe("ok");
  });
});

describe("summarizerServerStatus", () => {
  it("demotes a stopped summarizer to INFO (opt-in, respawns on demand)", () => {
    const s = summarizerServerStatus(false);
    expect(s.symbol).toBe("INFO");
    expect(s.message).toContain("opt-in");
  });

  it("is ok when running", () => {
    expect(summarizerServerStatus(true).symbol).toBe("ok");
  });
});

describe("gpuEmbedModelStatus", () => {
  const id = "ibm-granite/granite-embedding-small-english-r2";

  it("reports ok/serving when the MLX server is up — regardless of cache", () => {
    const s = gpuEmbedModelStatus(id, { up: true }, false);
    expect(s.symbol).toBe("ok");
    expect(s.message).toContain("serving via MLX");
  });

  it("reports ok/cached when the server is down but the HF snapshot exists", () => {
    const s = gpuEmbedModelStatus(id, { up: false }, true);
    expect(s.symbol).toBe("ok");
    expect(s.message).toContain("cached");
  });

  it("reports INFO/will-download when down and not cached — never WARN", () => {
    const s = gpuEmbedModelStatus(id, { up: false }, false);
    expect(s.symbol).toBe("INFO");
    expect(s.message).toContain("download");
  });
});

describe("onnxModelStatus", () => {
  it("WARNs about an absent ONNX model (cpu-mode embed / ColBERT)", () => {
    const s = onnxModelStatus("some/model", false);
    expect(s.symbol).toBe("WARN");
    expect(s.message).toContain("will download");
  });

  it("is ok when the ONNX model dir exists", () => {
    const s = onnxModelStatus("some/model", true);
    expect(s.symbol).toBe("ok");
    expect(s.message).toContain("downloaded");
  });
});
