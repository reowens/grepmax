import { describe, expect, it } from "vitest";
import { extractImportsFromContent } from "../src/lib/utils/import-extractor";

describe("extractImportsFromContent", () => {
  it("extracts JS/TS import statements", () => {
    const content = `import { foo } from "./foo";
import * as bar from "bar";

export function main() {}`;
    const result = extractImportsFromContent(content);
    expect(result).toContain('import { foo } from "./foo"');
    expect(result).toContain('import * as bar from "bar"');
    expect(result).not.toContain("export");
  });

  it("extracts require statements", () => {
    const content = `const fs = require("node:fs");
const path = require("node:path");

module.exports = {};`;
    const result = extractImportsFromContent(content);
    expect(result).toContain('const fs = require("node:fs")');
    expect(result).toContain('const path = require("node:path")');
  });

  it("extracts Python imports", () => {
    const content = `import os
from pathlib import Path

def main():
    pass`;
    const result = extractImportsFromContent(content);
    expect(result).toContain("import os");
    expect(result).toContain("from pathlib import Path");
    expect(result).not.toContain("def main");
  });

  it("handles multi-line Go imports", () => {
    const content = `package main

import (
  "fmt"
  "os"
)

func main() {}`;
    const result = extractImportsFromContent(content);
    expect(result).toContain("package main");
    expect(result).toContain("import (");
    expect(result).toContain('"fmt"');
    expect(result).toContain(")");
  });

  it("skips comments at top of file", () => {
    const content = `// This is a comment
// Another comment
import { foo } from "./foo";

export function bar() {}`;
    const result = extractImportsFromContent(content);
    expect(result).toContain('import { foo } from "./foo"');
    expect(result).not.toContain("comment");
  });

  it("returns empty string when no imports", () => {
    const content = `export function main() {
  console.log("hello");
}`;
    expect(extractImportsFromContent(content)).toBe("");
  });

  it("returns empty string for empty content", () => {
    expect(extractImportsFromContent("")).toBe("");
  });

  it("extracts Rust use statements", () => {
    const content = `use std::io;
use crate::config;

fn main() {}`;
    const result = extractImportsFromContent(content);
    expect(result).toContain("use std::io");
    expect(result).toContain("use crate::config");
  });
});
