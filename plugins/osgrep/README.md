# osgrep Claude Code Plugin

Semantic code search plugin for Claude Code. This plugin automatically indexes your project and provides Claude with intelligent search capabilities.

## Features

- **Automatic Indexing**: Indexes your project when Claude Code session starts
- **Semantic Search**: Understands natural language queries, finds code by meaning
- **Better than grep**: Finds relevant code even when exact keywords don't match
- **Skill Integration**: Claude automatically uses osgrep for code search tasks

## How It Works

### On Session Start

When you open a project in Claude Code, this plugin automatically runs `osgrep index` in the background to build a semantic index of your codebase.

### During Development

Claude will automatically use the osgrep skill when searching for code, exploring functionality, or understanding your codebase. You can also use osgrep commands directly in your terminal.

## Usage Examples

Claude can now use these semantic search queries:

```bash
osgrep "How does authentication work?"
osgrep "Functions that handle file uploads"
osgrep "Where is the database connection configured?"
osgrep -m 10 "error handling patterns"
```

## Manual Commands

- `osgrep <query>` - Search with natural language
- `osgrep <query> <path>` - Search in specific directory
- `osgrep -m <num> <query>` - Limit number of results
- `osgrep index` - Manually re-index project
- `osgrep doctor` - Check osgrep configuration

## Installation

This plugin is included with the osgrep package. Install with:

```bash
npm install -g @ryandonofrio/osgrep
osgrep install-claude-code
```

## Requirements

- Claude Code
- osgrep CLI tool installed globally

## Plugin Structure

```
osgrep/
├── .claude-plugin/
│   └── plugin.json           # Plugin metadata
├── hooks/
│   ├── hook.json             # Hook configuration
│   └── osgrep_index.sh       # Indexing script
├── skills/
│   └── osgrep/
│       └── SKILL.md          # Claude skill definition
└── README.md
```

## Hooks

### SessionStart Hook

Runs `osgrep index` when Claude Code session starts to ensure your project is indexed and searchable.

## License

Apache-2.0

