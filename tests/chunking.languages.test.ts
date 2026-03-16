import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { TreeSitterChunker } from "../src/lib/index/chunker";

const GRAMMARS_DIR = path.join(os.homedir(), ".gmax", "grammars");
const hasSwiftGrammar = fs.existsSync(
  path.join(GRAMMARS_DIR, "tree-sitter-swift.wasm"),
);
const hasKotlinGrammar = fs.existsSync(
  path.join(GRAMMARS_DIR, "tree-sitter-kotlin.wasm"),
);
const hasBashGrammar = fs.existsSync(
  path.join(GRAMMARS_DIR, "tree-sitter-bash.wasm"),
);
const hasScalaGrammar = fs.existsSync(
  path.join(GRAMMARS_DIR, "tree-sitter-scala.wasm"),
);
const hasLuaGrammar = fs.existsSync(
  path.join(GRAMMARS_DIR, "tree-sitter-lua.wasm"),
);

const SWIFT_CODE = `import Foundation

protocol Greetable {
    func greet() -> String
}

class Person: Greetable {
    let name: String

    func greet() -> String {
        return "Hello, \\(name)!"
    }
}

func createPerson(_ name: String) -> Person {
    return Person(name: name)
}
`;

const BASH_CODE = `#!/bin/bash

function greet() {
    echo "Hello, $1"
}

function farewell() {
    echo "Goodbye, $1"
}
`;

const SCALA_CODE_SNIPPET = `object Main {
  def greet(name: String): String = {
    s"Hello, $name"
  }

  class Person(val name: String) {
    def hello(): String = {
      greet(name)
    }
  }
}
`;

const LUA_CODE = `function greet(name)
    print("Hello, " .. name)
end

function farewell(name)
    print("Goodbye, " .. name)
    greet(name)
end
`;

const KOTLIN_CODE = `import kotlin.math.sqrt

interface Shape {
    fun area(): Double
}

class Circle(val radius: Double) : Shape {
    override fun area(): Double {
        return Math.PI * radius * radius
    }
}

object GeometryUtils {
    fun distance(x1: Double, y1: Double, x2: Double, y2: Double): Double {
        return sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1))
    }
}
`;

describe.skipIf(!hasSwiftGrammar)("Swift chunking", () => {
  it("extracts function and class definitions", async () => {
    const chunker = new TreeSitterChunker();
    const { chunks } = await chunker.chunk("example.swift", SWIFT_CODE);

    const defined = chunks.flatMap((c) => c.definedSymbols ?? []);
    expect(defined).toContain("Person");
    expect(defined).toContain("greet");
    expect(defined).toContain("createPerson");

    // Protocol detected
    expect(defined).toContain("Greetable");

    // Semantic chunks, not just fallback blocks
    const types = chunks.map((c) => c.type);
    expect(types).toContain("class");
    expect(types).toContain("function");
  });

  it("extracts referenced symbols from call expressions", async () => {
    const chunker = new TreeSitterChunker();
    const { chunks } = await chunker.chunk("example.swift", SWIFT_CODE);

    const createPersonChunk = chunks.find((c) =>
      c.definedSymbols?.includes("createPerson"),
    );
    expect(createPersonChunk).toBeDefined();
    expect(createPersonChunk?.referencedSymbols).toContain("Person");
  });

  it("captures imports", async () => {
    const chunker = new TreeSitterChunker();
    const { metadata } = await chunker.chunk("example.swift", SWIFT_CODE);

    expect(metadata.imports).toEqual(
      expect.arrayContaining([expect.stringContaining("Foundation")]),
    );
  });
});

describe.skipIf(!hasKotlinGrammar)("Kotlin chunking", () => {
  it("extracts function and class definitions", async () => {
    const chunker = new TreeSitterChunker();
    const { chunks } = await chunker.chunk("Example.kt", KOTLIN_CODE);

    const defined = chunks.flatMap((c) => c.definedSymbols ?? []);
    expect(defined).toContain("Circle");
    expect(defined).toContain("area");
    expect(defined).toContain("distance");
    expect(defined).toContain("GeometryUtils");

    const types = chunks.map((c) => c.type);
    expect(types).toContain("class");
    expect(types).toContain("function");
  });

  it("extracts referenced symbols from call expressions", async () => {
    const chunker = new TreeSitterChunker();
    const { chunks } = await chunker.chunk("Example.kt", KOTLIN_CODE);

    const distanceChunk = chunks.find((c) =>
      c.definedSymbols?.includes("distance"),
    );
    expect(distanceChunk).toBeDefined();
    expect(distanceChunk?.referencedSymbols).toContain("sqrt");
  });

  it("captures imports", async () => {
    const chunker = new TreeSitterChunker();
    const { metadata } = await chunker.chunk("Example.kt", KOTLIN_CODE);

    expect(metadata.imports).toEqual(
      expect.arrayContaining([expect.stringContaining("kotlin.math.sqrt")]),
    );
  });
});

describe.skipIf(!hasBashGrammar)("Bash chunking", () => {
  it("extracts function definitions", async () => {
    const chunker = new TreeSitterChunker();
    const { chunks } = await chunker.chunk("script.sh", BASH_CODE);

    const defined = chunks.flatMap((c) => c.definedSymbols ?? []);
    expect(defined).toContain("greet");
    expect(defined).toContain("farewell");

    const types = chunks.map((c) => c.type);
    expect(types).toContain("function");
  });
});

describe.skipIf(!hasScalaGrammar)("Scala chunking", () => {
  it("extracts function, class, and object definitions", async () => {
    const chunker = new TreeSitterChunker();
    const { chunks } = await chunker.chunk("Main.scala", SCALA_CODE_SNIPPET);

    const defined = chunks.flatMap((c) => c.definedSymbols ?? []);
    expect(defined).toContain("Main");
    expect(defined).toContain("greet");
    expect(defined).toContain("Person");

    const types = chunks.map((c) => c.type);
    expect(types).toContain("function");
  });
});

describe.skipIf(!hasLuaGrammar)("Lua chunking", () => {
  it("extracts function definitions", async () => {
    const chunker = new TreeSitterChunker();
    const { chunks } = await chunker.chunk("init.lua", LUA_CODE);

    const defined = chunks.flatMap((c) => c.definedSymbols ?? []);
    expect(defined).toContain("greet");
    expect(defined).toContain("farewell");

    const types = chunks.map((c) => c.type);
    expect(types).toContain("function");
  });

  it("extracts referenced symbols from call expressions", async () => {
    const chunker = new TreeSitterChunker();
    const { chunks } = await chunker.chunk("init.lua", LUA_CODE);

    const farewellChunk = chunks.find((c) =>
      c.definedSymbols?.includes("farewell"),
    );
    expect(farewellChunk).toBeDefined();
    expect(farewellChunk?.referencedSymbols).toContain("greet");
  });
});
