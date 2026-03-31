# Verification Command

Run comprehensive verification on the tracker codebase.

## Instructions

Run each check in order. Stop and report on first failure.

1. **TypeScript Build**
   ```
   npm run build
   ```
   If errors found, list them with file:line format.

2. **Tests**
   ```
   npm test
   ```
   If failures, show failing test names and assertion errors.

3. **Console.log Audit**
   Search for `console.log` in `src/**/*.ts` (excluding test files and logger.ts).
   Flag any found as warnings.

4. **Git Status**
   ```
   git status
   ```
   Report uncommitted changes, untracked files.

## Output

```
## Verification Report

| Check        | Status |
|--------------|--------|
| Build        | PASS/FAIL |
| Tests        | PASS/FAIL |
| Console.log  | PASS/WARN |
| Git Status   | Clean/Dirty |

Details: (only for failures/warnings)
```

## Arguments

$ARGUMENTS can be:
- `quick` — build + tests only
- `full` — all checks (default)
- `pre-commit` — all checks + verify no .env files staged
