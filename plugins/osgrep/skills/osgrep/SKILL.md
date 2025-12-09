---
name: osgrep
description: Semantic code search. Finds code by concept, compresses files to skeletons. Use instead of grep/ripgrep/reading whole files.
allowed-tools: "Bash(osgrep:*), Read"
---

## When to Use osgrep

**USE osgrep for:**
- "Explain the architecture" 
- "How does X work?"
- "Find where Y happens"
- "What are the main components?"

**DON'T use for:**
- You already know the exact file and line
- Simple string search in one file

## Commands

```bash
osgrep "how requests flow from client to server"   # Semantic search
osgrep "auth" --skeleton                           # Search + compress results
osgrep skeleton src/server.ts                      # Compress specific file  
osgrep trace handleRequest                         # Who calls / what calls
osgrep symbols                                     # List main symbols
```

## Workflow: Architecture Questions

**Query:** "Explain client-server architecture, identify key files, show request flow"

```bash
# 1. Find entry points
osgrep "where do client requests enter the server"

# 2. Get structure of key files (80-95% smaller than reading)
osgrep skeleton src/server/handler.ts
osgrep skeleton src/client/api.ts

# 3. Trace the flow
osgrep trace handleRequest

# 4. Read specific code ONLY if needed
Read src/server/handler.ts:45-60
```

## Workflow: Find Specific Code

**Query:** "Where is JWT validation?"

```bash
osgrep "JWT token validation and expiration checking"
# → src/auth/jwt.ts:45  validateToken  ORCH

Read src/auth/jwt.ts:45-80
```

## Output Guide

### Search Results (--compact)
```
path                lines   score  role  defined
src/auth/jwt.ts     45-89   .94    ORCH  validateToken
```
- **ORCH** = orchestrates other code (usually what you want)
- **DEF** = definition (class, type)

### Skeleton Output
```typescript
// src/auth/jwt.ts (skeleton, ~85 tokens)
export class JWTService {
  validateToken(token: string): Claims {
    // -> decode, verify, isExpired | C:8 | ORCH
  }
}
```
- Shows signatures, hides bodies
- Summary: what it calls, complexity, role
- **~85 tokens vs ~800 for full file**

## Query Tips

```bash
# Bad - too vague
osgrep "auth"

# Good - specific intent  
osgrep "where does the server validate JWT tokens before processing requests"
```

**More words = better results.** Describe what you're looking for like you'd ask a colleague.

## If Index is Building

If you see "Indexing" or "Syncing": STOP. Tell the user the index is building. Ask if they want to wait or proceed with partial results.
