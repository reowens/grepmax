import { describe, expect, it } from "vitest";
import {
  finalizeAnswer,
  looksLikeRawToolCall,
  toolCallLeakHint,
} from "../src/lib/llm/investigate";

describe("looksLikeRawToolCall", () => {
  it("detects Qwen-XML tool-call markup", () => {
    expect(
      looksLikeRawToolCall(
        "<tool_call><function=peek><parameter=symbol>investigate</parameter></function></tool_call>",
      ),
    ).toBe(true);
  });

  it("detects a bare <function=...> call", () => {
    expect(looksLikeRawToolCall("<function=search>")).toBe(true);
  });

  it("detects a <parameter=...> block", () => {
    expect(looksLikeRawToolCall("<parameter=query>foo</parameter>")).toBe(true);
  });

  it("detects markup leaked inside a think block", () => {
    expect(
      looksLikeRawToolCall("<think>I should call <function=peek></think>"),
    ).toBe(true);
  });

  // Captured live from Qwen3.5-35B-A3B's round-cap forced-final answer (the
  // final synthesis call passes no `tools`, so a stray tool call leaks as text).
  it("detects the real multi-line forced-final leak", () => {
    const leak = [
      "<tool_call>",
      "<function=peek>",
      "<parameter=symbol>",
      "reapIdleWorkers",
      "</parameter>",
      "</function>",
      "</tool_call>",
    ].join("\n");
    expect(looksLikeRawToolCall(leak)).toBe(true);
  });

  it("does not fire on a normal prose answer mentioning functions", () => {
    expect(
      looksLikeRawToolCall(
        "The `investigate` function lives in investigate.ts:36 and calls executeTool().",
      ),
    ).toBe(false);
  });

  it("does not fire on empty text", () => {
    expect(looksLikeRawToolCall("")).toBe(false);
  });
});

describe("finalizeAnswer", () => {
  const model = "Qwen3.5-35B-A3B-Q4_K_M";

  it("returns the leak hint when content is raw tool-call markup", () => {
    const out = finalizeAnswer(
      "<tool_call><function=peek><parameter=symbol>x</parameter></function></tool_call>",
      model,
    );
    expect(out).toBe(toolCallLeakHint(model));
    expect(out).toContain(model);
    expect(out).not.toContain("<function=");
  });

  it("strips think tags from a clean answer", () => {
    expect(
      finalizeAnswer("<think>reasoning here</think>The answer is foo.", model),
    ).toBe("The answer is foo.");
  });

  it("returns (no response) for empty or nullish content", () => {
    expect(finalizeAnswer("", model)).toBe("(no response)");
    expect(finalizeAnswer(null, model)).toBe("(no response)");
    expect(finalizeAnswer(undefined, model)).toBe("(no response)");
  });

  it("returns (no response) when content is only a think block", () => {
    expect(finalizeAnswer("<think>just thinking</think>", model)).toBe(
      "(no response)",
    );
  });

  it("passes a normal answer through unchanged", () => {
    const answer = "Defined at investigate.ts:36; see tools.ts for the schema.";
    expect(finalizeAnswer(answer, model)).toBe(answer);
  });
});
