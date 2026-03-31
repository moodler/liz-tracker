---
name: node-sqlite-patterns
description: Database patterns for better-sqlite3 with WAL mode. Query optimization, schema design, and migration patterns for the tracker's SQLite layer.
origin: ECC-adapted (postgres-patterns → sqlite)
---

# Node.js + SQLite Patterns

## When to Activate

- Adding or modifying database queries in `src/db.ts`
- Creating new tables or migrations
- Optimizing slow queries
- Adding indexes

## better-sqlite3 Fundamentals

The tracker uses `better-sqlite3` in WAL mode for concurrent read access.

### Prepared Statements (Always Use)

```typescript
// GOOD: Parameterized query
const item = db.prepare('SELECT * FROM tracker_items WHERE id = ?').get(id);

// GOOD: Named parameters
const items = db.prepare(
  'SELECT * FROM tracker_items WHERE project_id = @projectId AND state = @state'
).all({ projectId, state });

// BAD: String interpolation (SQL injection risk)
const item = db.prepare(`SELECT * FROM tracker_items WHERE id = '${id}'`).get();
```

### Transactions

```typescript
const insertMany = db.transaction((items: Item[]) => {
  const stmt = db.prepare('INSERT INTO tracker_items (id, title) VALUES (?, ?)');
  for (const item of items) {
    stmt.run(item.id, item.title);
  }
});
insertMany(items); // Atomic — all or nothing
```

### Migrations Pattern

Follow the existing migration pattern in `db.ts`:

```typescript
// Migrations run in order, tracked by version number
// Each migration is idempotent (uses IF NOT EXISTS, etc.)
// Never modify existing migrations — add new ones
```

## Query Optimization

### Index Strategy

- Index columns used in WHERE clauses and JOINs
- Composite indexes for multi-column filters (leftmost prefix rule)
- Partial indexes for filtered queries: `CREATE INDEX ... WHERE state = 'approved'`

### Avoid N+1 Queries

```typescript
// BAD: N+1
const items = db.prepare('SELECT * FROM tracker_items').all();
for (const item of items) {
  item.comments = db.prepare('SELECT * FROM tracker_comments WHERE item_id = ?').all(item.id);
}

// GOOD: Single query with JOIN or batch
const items = db.prepare(`
  SELECT i.*, GROUP_CONCAT(c.body, '|||') as comment_bodies
  FROM tracker_items i
  LEFT JOIN tracker_comments c ON c.item_id = i.id
  GROUP BY i.id
`).all();
```

### JSON in SQLite

```typescript
// Store JSON in TEXT columns, parse in application layer
db.prepare('UPDATE tracker_items SET space_data = ? WHERE id = ?')
  .run(JSON.stringify(spaceData), id);

// Query JSON fields with json_extract (SQLite 3.38+)
db.prepare("SELECT * FROM tracker_items WHERE json_extract(space_data, '$.status.last_run') IS NOT NULL")
  .all();
```

## Schema Design Rules

- Use TEXT for IDs (hex strings), not INTEGER
- Use TEXT for dates (ISO 8601 format)
- Use INTEGER for booleans (0/1)
- Use TEXT for JSON data (space_data, labels)
- Always add created_at and updated_at columns
