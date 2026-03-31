---
name: tdd-workflow
description: Use when writing new features, fixing bugs, or refactoring tracker code. Enforces test-driven development with our Vitest + in-memory SQLite setup.
origin: ECC-adapted
---

# Test-Driven Development Workflow

## When to Activate

- Writing a new feature or MCP tool
- Fixing a bug (write the failing test first)
- Refactoring existing code
- Adding a new space plugin

## Core Principles

1. **Red → Green → Refactor**: Write a failing test, make it pass with minimal code, then clean up.
2. **Test the behavior, not the implementation**: Tests should describe what the code does, not how.
3. **One assertion per test when possible**: Makes failures easy to diagnose.

## Tracker-Specific Test Setup

All tests use Vitest with in-memory SQLite:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestTrackerDatabase } from './db';

describe('Feature Name', () => {
  let db: ReturnType<typeof _initTestTrackerDatabase>;

  beforeEach(() => {
    db = _initTestTrackerDatabase();
  });

  it('should do the expected thing', () => {
    // Arrange → Act → Assert
  });
});
```

## TDD Workflow Steps

1. **Understand the requirement** — Read the work item description and comments
2. **Write the test first** — Create or extend a test file in `src/**/*.test.ts`
3. **Run the test** — `npm test` — verify it fails for the right reason
4. **Write minimal implementation** — Just enough to pass the test
5. **Run all tests** — `npm test` — verify nothing else broke
6. **Refactor** — Clean up while keeping tests green
7. **Build check** — `npm run build` — verify TypeScript compiles

## Test File Conventions

| Source file | Test file |
|------------|-----------|
| `src/db.ts` | `src/db.test.ts` |
| `src/orchestrator.ts` | `src/orchestrator.test.ts` |
| `src/spaces/travel.ts` | `src/spaces/travel.test.ts` |
| `src/spaces/new-space.ts` | `src/spaces/new-space.test.ts` |

## What to Test

- **DB layer**: State transitions, CRUD operations, actor classification, approval provenance
- **Orchestrator**: Dispatch logic, error classification, schedule time gating
- **Space plugins**: Parsers, sanitizers, deduplication logic
- **MCP tools**: Input validation, authorization, expected outputs

## Common Mistakes to Avoid

- Testing implementation details (private function internals)
- Skipping edge cases (empty inputs, null values, boundary conditions)
- Not testing error paths (what happens when the DB query fails?)
- Writing tests after the code is done (loses the design benefit of TDD)
