import { describe, expect, it } from "vitest";
import { TreeSitterChunker } from "../src/lib/index/chunker";

/**
 * Type-position reference edges across the non-TS/JS typed grammars. The TS/JS
 * + Python cases live in `graph-edges.type-position.test.ts`; this file proves
 * a type used ONLY in annotation position (`EmbedRequest` as a parameter type,
 * `EmbedResponse` as a return type — neither constructed) becomes a
 * `typeReferencedSymbols` edge and stays OUT of `referencedSymbols`, in every
 * statically-typed grammar.
 *
 * Two capture paths converge here (discovered 2026-06-22):
 *   - Go / Rust / Java / Kotlin / Scala / Swift spell type names as
 *     `type_identifier`, so Shape 4 already covers them — these cases are the
 *     regression net that keeps that incidental coverage honest.
 *   - C# (`identifier` / `generic_name`) and PHP (`name` inside `named_type`)
 *     have no `type_identifier`, so Shape 6 reads their annotation fields
 *     explicitly. These cases are the new coverage.
 *
 * Uses the real grammars (loaded from ~/.gmax/grammars), no embedding/DB.
 */

const REQ = "EmbedRequest"; // parameter annotation only
const RESP = "EmbedResponse"; // return annotation only

const CASES: Array<{ lang: string; file: string; code: string }> = [
  {
    lang: "go",
    file: "h.go",
    code: `package m
func Handle(req *EmbedRequest) EmbedResponse {
	return zero()
}
`,
  },
  {
    lang: "rust",
    file: "h.rs",
    code: `fn handle(req: EmbedRequest) -> EmbedResponse {
    zero()
}
`,
  },
  {
    lang: "java",
    file: "H.java",
    code: `class H {
  EmbedResponse handle(EmbedRequest req) {
    return zero();
  }
}
`,
  },
  {
    lang: "c_sharp",
    file: "H.cs",
    code: `class H {
  EmbedResponse Handle(EmbedRequest req) {
    return zero();
  }
}
`,
  },
  {
    lang: "kotlin",
    file: "h.kt",
    code: `fun handle(req: EmbedRequest): EmbedResponse {
    return zero()
}
`,
  },
  {
    lang: "scala",
    file: "h.scala",
    code: `def handle(req: EmbedRequest): EmbedResponse = zero()
`,
  },
  {
    lang: "swift",
    file: "h.swift",
    code: `func handle(req: EmbedRequest) -> EmbedResponse {
    return zero()
}
`,
  },
  {
    lang: "php",
    file: "h.php",
    code: `<?php
function handle(EmbedRequest $req): EmbedResponse {
    return zero();
}
`,
  },
];

// C# and PHP get bespoke Shape 6 handling, so also assert their class heritage
// (`: Base, IFace` / `extends Base implements IFace`) lands as type edges.
const HERITAGE_CASES: Array<{ lang: string; file: string; code: string }> = [
  {
    lang: "c_sharp",
    file: "W.cs",
    code: `class Widget : BaseWidget, IDrawable {
}
`,
  },
  {
    lang: "php",
    file: "w.php",
    code: `<?php
class Widget extends BaseWidget implements IDrawable {
}
`,
  },
];

async function symbols(
  file: string,
  code: string,
): Promise<{ type: Set<string>; ref: Set<string> }> {
  const chunker = new TreeSitterChunker();
  const { chunks } = await chunker.chunk(file, code);
  const type = new Set<string>();
  const ref = new Set<string>();
  for (const c of chunks) {
    for (const t of c.typeReferencedSymbols ?? []) type.add(t);
    for (const r of c.referencedSymbols ?? []) ref.add(r);
  }
  return { type, ref };
}

describe("type-position edges — multi-grammar", () => {
  for (const { lang, file, code } of CASES) {
    it(`${lang}: captures param + return annotations as type edges, not call edges`, async () => {
      const { type, ref } = await symbols(file, code);
      expect(type.has(REQ), `${lang} missing param-type edge ${REQ}`).toBe(true);
      expect(type.has(RESP), `${lang} missing return-type edge ${RESP}`).toBe(
        true,
      );
      // Invariant: annotation-only types never become call edges.
      expect(ref.has(REQ), `${lang} leaked ${REQ} into referenced_symbols`).toBe(
        false,
      );
      expect(
        ref.has(RESP),
        `${lang} leaked ${RESP} into referenced_symbols`,
      ).toBe(false);
    });
  }

  for (const { lang, file, code } of HERITAGE_CASES) {
    it(`${lang}: captures class heritage (extends/implements) as type edges`, async () => {
      const { type, ref } = await symbols(file, code);
      expect(type.has("BaseWidget"), `${lang} missing base BaseWidget`).toBe(
        true,
      );
      expect(type.has("IDrawable"), `${lang} missing interface IDrawable`).toBe(
        true,
      );
      expect(ref.has("BaseWidget")).toBe(false);
    });
  }
});
