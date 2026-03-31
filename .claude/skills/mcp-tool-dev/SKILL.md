---
name: mcp-tool-dev
description: Guide for developing new MCP tools. Use when adding tools to mcp-server.ts or via space plugin mcpTools arrays. Covers Zod validation, actor handling, and test patterns.
origin: custom
---

# MCP Tool Development Guide

## When to Activate

- Adding a new MCP tool to `src/mcp-server.ts`
- Adding MCP tools via a space plugin's `mcpTools` array
- Modifying existing MCP tool behavior
- Debugging MCP tool issues

## Tool Structure

### Core MCP Tools (`src/mcp-server.ts`)

```typescript
server.tool(
  'tracker_my_action',
  'Description of what this tool does',
  {
    // Zod schema for input validation
    item_id: z.string().describe('Work item ID or display key'),
    value: z.string().describe('The value to set'),
    actor: z.string().optional().describe('Who is making this change'),
  },
  async ({ item_id, value, actor }) => {
    // 1. Resolve item (support both ID and display key)
    // 2. Validate business rules
    // 3. Perform the operation
    // 4. Return result

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  }
);
```

### Space Plugin MCP Tools (`src/spaces/<name>.ts`)

```typescript
mcpTools: [
  {
    name: 'tracker_update_my_field',
    description: 'Update my field',
    schema: z.object({
      item_id: z.string().describe('Work item ID or display key'),
      value: z.string(),
    }),
    handler: async (args, db) => {
      // Space plugin tools receive (args, db) not the full server context
      // Return the same content format
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }
  }
]
```

## Security Requirements

### Actor Classification

- MCP tools that create items MUST force `created_by` to the agent name
- MCP tools that change state MUST force `actor_class = "agent"`
- Never allow an agent to impersonate a human actor
- Only human actors can move items to `approved` or `cancelled`

### Input Validation

- Always use Zod schemas — never trust raw input
- Validate item_id format
- Validate enum values (state, priority, etc.)
- Sanitize string inputs that will be stored or displayed

### Error Handling

```typescript
// Return errors as text content, not thrown exceptions
if (!item) {
  return {
    content: [{ type: 'text', text: 'Error: Item not found' }],
    isError: true,
  };
}
```

## Naming Conventions

| Pattern | Example |
|---------|---------|
| CRUD operations | `tracker_create_item`, `tracker_update_item`, `tracker_get_item` |
| State changes | `tracker_change_state`, `tracker_lock_item` |
| Space-specific | `tracker_add_travel_segment`, `tracker_update_engagement_contact` |
| Compound actions | `tracker_dispatch_item`, `tracker_emergency_stop` |

## Testing MCP Tools

Test through the database layer, not through MCP protocol:

```typescript
describe('tracker_my_action', () => {
  it('should perform the action', () => {
    const db = _initTestTrackerDatabase();
    // Set up test data
    // Call the underlying db function
    // Assert the result
  });

  it('should reject invalid input', () => {
    // Test with missing/invalid parameters
  });

  it('should enforce actor classification', () => {
    // Verify agents cannot perform human-only actions
  });
});
```

## Checklist for New Tools

- [ ] Zod schema defines all parameters with `.describe()` annotations
- [ ] Actor classification enforced for state-changing operations
- [ ] Input validated and sanitized
- [ ] Error responses use `isError: true`
- [ ] Tool name follows naming conventions
- [ ] Tool description is clear and actionable
- [ ] Tests cover happy path, error cases, and authorization
- [ ] CLAUDE.md updated if the tool surface changed significantly
