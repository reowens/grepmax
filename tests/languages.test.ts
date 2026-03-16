import { describe, expect, it } from "vitest";
import {
  getGrammarUrl,
  getLanguageByExtension,
} from "../src/lib/core/languages";

describe("getLanguageByExtension", () => {
  it("returns typescript for .ts", () => {
    expect(getLanguageByExtension(".ts")?.id).toBe("typescript");
  });

  it("returns tsx for .tsx", () => {
    expect(getLanguageByExtension(".tsx")?.id).toBe("tsx");
  });

  it("returns javascript for .js", () => {
    expect(getLanguageByExtension(".js")?.id).toBe("javascript");
  });

  it("returns javascript for .jsx, .mjs, .cjs", () => {
    expect(getLanguageByExtension(".jsx")?.id).toBe("javascript");
    expect(getLanguageByExtension(".mjs")?.id).toBe("javascript");
    expect(getLanguageByExtension(".cjs")?.id).toBe("javascript");
  });

  it("returns python for .py", () => {
    expect(getLanguageByExtension(".py")?.id).toBe("python");
  });

  it("returns go for .go", () => {
    expect(getLanguageByExtension(".go")?.id).toBe("go");
  });

  it("returns rust for .rs", () => {
    expect(getLanguageByExtension(".rs")?.id).toBe("rust");
  });

  it("returns swift for .swift with grammar", () => {
    const lang = getLanguageByExtension(".swift");
    expect(lang?.id).toBe("swift");
    expect(lang?.grammar).toBeDefined();
  });

  it("returns kotlin for .kt and .kts", () => {
    expect(getLanguageByExtension(".kt")?.id).toBe("kotlin");
    expect(getLanguageByExtension(".kts")?.id).toBe("kotlin");
    const lang = getLanguageByExtension(".kt");
    expect(lang?.grammar).toBeDefined();
  });

  it("returns bash for .sh with grammar", () => {
    const lang = getLanguageByExtension(".sh");
    expect(lang?.id).toBe("bash");
    expect(lang?.grammar).toBeDefined();
  });

  it("returns scala for .scala and .sc", () => {
    expect(getLanguageByExtension(".scala")?.id).toBe("scala");
    expect(getLanguageByExtension(".sc")?.id).toBe("scala");
    const lang = getLanguageByExtension(".scala");
    expect(lang?.grammar).toBeDefined();
  });

  it("returns lua for .lua with grammar", () => {
    const lang = getLanguageByExtension(".lua");
    expect(lang?.id).toBe("lua");
    expect(lang?.grammar).toBeDefined();
  });

  it("returns undefined for unknown extension", () => {
    expect(getLanguageByExtension(".unknown")).toBeUndefined();
  });

  it("is case insensitive", () => {
    expect(getLanguageByExtension(".TS")?.id).toBe("typescript");
    expect(getLanguageByExtension(".PY")?.id).toBe("python");
  });

  it("returns language without grammar for .md", () => {
    const lang = getLanguageByExtension(".md");
    expect(lang?.id).toBe("markdown");
    expect(lang?.grammar).toBeUndefined();
  });

  it("returns language without grammar for .yaml", () => {
    const lang = getLanguageByExtension(".yaml");
    expect(lang?.id).toBe("yaml");
    expect(lang?.grammar).toBeUndefined();
  });
});

describe("getGrammarUrl", () => {
  it("returns URL for known grammar", () => {
    const url = getGrammarUrl("typescript");
    expect(url).toBeDefined();
    expect(url).toContain("tree-sitter-typescript");
  });

  it("returns undefined for unknown grammar", () => {
    expect(getGrammarUrl("nonexistent")).toBeUndefined();
  });

  it("returns URL for python grammar", () => {
    const url = getGrammarUrl("python");
    expect(url).toContain("tree-sitter-python");
  });

  it("returns URL for swift grammar", () => {
    const url = getGrammarUrl("swift");
    expect(url).toContain("tree-sitter-swift");
  });

  it("returns URL for kotlin grammar", () => {
    const url = getGrammarUrl("kotlin");
    expect(url).toContain("tree-sitter-kotlin");
  });

  it("returns URL for bash grammar", () => {
    const url = getGrammarUrl("bash");
    expect(url).toContain("tree-sitter-bash");
  });

  it("returns URL for scala grammar", () => {
    const url = getGrammarUrl("scala");
    expect(url).toContain("tree-sitter-scala");
  });

  it("returns URL for lua grammar", () => {
    const url = getGrammarUrl("lua");
    expect(url).toContain("tree-sitter-lua");
  });
});
