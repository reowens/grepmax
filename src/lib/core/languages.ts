export interface LanguageDefinition {
    id: string;
    extensions: string[];
    grammar?: {
        name: string;
        url: string;
    };
}

export const LANGUAGES: LanguageDefinition[] = [
    {
        id: "typescript",
        extensions: [".ts"],
        grammar: {
            name: "typescript",
            url: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-typescript.wasm",
        },
    },
    {
        id: "tsx",
        extensions: [".tsx"],
        grammar: {
            name: "tsx",
            url: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
        },
    },
    {
        id: "javascript",
        extensions: [".js", ".jsx", ".mjs", ".cjs"],
        grammar: {
            name: "tsx", // Use TSX grammar for JS/JSX to handle modern features
            url: "https://github.com/tree-sitter/tree-sitter-typescript/releases/download/v0.23.2/tree-sitter-tsx.wasm",
        },
    },
    {
        id: "python",
        extensions: [".py"],
        grammar: {
            name: "python",
            url: "https://github.com/tree-sitter/tree-sitter-python/releases/download/v0.25.0/tree-sitter-python.wasm",
        },
    },
    {
        id: "go",
        extensions: [".go"],
        grammar: {
            name: "go",
            url: "https://github.com/tree-sitter/tree-sitter-go/releases/download/v0.25.0/tree-sitter-go.wasm",
        },
    },
    {
        id: "rust",
        extensions: [".rs"],
        grammar: {
            name: "rust",
            url: "https://github.com/tree-sitter/tree-sitter-rust/releases/download/v0.23.2/tree-sitter-rust.wasm",
        },
    },
    {
        id: "cpp",
        extensions: [".cpp", ".hpp", ".cc", ".cxx"],
        grammar: {
            name: "cpp",
            url: "https://github.com/tree-sitter/tree-sitter-cpp/releases/download/v0.23.4/tree-sitter-cpp.wasm",
        },
    },
    {
        id: "c",
        extensions: [".c", ".h"],
        grammar: {
            name: "c",
            url: "https://github.com/tree-sitter/tree-sitter-c/releases/download/v0.23.4/tree-sitter-c.wasm",
        },
    },
    {
        id: "java",
        extensions: [".java"],
        grammar: {
            name: "java",
            url: "https://github.com/tree-sitter/tree-sitter-java/releases/download/v0.23.4/tree-sitter-java.wasm",
        },
    },
    {
        id: "c_sharp",
        extensions: [".cs"],
        grammar: {
            name: "c_sharp",
            url: "https://github.com/tree-sitter/tree-sitter-c-sharp/releases/download/v0.23.1/tree-sitter-c_sharp.wasm",
        },
    },
    {
        id: "ruby",
        extensions: [".rb"],
        grammar: {
            name: "ruby",
            url: "https://github.com/tree-sitter/tree-sitter-ruby/releases/download/v0.23.1/tree-sitter-ruby.wasm",
        },
    },
    {
        id: "php",
        extensions: [".php"],
        grammar: {
            name: "php",
            url: "https://github.com/tree-sitter/tree-sitter-php/releases/download/v0.23.11/tree-sitter-php.wasm",
        },
    },
    {
        id: "json",
        extensions: [".json"],
        grammar: {
            name: "json",
            url: "https://github.com/tree-sitter/tree-sitter-json/releases/download/v0.24.8/tree-sitter-json.wasm",
        },
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
    },
];

export function getLanguageByExtension(ext: string): LanguageDefinition | undefined {
    const normalized = ext.toLowerCase();
    return LANGUAGES.find((lang) => lang.extensions.includes(normalized));
}

export function getGrammarUrl(grammarName: string): string | undefined {
    const lang = LANGUAGES.find((l) => l.grammar?.name === grammarName);
    return lang?.grammar?.url;
}
