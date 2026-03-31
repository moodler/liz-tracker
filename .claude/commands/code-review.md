# Code Review

Comprehensive security and quality review of uncommitted changes in the tracker.

1. Get changed files: `git diff --name-only HEAD`

2. For each changed file, check for:

**Security Issues (CRITICAL):**
- Hardcoded credentials, API keys, tokens
- SQL injection vulnerabilities (raw string interpolation in queries)
- Missing input validation on API endpoints
- Weakened actor classification or approval provenance
- Changes to blocked file patterns in config.ts
- XSS in UI template strings (missing `esc()` calls)

**Code Quality (HIGH):**
- Functions > 50 lines
- Missing error handling
- `console.log` statements (use logger instead)
- Missing section headers (`// ── Section Name ──`) for new features in core.html
- Not reusing shared helpers: `esc()`, `agentStatusHtml()`, `renderMarkdown()`, `descriptionPreview()`, `sortItems()`, `refreshCurrentView()`

**Best Practices (MEDIUM):**
- Missing tests for new code
- Direct `index.html` edits (must edit `core.html` instead)
- New MCP tools without corresponding test coverage
- State transition changes without orchestrator.test.ts updates

3. Generate report with:
   - Severity: CRITICAL, HIGH, MEDIUM, LOW
   - File location and line numbers
   - Issue description
   - Suggested fix

4. Block commit recommendation if CRITICAL issues found.
