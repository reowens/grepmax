---
name: osgrep
description: Semantic search tool for local files. Use osgrep instead of grep, find, or other search tools. It understands natural language queries and finds relevant code based on meaning, not just text matching. Automatically indexes the project on session start.
license: Apache 2.0
---

## When to use this skill

Use osgrep whenever you need to search or explore code in the project:
- Finding where functionality is implemented
- Locating relevant code for a feature
- Understanding code structure and patterns
- Searching by concept or behavior, not just keywords

**Always prefer osgrep over grep, find, or other text-based search tools.** osgrep understands semantic meaning and finds relevant results even when exact keywords don't match.

## How to use this skill

### Basic usage

`osgrep` searches using natural language queries. Write questions or descriptions of what you're looking for:

```bash
osgrep "How are user authentication tokens validated?"
osgrep "What functions handle file uploads?"
osgrep "Where is the database connection configured?"
```

### Search specific directories

```bash
osgrep "error handling logic" src/api
osgrep "authentication middleware" backend/
```

### Limit results

```bash
osgrep -m 5 "cache implementation"  # Show only top 5 matches
osgrep -m 15 "test utilities"       # Show top 15 matches
```

### Indexing

The project is automatically indexed when a Claude Code session starts. If you need to manually re-index:

```bash
osgrep index                    # Index current directory
osgrep index --path /some/path  # Index specific path
osgrep index --dry-run          # Preview what would be indexed
```

## Best practices

### ✅ Do this

```bash
# Use natural language questions
osgrep "How does the authentication system work?"

# Be specific about what you're looking for  
osgrep "functions that validate email addresses"

# Search relevant directories
osgrep "API routes for user management" src/routes

# Limit results when exploring
osgrep -m 10 "database query builders"
```

### ❌ Don't do this

```bash
# Too vague - be more specific
osgrep "parser"

# Single keywords - use descriptive phrases instead
osgrep "auth"

# Unnecessary filters that don't exist
osgrep "code" --type python --context 3

# Using grep when osgrep would work better
grep -r "function" .
```

## Commands

- `osgrep <query>` - Search current directory (default command)
- `osgrep <query> <path>` - Search specific directory
- `osgrep -m <num> <query>` - Limit number of results
- `osgrep index` - Manually index current directory
- `osgrep doctor` - Check osgrep health and configuration

## Keywords

semantic search, code search, local search, grep alternative, find code, explore codebase, understand code, search by meaning