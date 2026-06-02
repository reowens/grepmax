import { describe, expect, it } from "vitest";
import { TreeSitterChunker } from "../src/lib/index/chunker";

/**
 * Phase 1 keystone — identifier-as-value reference extraction across the
 * non-TS/JS grammars. The TS/JS half lives in
 * `graph-edges.identifier-as-value.test.ts`; this file proves the same three
 * shapes (instantiation, type-test, member/scope access) yield
 * `referenced_symbols` edges in Python, Go, Rust, Java, C#, Ruby, Kotlin,
 * Swift, Scala, and PHP. Each case references a class (`new`/`instanceof`/`is`)
 * and an enum (member or scope access); both must appear as edges so the
 * graph-walk consumers (`trace --inbound`, `gmax dead`, audit) can reach them.
 *
 * Uses the real grammars (loaded from ~/.gmax/grammars), no embedding/DB.
 */

const CLASS = "BeyondError";
const ENUM = "ErrorCodes";

const CASES: Array<{ lang: string; file: string; code: string }> = [
  {
    lang: "python",
    file: "h.py",
    code: `def handle(x):
    if isinstance(x, BeyondError):
        raise BeyondError(ErrorCodes.VALIDATION, "bad")
    return ErrorCodes.NOT_FOUND
`,
  },
  {
    lang: "go",
    file: "h.go",
    code: `package m
func Handle(x interface{}) error {
    e := &BeyondError{Code: 1}
    _ = pkg.Helper()
    return ErrorCodes.NotFound
}
`,
  },
  {
    lang: "rust",
    file: "h.rs",
    code: `fn handle(x: Input) -> Result<(), Box<dyn std::error::Error>> {
    let e = BeyondError::new(ErrorCodes::Validation);
    Err(e)
}
`,
  },
  {
    lang: "java",
    file: "H.java",
    code: `class H {
  Object handle(Object x) {
    if (x instanceof BeyondError) {
      throw new BeyondError(ErrorCodes.VALIDATION);
    }
    return ErrorCodes.NOT_FOUND;
  }
}
`,
  },
  {
    lang: "c_sharp",
    file: "H.cs",
    code: `class H {
  object Handle(object x) {
    if (x is BeyondError) {
      throw new BeyondError(ErrorCodes.VALIDATION);
    }
    return ErrorCodes.NOT_FOUND;
  }
}
`,
  },
  {
    lang: "ruby",
    file: "h.rb",
    code: `def handle(x)
  e = BeyondError.new(ErrorCodes::VALIDATION)
  ErrorCodes::NOT_FOUND
end
`,
  },
  {
    lang: "kotlin",
    file: "h.kt",
    code: `fun handle(x: Any): Any {
    val e = BeyondError(1)
    if (x is BeyondError) throw e
    return ErrorCodes.NOT_FOUND
}
`,
  },
  {
    lang: "swift",
    file: "h.swift",
    code: `func handle(x: Any) -> Any {
    let e = BeyondError(code: 1)
    if x is BeyondError { return e }
    return ErrorCodes.notFound
}
`,
  },
  {
    lang: "scala",
    file: "h.scala",
    code: `def handle(x: Any): Any = {
  val e = new BeyondError(ErrorCodes.Validation)
  ErrorCodes.NotFound
}
`,
  },
  {
    lang: "php",
    file: "h.php",
    code: `<?php
function handle($x) {
  if ($x instanceof BeyondError) {
    throw new BeyondError(ErrorCodes::VALIDATION);
  }
  return ErrorCodes::NOT_FOUND;
}
`,
  },
];

async function allRefs(file: string, code: string): Promise<Set<string>> {
  const chunker = new TreeSitterChunker();
  const { chunks } = await chunker.chunk(file, code);
  const refs = new Set<string>();
  for (const c of chunks) for (const r of c.referencedSymbols ?? []) refs.add(r);
  return refs;
}

describe("identifier-as-value edges — multi-grammar", () => {
  for (const { lang, file, code } of CASES) {
    it(`${lang}: captures class (new/instanceof/is) and enum (member/scope) refs`, async () => {
      const refs = await allRefs(file, code);
      expect(refs.has(CLASS), `${lang} missing class ref ${CLASS}`).toBe(true);
      expect(refs.has(ENUM), `${lang} missing enum ref ${ENUM}`).toBe(true);
    });
  }

  it("does not flood lowercase-local member access (this/req/self)", async () => {
    // The Capitalized-head gate must keep ordinary local/property access out.
    const refs = await allRefs(
      "noise.ts",
      `export function f(req: any) {
        const a = this.state;
        const b = req.body.value;
        return a + b;
      }
`,
    );
    expect(refs.has("state")).toBe(false);
    expect(refs.has("body")).toBe(false);
    expect(refs.has("req")).toBe(false);
  });
});
