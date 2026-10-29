import { describe, expect, it } from "vitest";
import { detectIntent } from "../src/lib/search/intent";

describe("detectIntent", () => {
  it("classifies 'where is' as DEFINITION", () => {
    const result = detectIntent("where is the auth handler");
    expect(result.type).toBe("DEFINITION");
    expect(result.filters?.definitionsOnly).toBeUndefined();
  });

  it("classifies 'what is' as DEFINITION", () => {
    expect(detectIntent("what is UserService").type).toBe("DEFINITION");
  });

  it("classifies 'define' as DEFINITION", () => {
    expect(detectIntent("define the schema type").type).toBe("DEFINITION");
  });

  it("classifies 'how does' as FLOW", () => {
    const result = detectIntent("how does authentication work");
    expect(result.type).toBe("FLOW");
    expect(result.mode).toBe("orchestration_first");
  });

  it("classifies 'how is' as FLOW", () => {
    expect(detectIntent("how is the database pooled").type).toBe("FLOW");
  });

  it("classifies 'implementation' as FLOW", () => {
    expect(detectIntent("implementation of rate limiting").type).toBe("FLOW");
  });

  it("classifies 'example' as USAGE", () => {
    const result = detectIntent("example of error handling");
    expect(result.type).toBe("USAGE");
    expect(result.mode).toBe("show_examples");
  });

  it("classifies 'how to use' as USAGE", () => {
    expect(detectIntent("how to use the cache").type).toBe("USAGE");
  });

  it("classifies 'architecture' as ARCHITECTURE", () => {
    const result = detectIntent("architecture of the pipeline");
    expect(result.type).toBe("ARCHITECTURE");
    expect(result.mode).toBe("group_by_role");
  });

  it("classifies 'system' as ARCHITECTURE", () => {
    expect(detectIntent("system overview").type).toBe("ARCHITECTURE");
  });

  it("classifies 'overview' as ARCHITECTURE", () => {
    expect(detectIntent("project overview").type).toBe("ARCHITECTURE");
  });

  it("returns GENERAL for unmatched queries", () => {
    expect(detectIntent("find the auth handler").type).toBe("GENERAL");
  });

  it("returns GENERAL for empty string", () => {
    expect(detectIntent("").type).toBe("GENERAL");
  });

  it("is case insensitive", () => {
    expect(detectIntent("WHERE IS the config").type).toBe("DEFINITION");
    expect(detectIntent("HOW DOES it work").type).toBe("FLOW");
  });
});
