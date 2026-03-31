---
name: orchestrator-safe-dev
description: Safety guidelines for modifying orchestrator code. Use when touching state transitions, SSE handling, session lifecycle, circuit breaker, safe restart, or dispatch logic in orchestrator.ts.
origin: custom
---

# Orchestrator Safe Development Guide

## When to Activate

- Modifying `src/orchestrator.ts`
- Changing state transition logic
- Modifying SSE event handling
- Changing session lifecycle (pending → running → completed/failed)
- Modifying dispatch eligibility (`getDispatchableItems()`)
- Changing circuit breaker or retry logic
- Modifying the session runner (`src/session-runner.ts`)

## Critical Rules

1. **Never use `launchctl` directly** — always use `./scripts/safe-restart.sh` to avoid interrupting active sessions.
2. **Add detailed comments** explaining what changed and why when modifying dispatch or security-critical code.
3. **Test state transitions** — add test cases to `src/orchestrator.test.ts` for any new transition logic.
4. **Preserve approval provenance** — never clear or overwrite `approved_by`, `approved_by_class`, `approved_at`, or `approved_description_hash` unless the item is being re-approved by a human.

## State Machine

```
brainstorming → clarification → approved → in_development → in_review → testing → done
                                    ↑           │                │         │
                                    └───────────┘                │         │
                                    (redispatch)                 │         │
                                    ↑                            │         │
                                    └────────────────────────────┘         │
                                    (testing feedback)                     │
                                                                           ↓
                                                                      cancelled

Special: needs_input (any state can go here, auto-shelve on repeated failure)
```

## Dispatch Logic Safety

### What `getDispatchableItems()` Checks

1. State is `approved` (coder) or `clarification` (research) or `in_review` (redispatch)
2. `requires_code = true` (or appropriate for research)
3. Not locked by another agent
4. No active session already running
5. Not blocked by unresolved dependencies
6. `approved_by_class = 'human'` (integrity check)
7. Description hash matches `approved_description_hash` (tamper check)
8. For scheduled tasks: `isScheduleTimeDue()` returns true

### When Modifying Dispatch

- Never remove a safety check without explicit approval
- Add new checks before existing ones (fail fast)
- Log why an item was skipped (helps debugging)
- Test with the full dispatch pipeline, not just individual checks

## SSE Event Handling

- SSE connections can drop — always handle reconnection
- Use exponential backoff for reconnection attempts
- Don't assume events arrive in order
- Handle duplicate events gracefully (idempotent handlers)

## Session Lifecycle

### State Transitions

| From | To | Trigger |
|------|----|---------|
| (none) | pending | Session created |
| pending | running | First event received |
| running | completed | Session ends successfully |
| running | failed | Error or timeout |
| running | idle | Session goes idle (transitional) |
| any | failed | Emergency stop |

### Cleanup Responsibilities

When a session ends (completed or failed):
1. Update `session_status` on the work item
2. Unlock the item if still locked
3. Move item to appropriate state (in_review for success, needs_input for repeated failure)
4. Clear `session_id` reference
5. Add a comment summarizing what happened

## Circuit Breaker

- Threshold: `CIRCUIT_BREAKER_THRESHOLD` consecutive failures
- Window: `CIRCUIT_BREAKER_WINDOW` milliseconds
- Auto-pauses the orchestrator when tripped
- Resuming resets the counter
- Image-too-large errors count (don't self-heal)
- 413/context-length errors don't count (compaction may help)

## Testing Orchestrator Changes

Always add/update tests in `src/orchestrator.test.ts`:

```typescript
describe('new dispatch behavior', () => {
  it('should handle the new case', () => {
    // Use the existing test helpers
    // Test the specific logic, not the full dispatch loop
  });
});
```

Run the full test suite: `npm test`
Run just orchestrator tests: `npx vitest run src/orchestrator.test.ts`

## Mandatory Comment Template

When modifying orchestrator code, add a comment above the change:

```typescript
// TRACK-XXX: <what changed>
// Why: <motivation — not just "updated", explain the reason>
// Safety: <why this is safe — what invariants are preserved>
```
