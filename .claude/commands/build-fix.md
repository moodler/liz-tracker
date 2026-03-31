# Build and Fix

Incrementally fix build and type errors with minimal, safe changes.

## Step 1: Run Build

```bash
npm run build
```

## Step 2: Parse and Group Errors

Group TypeScript errors by file, then by type (missing import, type mismatch, missing property, etc.).

## Step 3: Fix Loop (One Error at a Time)

For each error:
1. Read the file around the error line
2. Diagnose the root cause (don't guess — understand the types)
3. Apply the minimal fix (prefer fixing the type over adding `as any`)
4. Re-run `npm run build` to verify the fix didn't introduce new errors
5. Move to next error

## Step 4: Guardrails

Stop and ask the user if:
- A fix requires changing a public API signature
- More than 5 files need changes
- The fix involves security-critical files (db.ts, api.ts, orchestrator.ts, mcp-server.ts)
- You're unsure about the intended type

## Step 5: Summary

Report:
- Number of errors fixed
- Files modified
- Any remaining errors that need human judgment

## Recovery Strategies

| Situation | Action |
|-----------|--------|
| Circular dependency | Identify the cycle, suggest interface extraction |
| Missing module | Check if it needs `npm install` or a path fix |
| Generic constraint error | Read the generic definition before fixing |
| Union type narrowing | Add type guards, not assertions |
