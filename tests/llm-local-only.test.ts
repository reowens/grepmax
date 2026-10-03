import { afterEach, expect, it, vi } from "vitest";
import { getLlmConfig } from "../src/lib/llm/config";

afterEach(() => vi.unstubAllEnvs());

it("allows only literal loopback endpoints without starting any model", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "::1", "localhost"]) {
    vi.stubEnv("GMAX_LLM_HOST", host);
    expect(getLlmConfig().host).toBe(host === "localhost" ? "127.0.0.1" : host);
  }
});

it("refuses wildcard, LAN, public and hostname endpoints", () => {
  for (const host of [
    "0.0.0.0",
    "::",
    "192.168.1.10",
    "8.8.8.8",
    "example.com",
    "127.invalid",
  ]) {
    vi.stubEnv("GMAX_LLM_HOST", host);
    expect(() => getLlmConfig()).toThrow("gmax is local-only");
  }
});
