---
name: search-first
description: Research-before-coding workflow. Search for existing patterns, helpers, and implementations in the tracker codebase before writing new code.
origin: ECC-adapted
---

# Search First — Research Before You Code

## When to Activate

- Before implementing any new feature
- Before writing a utility function
- When unsure how something is done in the codebase
- When the work item is in `clarification` state

## Workflow

```
  Need to implement something
           │
           ▼
  Search codebase for existing patterns
           │
      ┌────┴────┐
      ▼         ▼
  Found it    Not found
      │         │
      ▼         ▼
  Reuse/     Search for
  extend     similar patterns
      │         │
      ▼         ▼
  Done      Implement new
             (following existing conventions)
```

## Search Checklist

1. **Shared helpers** — Check the "Shared Helpers" section in `core.html` (~line 6941):
   `esc()`, `agentStatusHtml()`, `renderMarkdown()`, `descriptionPreview()`, `sortItems()`, `refreshCurrentView()`, `renderSearchResultItem()`, `executeSearch()`

2. **Shared constants** — Check near top of JS (~line 6657):
   `PRIORITY_ORDER`, `SESSION_STATUS_MAP`

3. **Existing space plugins** — Check `src/spaces/*.ts` for similar patterns:
   - Parser implementations
   - API route patterns
   - MCP tool definitions
   - UI renderer patterns in `src/ui/spaces/*.js`

4. **Database patterns** — Check `src/db.ts` for:
   - Existing query patterns
   - Transaction usage
   - Migration examples

5. **API patterns** — Check `src/api.ts` for:
   - Route registration
   - Auth middleware usage
   - Response formatting

## Decision Matrix

| Situation | Action |
|-----------|--------|
| Helper exists | Use it directly |
| Similar pattern exists | Follow the pattern, extend if needed |
| Nothing similar | Implement new, following project conventions |
| Complex/unclear | Move item to `clarification`, add research comment |

## Anti-Patterns

- Writing a new `escapeHtml()` when `esc()` exists
- Creating a new sort function when `sortItems()` handles it
- Building custom markdown rendering when `renderMarkdown()` is available
- Adding inline styles when CSS custom properties exist
