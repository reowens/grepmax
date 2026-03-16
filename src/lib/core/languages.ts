export interface LanguageDefinition {
  id: string;
  extensions: string[];
  grammar?: {
    name: string;
    url: string;
  };
  definitionTypes?: string[];
}

export const LANGUAGES: LanguageDefinition[] = [
  {
    id: "typescript",
    extensions: [".ts"],
    grammar: {
      name: "typescript",
      url: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-typescript.wasm",
    },
    definitionTypes: [
      "function_declaration",
      "method_definition",
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "type_alias_declaration",
    ],
  },
  {
    id: "tsx",
    extensions: [".tsx"],
    grammar: {
      name: "tsx",
      url: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
    },
    definitionTypes: [
      "function_declaration",
      "method_definition",
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "type_alias_declaration",
    ],
  },
  {
    id: "javascript",
    extensions: [".js", ".jsx", ".mjs", ".cjs"],
    grammar: {
      name: "tsx", // Use TSX grammar for JS/JSX to handle modern features
      url: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
    },
    definitionTypes: [
      "function_declaration",
      "method_definition",
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "type_alias_declaration",
    ],
  },
  {
    id: "python",
    extensions: [".py"],
    grammar: {
      name: "python",
      url: "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.25.0/tree-sitter-python.wasm",
    },
    definitionTypes: ["function_definition", "class_definition"],
  },
  {
    id: "go",
    extensions: [".go"],
    grammar: {
      name: "go",
      url: "https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm",
    },
    definitionTypes: [
      "function_declaration",
      "method_declaration",
      "type_declaration",
    ],
  },
  {
    id: "rust",
    extensions: [".rs"],
    grammar: {
      name: "rust",
      url: "https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.23.2/tree-sitter-rust.wasm",
    },
    definitionTypes: [
      "function_item",
      "impl_item",
      "trait_item",
      "struct_item",
      "enum_item",
    ],
  },
  {
    id: "cpp",
    extensions: [".cpp", ".hpp", ".cc", ".cxx"],
    grammar: {
      name: "cpp",
      url: "https://github.com/tree-sitter/tree-sitter-cpp/releases/download/v0.23.4/tree-sitter-cpp.wasm",
    },
    definitionTypes: [
      "function_definition",
      "class_specifier",
      "struct_specifier",
      "enum_specifier",
      "namespace_definition",
    ],
  },
  {
    id: "c",
    extensions: [".c", ".h"],
    grammar: {
      name: "c",
      url: "https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.23.4/tree-sitter-c.wasm",
    },
    definitionTypes: [
      "function_definition",
      "struct_specifier",
      "enum_specifier",
    ],
  },
  {
    id: "java",
    extensions: [".java"],
    grammar: {
      name: "java",
      url: "https://github.com/tree-sitter/tree-sitter-java/releases/download/v0.23.4/tree-sitter-java.wasm",
    },
    definitionTypes: [
      "method_declaration",
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
    ],
  },
  {
    id: "c_sharp",
    extensions: [".cs"],
    grammar: {
      name: "c_sharp",
      url: "https://github.com/tree-sitter/tree-sitter-c-sharp/releases/download/v0.23.1/tree-sitter-c_sharp.wasm",
    },
    definitionTypes: [
      "method_declaration",
      "class_declaration",
      "interface_declaration",
      "enum_declaration",
      "struct_declaration",
      "namespace_declaration",
    ],
  },
  {
    id: "ruby",
    extensions: [".rb"],
    grammar: {
      name: "ruby",
      url: "https://github.com/tree-sitter/tree-sitter-ruby/releases/download/v0.23.1/tree-sitter-ruby.wasm",
    },
    definitionTypes: ["method", "class", "module"],
  },
  {
    id: "php",
    extensions: [".php"],
    grammar: {
      name: "php",
      url: "https://github.com/tree-sitter/tree-sitter-php/releases/download/v0.23.11/tree-sitter-php.wasm",
    },
    definitionTypes: [
      "function_definition",
      "method_declaration",
      "class_declaration",
      "interface_declaration",
    ],
  },
  {
    id: "swift",
    extensions: [".swift"],
    grammar: {
      name: "swift",
      url: "https://github.com/alex-pinkus/tree-sitter-swift/releases/download/0.7.1-pypi/tree-sitter-swift.wasm",
    },
    definitionTypes: [
      "function_declaration",
      "class_declaration", // covers class, struct, enum, actor
      "protocol_declaration",
    ],
  },
  {
    id: "kotlin",
    extensions: [".kt", ".kts"],
    grammar: {
      name: "kotlin",
      url: "https://github.com/fwcd/tree-sitter-kotlin/releases/download/0.3.8/tree-sitter-kotlin.wasm",
    },
    definitionTypes: [
      "function_declaration",
      "class_declaration", // covers class, interface, enum class
      "object_declaration", // object singletons, companion objects
    ],
  },
  {
    id: "scala",
    extensions: [".scala", ".sc"],
    grammar: {
      name: "scala",
      url: "https://github.com/tree-sitter/tree-sitter-scala/releases/download/v0.25.0/tree-sitter-scala.wasm",
    },
    definitionTypes: [
      "function_definition",
      "class_definition",
      "object_definition",
      "trait_definition",
    ],
  },
  {
    id: "lua",
    extensions: [".lua"],
    grammar: {
      name: "lua",
      url: "https://github.com/tree-sitter-grammars/tree-sitter-lua/releases/download/v0.5.0/tree-sitter-lua.wasm",
    },
    definitionTypes: ["function_declaration"],
  },
  {
    id: "json",
    extensions: [".json"],
    grammar: {
      name: "json",
      url: "https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm",
    },
    definitionTypes: ["pair"],
  },
  {
    id: "markdown",
    extensions: [".md", ".mdx"],
  },
  {
    id: "yaml",
    extensions: [".yml", ".yaml"],
  },
  {
    id: "css",
    extensions: [".css"],
  },
  {
    id: "html",
    extensions: [".html"],
  },
  {
    id: "bash",
    extensions: [".sh"],
    grammar: {
      name: "bash",
      url: "https://github.com/tree-sitter/tree-sitter-bash/releases/download/v0.25.1/tree-sitter-bash.wasm",
    },
    definitionTypes: ["function_definition"],
  },
];

export function getLanguageByExtension(
  ext: string,
): LanguageDefinition | undefined {
  const normalized = ext.toLowerCase();
  return LANGUAGES.find((lang) => lang.extensions.includes(normalized));
}

export function getGrammarUrl(grammarName: string): string | undefined {
  const lang = LANGUAGES.find((l) => l.grammar?.name === grammarName);
  return lang?.grammar?.url;
}
