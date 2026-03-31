---
name: tracker-security-review
description: Tracker-specific security checklist. Use when modifying actor classification, approval provenance, description integrity, blocked paths, dispatch logic, or MCP tool authorization.
origin: custom
---

# Tracker Security Review

## When to Activate

- Modifying `classifyActor()` or actor classification logic
- Changing approval provenance fields (approved_by, approved_by_class, approved_at, approved_description_hash)
- Modifying `getDispatchableItems()` or dispatch eligibility
- Changing blocked file patterns in `config.ts`
- Adding or modifying MCP tools
- Changing state transition rules
- Modifying the session runner or orchestrator security checks

## Actor Classification Checklist

- [ ] `classifyActor()` in `db.ts` correctly classifies all actor names
- [ ] Only `human`-class actors can move items to `approved` or `cancelled`
- [ ] MCP tools force `created_by` to the agent name (prevent impersonation)
- [ ] MCP state changes force `actor_class = "agent"`
- [ ] Exception: comment-only items (`requires_code=0`) may be agent-approved

## Approval Provenance Checklist

- [ ] `approved_by` records the actual actor name
- [ ] `approved_by_class` is set and verified at dispatch
- [ ] `approved_at` timestamp is recorded
- [ ] `approved_description_hash` is SHA-256 of description at approval time
- [ ] Description integrity check: current hash matches stored hash at dispatch

## Dispatch Security Checklist

- [ ] `getDispatchableItems()` verifies `approved_by_class = 'human'` (except comment-only)
- [ ] Description hash verification prevents post-approval tampering
- [ ] Items are not dispatched if locked, blocked, or already in a session
- [ ] Circuit breaker thresholds are not weakened
- [ ] Per-item failure limit prevents infinite retry loops

## Blocked Paths Checklist

- [ ] `BLOCKED_PATHS` in `config.ts` includes all security-critical files
- [ ] Changes do not remove existing blocked paths
- [ ] New security-critical files are added to the list
- [ ] Blocked paths are enforced in the session prompt (`buildPrompt()`)

## MCP Tool Security

- [ ] All MCP tool inputs are validated with Zod schemas
- [ ] Tools that modify state use actor classification
- [ ] No tool allows bypassing the approval workflow
- [ ] Error messages don't leak sensitive information

## Prompt Hardening

- [ ] `buildPrompt()` includes security rules for coder bots
- [ ] Post-approval comments are labeled and segregated
- [ ] Coder bots cannot create or approve items via prompt rules
- [ ] Blocked file patterns are communicated to the agent
