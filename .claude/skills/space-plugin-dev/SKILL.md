---
name: space-plugin-dev
description: Guide for developing new space plugins. Use when creating a new space type or extending an existing one. Covers the SpacePlugin interface, parsers, API routes, MCP tools, and UI renderers.
origin: custom
---

# Space Plugin Development Guide

## When to Activate

- Creating a new space type (e.g., `recipe`, `bookmark`, `meeting`)
- Adding API routes or MCP tools to an existing space
- Building a new UI renderer for a space
- Extending the SpacePlugin interface

## Architecture Overview

A space plugin consists of up to 5 parts:

| Part | File | Required? |
|------|------|-----------|
| Plugin definition | `src/spaces/<name>.ts` | Yes |
| Registration | `src/spaces/index.ts` | Yes (add import + registerSpace call) |
| UI renderer | `src/ui/spaces/<name>.js` | Yes (at minimum, a registry entry) |
| Tests | `src/spaces/<name>.test.ts` | Yes, for non-trivial logic |
| Types | `src/spaces/types.ts` | Only if extending shared types |

## Step-by-Step Checklist

### 1. Define the Plugin (`src/spaces/<name>.ts`)

Implement the `SpacePlugin` interface:

```typescript
import { SpacePlugin } from './types';

export const mySpacePlugin: SpacePlugin = {
  type: 'my_space',
  label: 'My Space',

  // Parse raw space_data into structured form
  parseSpaceData(raw: unknown): MySpaceData {
    // Validate and return typed data
  },

  // Optional: sanitize before storage
  sanitizeSpaceData(data: MySpaceData): MySpaceData {
    // Strip invalid fields, normalize values
  },

  // Optional: API routes
  apiRoutes: [
    {
      method: 'PATCH',
      path: '/my-field',
      handler: async (req, res, db, item) => { ... }
    }
  ],

  // Optional: MCP tools
  mcpTools: [
    {
      name: 'tracker_update_my_field',
      description: 'Update my field on a my_space item',
      schema: z.object({ item_id: z.string(), value: z.string() }),
      handler: async (args, db) => { ... }
    }
  ],

  // Optional: cover image support
  supportsCoverImage: false,
};
```

### 2. Register the Plugin (`src/spaces/index.ts`)

```typescript
import { mySpacePlugin } from './my-space';
registerSpace(mySpacePlugin);
```

### 3. Build the UI Renderer (`src/ui/spaces/<name>.js`)

```javascript
// ── My Space Renderer ──
(function() {
  SpaceRenderers.register('my_space', {
    label: 'My Space',
    renderOverlay(item, container) {
      // Build the overlay UI for this space type
      // Use esc() for all user content
      // Use renderMarkdown() for markdown fields
    },
    renderCard(item) {
      // Return HTML string for card preview (optional)
    }
  });
})();
```

### 4. Add Tests (`src/spaces/<name>.test.ts`)

Test the parser, sanitizer, and any business logic:

```typescript
import { describe, it, expect } from 'vitest';
import { mySpacePlugin } from './my-space';

describe('my-space plugin', () => {
  it('should parse valid space data', () => { ... });
  it('should handle missing optional fields', () => { ... });
  it('should sanitize invalid values', () => { ... });
});
```

### 5. Build and Verify

```bash
npm run build      # TypeScript + UI compilation
npm test           # Run all tests
```

## Conventions

- Space types use snake_case: `my_space`, not `mySpace`
- API routes are nested under the item: `/api/v1/items/:id/spaces/<name>/<route>`
- MCP tool names are prefixed: `tracker_<action>_<space>_<field>`
- UI renderers are IIFEs that call `SpaceRenderers.register()`
- Always use `esc()` in UI renderers for user-supplied content
- Add a `// ── Section Name ──` header for new UI sections

## Existing Plugins (Reference)

| Plugin | Complexity | Good reference for... |
|--------|-----------|----------------------|
| `standard` | Minimal | Bare minimum plugin |
| `text` | Simple | Parser only, inline comments UI |
| `song` | Simple | Cover image support |
| `scheduled` | Medium | Sanitizer, status tracking, API routes |
| `engagement` | Complex | Multiple MCP tools, milestones, contacts |
| `travel` | Complex | Deep merge, dedup keys, day-by-day UI |
| `presentation` | Complex | External service integration (DeckWright) |
