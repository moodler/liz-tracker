---
name: security-review
description: Use when adding authentication, handling user input, working with secrets, creating API endpoints, or modifying security-sensitive code. General security checklist.
origin: ECC-adapted
---

# Security Review Skill

## When to Activate

- Adding or modifying API endpoints in `src/api.ts`
- Handling user input (query params, request bodies, MCP tool inputs)
- Working with tokens, keys, or secrets
- Modifying authentication or authorization logic
- Adding new MCP tools

## Security Checklist

### 1. Secrets Management

- Never hardcode API keys, tokens, or passwords
- All secrets go in `.env` (which is gitignored)
- Access secrets via `config.ts`, never via `process.env` directly

FAIL: `const key = "sk-abc123..."`
PASS: `const key = config.ANTHROPIC_API_KEY`

### 2. Input Validation

- Validate all user-supplied input at API boundaries
- Use Zod schemas for MCP tool inputs
- Sanitize HTML in user content to prevent XSS

FAIL: `const id = req.params.id; db.get(id);`
PASS: `const id = req.params.id; if (!id?.match(/^[a-f0-9]{24}$/)) return res.status(400)...`

### 3. SQL Injection Prevention

- Always use parameterized queries with better-sqlite3
- Never interpolate user input into SQL strings

FAIL: `` db.prepare(`SELECT * FROM items WHERE id = '${id}'`).get() ``
PASS: `db.prepare('SELECT * FROM items WHERE id = ?').get(id)`

### 4. XSS Prevention

- Use `esc()` helper for all user content rendered in HTML
- Never use `innerHTML` with unsanitized input
- Use `renderMarkdown()` for markdown content (includes sanitization)

### 5. Authentication & Authorization

- API write endpoints require Bearer token (`TRACKER_API_TOKEN`)
- MCP tools enforce actor classification — agents cannot approve items
- Verify `approved_by_class` before dispatch

### 6. Path Traversal

- Validate file paths against allowed directories
- Never construct file paths from user input without sanitization
- Attachment storage uses generated UUIDs, not user-supplied filenames

### 7. Rate Limiting

- Consider rate limiting for public-facing endpoints
- The orchestrator has built-in circuit breaker for dispatch failures

## Pre-Commit Security Checklist

- [ ] No hardcoded secrets
- [ ] All SQL queries use parameters
- [ ] User input validated at API boundaries
- [ ] HTML output uses `esc()` or `renderMarkdown()`
- [ ] No new `eval()`, `Function()`, or `child_process.exec()` with user input
- [ ] Actor classification not weakened
- [ ] Blocked file patterns not reduced
