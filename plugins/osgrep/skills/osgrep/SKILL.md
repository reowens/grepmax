---
name: osgrep
description: Semantic code search for AI agents. Finds code by concept, compresses files to skeletons, and traces call graphs. Saves 80-95% tokens vs reading full files.
allowed-tools: "Bash(osgrep:*), Read"
license: Apache-2.0
---

## Why Use osgrep?

**Problem:** Reading full files burns tokens. A 500-line file costs ~2000 tokens.
**Solution:** osgrep lets you understand code structure in ~100 tokens, then read only what you need.

| Without osgrep | With osgrep |
|----------------|-------------|
| Read 5 files (~10,000 tokens) | Skeleton 5 files (~500 tokens) |
| Guess which function matters | See ORCH roles highlight key logic |
| Miss related code | Trace shows dependencies |

## Core Commands

```bash
osgrep "where does authentication happen"     # Search by concept
osgrep skeleton src/services/auth.ts          # Get structure (~90% smaller)
osgrep trace AuthService                      # See callers/callees
osgrep symbols                                # List key symbols in codebase
```

## The Right Tool for Each Question

| Question Type | Command | Why |
|--------------|---------|-----|
| "Where is X?" | `osgrep "X"` | Semantic search finds concepts |
| "What's in this file?" | `osgrep skeleton file.ts` | See structure without reading everything |
| "Who calls X?" | `osgrep trace X` | Map dependencies |
| "What are the main classes?" | `osgrep symbols` | Get vocabulary of codebase |
| "Show me the implementation" | `Read file.ts:42-80` | After you know WHERE |

## Recommended Workflow

### For "Find something specific"
```bash
osgrep "JWT token validation and expiration"
# → src/auth/jwt.ts:45  validateToken  ORCH  H
Read src/auth/jwt.ts:45-90
```

### For "Understand how X works"
```bash
# 1. Find the entry point
osgrep "request handling middleware"

# 2. Get structure without reading everything
osgrep skeleton src/middleware/auth.ts

# 3. Trace what it calls
osgrep trace authMiddleware

# 4. Read ONLY the specific function you need
Read src/middleware/auth.ts:23-45
```

### For "Explore architecture"
```bash
# 1. Get the vocabulary
osgrep symbols

# 2. Skeleton the top-referenced classes
osgrep skeleton src/services/UserService.ts
osgrep skeleton src/db/Connection.ts

# 3. Trace key orchestrators
osgrep trace handleRequest

# 4. Now you understand the structure - read specifics as needed
```

## Query Tips

**Be specific.** Semantic search needs context.

```bash
# ❌ Too vague
osgrep "auth"

# ✅ Specific
osgrep "where does the code validate JWT tokens and check expiration"
```

**More words = better matches.** Think of it like asking a colleague.

## Understanding Output

### Search Results
```
path              lines    score  role  conf  defined
src/auth/jwt.ts   45-89    .94    ORCH  H     validateToken
```
- **ORCH** = Orchestration (complex, calls many things) - often what you want
- **DEF** = Definition (class, interface, type)
- **IMPL** = Implementation (simpler functions)
- **H/M/L** = Confidence level

### Skeleton Output
```typescript
// src/auth/jwt.ts (skeleton, ~85 tokens)
export class JWTService {
  constructor(private secret: string);
  
  validateToken(token: string): Claims {
    // → decode, verify, isExpired | C:8 | ORCH
  }
  
  sign(payload: object): string {
    // → encode, stringify | C:2
  }
}
```
- Shows signatures without implementation
- Summary shows: calls made, complexity, role
- 85 tokens vs ~800 for full file

## Command Reference

### `osgrep [query] [path]`
Semantic search. Default command.
- `-m N` - Max results (default: 10)
- `--compact` - TSV output

### `osgrep skeleton <target>`
Compress code to signatures + summaries.
- Target: file path, symbol name, or search query
- `--limit N` - Max files for query mode
- `--no-summary` - Omit body summaries

### `osgrep trace <symbol>`
Show call graph for a symbol.
- Who calls this? (callers)
- What does this call? (callees)

### `osgrep symbols [filter]`
List defined symbols sorted by reference count.
- No args: top 20 symbols
- With filter: matching symbols only

## ⚠️ Indexing State

If output shows "Indexing", "Building", or "Syncing":
1. **STOP** - Results will be incomplete
2. **INFORM** the user the index is building
3. **ASK** if they want to wait or proceed with partial results
