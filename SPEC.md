# Liz Tracker — System Specification

A self-hosted project management tracker with a kanban dashboard, REST API, MCP tools for AI agents, and an orchestrator that automatically dispatches approved work items to AI coding sessions.

Built with TypeScript, SQLite, and vanilla JS. No frontend frameworks, no build step for the UI.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Database Layer](#2-database-layer)
3. [Configuration](#3-configuration)
4. [REST API](#4-rest-api)
5. [MCP Server](#5-mcp-server)
6. [AI Orchestrator](#6-ai-orchestrator)
7. [Security Model](#7-security-model)
8. [Dashboard UI](#8-dashboard-ui)
9. [Spaces](#9-spaces)
10. [Deployment](#10-deployment)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    Liz Tracker                        │
│                                                      │
│  ┌────────────────┐   ┌────────────────────────┐    │
│  │  HTTP Server    │   │  MCP Endpoint (/mcp)   │    │
│  │  REST API :1000 │   │  Streamable HTTP       │    │
│  │  Static Files   │   │  Stateless             │    │
│  └────────┬───────┘   └────────────────────────┘    │
│           │                                          │
│  ┌────────┴───────────────┐                          │
│  │  SQLite Database       │                          │
│  │  (WAL mode, single     │                          │
│  │   file at store/)      │                          │
│  └────────────────────────┘                          │
│                                                      │
│  ┌────────────────────────┐                          │
│  │  Orchestrator          │                          │
│  │  (optional)            │──── SSE ─────┐           │
│  │  Poll + dispatch loop  │              │           │
│  └────────────────────────┘              ▼           │
│                               ┌────────────────┐    │
│                               │ OpenCode Server│    │
│                               │ (external)     │    │
│                               └────────────────┘    │
│                                      │               │
│                                      ▼               │
│                               AI coding sessions     │
│                               use tracker MCP tools  │
│                               to update their items  │
└──────────────────────────────────────────────────────┘
```

### Source Files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — init DB, start HTTP server, optionally start orchestrator, graceful shutdown |
| `src/config.ts` | Configuration from environment variables, .env loader, deep link URL helpers |
| `src/db.ts` | SQLite database layer — schema, migrations, CRUD, events, actor classification |
| `src/api.ts` | HTTP server — REST API, static file serving, MCP routing, SSE for live updates |
| `src/mcp-server.ts` | MCP tool definitions (29 tools) using `@modelcontextprotocol/sdk` |
| `src/orchestrator.ts` | AI orchestrator — dispatch loop, SSE monitoring, session lifecycle, safe restart |
| `src/logger.ts` | Pino logger with pino-pretty for development |
| `src/ui/index.html` | Kanban dashboard — single-file vanilla JS PWA (~14k lines) |
| `src/ui/sw.js` | Service worker for offline PWA support |

### Dependencies

| Package | Purpose |
|---|---|
| `better-sqlite3` | SQLite3 bindings (synchronous, fast) |
| `@modelcontextprotocol/sdk` | MCP protocol implementation |
| `@opencode-ai/sdk` | OpenCode client for session management |
| `pino` + `pino-pretty` | Structured JSON logging |
| `zod` | Schema validation for MCP tool parameters |

### Design Principles

- **Zero frontend build step** — the dashboard is a single HTML file with inline JS/CSS
- **No Express/Koa** — raw Node.js `http.createServer` with manual routing
- **Synchronous DB** — better-sqlite3 is synchronous, which simplifies data access
- **Stateless MCP** — fresh MCP server instance per request (no session state)
- **Convention over configuration** — sensible defaults, override via `.env`

---

## 2. Database Layer

SQLite database at `{STORE_DIR}/tracker.db`, using WAL (Write-Ahead Logging) mode and foreign keys enabled.

### Schema

#### `tracker_projects`

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | TEXT PK | | Random 24-char hex ID |
| `name` | TEXT | | Project display name |
| `short_name` | TEXT | derived | Uppercase prefix for item keys (e.g. "LIZ") |
| `description` | TEXT | `''` | Project description |
| `context` | TEXT | `''` | Operational context injected into every agent prompt |
| `theme` | TEXT | `'midnight'` | Dashboard colour theme (`midnight`, `ocean`, `forest`, `sunset`, `lavender`) |
| `next_seq` | INTEGER | `1` | Next sequential item number |
| `working_directory` | TEXT | `''` | Absolute path to project repo (for orchestrator) |
| `opencode_project_id` | TEXT | `''` | Cached OpenCode project ID |
| `tab_order` | INTEGER | `0` | Dashboard tab sort order |
| `orchestration` | INTEGER | `1` | Whether orchestrator manages this project (0/1) |
| `active_spaces` | TEXT | `'["standard"]'` | JSON array of active space types |
| `created_at` | TEXT | | ISO 8601 timestamp |
| `updated_at` | TEXT | | ISO 8601 timestamp |

#### `tracker_work_items`

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | TEXT PK | | Random 24-char hex ID |
| `project_id` | TEXT FK | | References `tracker_projects.id` |
| `title` | TEXT | | Item title |
| `description` | TEXT | `''` | Markdown description / spec |
| `state` | TEXT | `'brainstorming'` | Current workflow state |
| `priority` | TEXT | `'none'` | `none`, `low`, `medium`, `high`, `urgent` |
| `assignee` | TEXT | NULL | Current assignee name |
| `labels` | TEXT | `'[]'` | JSON array of label strings |
| `position` | INTEGER | `0` | Sort position within state column |
| `seq_number` | INTEGER | `0` | Sequential number within project (for keys like LIZ-42) |
| `requires_code` | INTEGER | `0` | Whether item needs code changes (0/1) |
| `bot_dispatch` | INTEGER | `0` | Whether orchestrator should dispatch this item (0/1) |
| `platform` | TEXT | `'any'` | Target platform: `any`, `server`, `ios`, `web` |
| `date_due` | TEXT | NULL | Due date (YYYY-MM-DD) |
| `link` | TEXT | NULL | Associated URL |
| `space_type` | TEXT | `'standard'` | Space type (e.g. `standard`, `song`) |
| `space_data` | TEXT | NULL | JSON blob for space-specific custom fields |
| `locked_by` | TEXT | NULL | Agent name holding the lock |
| `locked_at` | TEXT | NULL | ISO 8601 lock timestamp |
| `session_id` | TEXT | NULL | Active OpenCode session ID |
| `session_status` | TEXT | NULL | `pending`, `running`, `completed`, `failed`, `idle` |
| `opencode_pid` | INTEGER | NULL | PID of OpenCode server process (for liveness checks) |
| `created_by` | TEXT | `'system'` | Actor who created this item |
| `created_by_class` | TEXT | `'api'` | Actor class at creation time |
| `approved_by` | TEXT | NULL | Actor who approved this item |
| `approved_by_class` | TEXT | NULL | Must be `human` for code items |
| `approved_at` | TEXT | NULL | ISO 8601 approval timestamp |
| `approved_description_hash` | TEXT | NULL | SHA-256 of description at approval time |
| `created_at` | TEXT | | ISO 8601 timestamp |
| `updated_at` | TEXT | | ISO 8601 timestamp |

#### `tracker_comments`

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | TEXT PK | | Random 24-char hex ID |
| `work_item_id` | TEXT FK | | References `tracker_work_items.id` |
| `author` | TEXT | | Author name |
| `body` | TEXT | | Markdown comment body |
| `created_at` | TEXT | | ISO 8601 timestamp |
| `updated_at` | TEXT | | ISO 8601 timestamp |

#### `tracker_transitions`

Records every state change for audit purposes.

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | TEXT PK | | Random 24-char hex ID |
| `work_item_id` | TEXT FK | | References `tracker_work_items.id` |
| `from_state` | TEXT | NULL | Previous state (NULL for creation) |
| `to_state` | TEXT | | New state |
| `actor` | TEXT | | Who triggered the transition |
| `actor_class` | TEXT | `'api'` | Actor classification at transition time |
| `comment` | TEXT | NULL | Optional transition comment |
| `created_at` | TEXT | | ISO 8601 timestamp |

#### `tracker_watchers`

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | TEXT PK | | Random 24-char hex ID |
| `work_item_id` | TEXT FK | | References `tracker_work_items.id` |
| `entity` | TEXT | | Entity name to notify |
| `notify_via` | TEXT | `'internal'` | Notification method |
| UNIQUE | | | `(work_item_id, entity)` |

#### `tracker_dependencies`

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | TEXT PK | | Random 24-char hex ID |
| `work_item_id` | TEXT FK | | The blocked item |
| `depends_on_id` | TEXT FK | | The blocking item |
| UNIQUE | | | `(work_item_id, depends_on_id)` |

#### `tracker_attachments`

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | TEXT PK | | Random 24-char hex ID |
| `work_item_id` | TEXT FK | | References `tracker_work_items.id` |
| `comment_id` | TEXT FK | NULL | Optional: attached to a specific comment |
| `filename` | TEXT | | Original filename |
| `mime_type` | TEXT | `'application/octet-stream'` | MIME type |
| `size_bytes` | INTEGER | `0` | File size |
| `storage_path` | TEXT | | Relative path within `STORE_DIR` |
| `uploaded_by` | TEXT | `'system'` | Uploader name |
| `created_at` | TEXT | | ISO 8601 timestamp |

Max attachment size: 10 MB. Files stored at `{STORE_DIR}/attachments/{item_id}/{filename}`.

#### `tracker_description_versions`

Version history for item descriptions (used by Spaces for version comparison).

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | TEXT PK | | Random 24-char hex ID |
| `work_item_id` | TEXT FK | | References `tracker_work_items.id` |
| `version` | INTEGER | | Auto-incrementing version number per item |
| `description` | TEXT | `''` | Description snapshot |
| `saved_by` | TEXT | `'system'` | Who saved this version |
| `created_at` | TEXT | | ISO 8601 timestamp |

#### `tracker_execution_audits`

Records every orchestrator dispatch for audit and debugging.

| Column | Type | Default | Description |
|---|---|---|---|
| `id` | TEXT PK | | Random 24-char hex ID |
| `work_item_id` | TEXT FK | | References `tracker_work_items.id` |
| `session_id` | TEXT | | OpenCode session ID |
| `started_at` | TEXT | | ISO 8601 dispatch timestamp |
| `completed_at` | TEXT | NULL | ISO 8601 completion timestamp |
| `files_modified` | TEXT | `'[]'` | JSON array of modified files |
| `files_created` | TEXT | `'[]'` | JSON array of created files |
| `files_deleted` | TEXT | `'[]'` | JSON array of deleted files |
| `exit_status` | TEXT | `'pending'` | `pending`, `success`, `failure`, `timeout` |
| `git_branch` | TEXT | NULL | Git branch used |
| `git_diff_stats` | TEXT | NULL | Diff statistics |
| `created_at` | TEXT | | ISO 8601 timestamp |

### ID Generation

All IDs are 24-character hex strings generated from `crypto.randomBytes(12)`.

### Timestamps

All timestamps are ISO 8601 strings (`new Date().toISOString()`).

### Work Item Keys

Each item gets a sequential key within its project: `{short_name}-{seq_number}` (e.g. `LIZ-42`). The project's `next_seq` counter increments on each item creation.

### Event System

The database layer has an in-memory event system. Mutations emit typed events that other modules can subscribe to:

| Event | Emitted When |
|---|---|
| `work_item.created` | New item created |
| `work_item.updated` | Item fields updated |
| `work_item.state_changed` | State transition |
| `work_item.deleted` | Item deleted |
| `comment.created` | New comment |
| `comment.updated` | Comment edited |
| `comment.deleted` | Comment deleted |
| `attachment.created` | File uploaded |
| `attachment.deleted` | File removed |

Listeners register via `onTrackerEvent(listener)`. The orchestrator uses this for real-time reactions (e.g. detecting owner comments during testing).

### Migrations

Migrations run on every startup using idempotent `ALTER TABLE ... ADD COLUMN` wrapped in try/catch (SQLite errors if column exists). This approach means the schema evolves without a formal migration framework. The initial `CREATE TABLE` statements define the base schema; subsequent `ALTER TABLE` calls add columns introduced over time.

Startup also runs several backfill operations:
- Assign `tab_order` to projects with default 0
- Derive `short_name` from project names
- Assign sequential numbers to items with `seq_number=0`
- Set `bot_dispatch=1` for items that already have `requires_code=1`
- Normalize historical agent actor names to "Coder"

---

## 3. Configuration

Configuration is loaded from environment variables, with a simple `.env` file loader that runs at import time. The loader reads `key=value` pairs and does NOT override existing environment variables.

### Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `1000` | HTTP server port |
| `STORE_DIR` | `./store` | Directory for SQLite DB and attachments |
| `OWNER_NAME` | `Owner` | Display name for the human owner (used as auto-assignee) |
| `HUMAN_ACTORS` | `dashboard,me` | Comma-separated names classified as human actors |
| `AGENT_ACTORS` | `coder` | Comma-separated names classified as AI agent actors |
| `TRACKER_API_TOKEN` | auto-generated | Bearer token for write API endpoints |
| `ORCHESTRATOR_ENABLED` | `false` | Master switch for the orchestrator |
| `OPENCODE_SERVER_URL` | `http://localhost:3000` | OpenCode API URL (for orchestrator calls) |
| `OPENCODE_PUBLIC_URL` | (same as server) | OpenCode URL for browser deep links |
| `ORCHESTRATOR_INTERVAL` | `30000` | Poll interval in ms |
| `OPENCODE_MAX_CONCURRENT` | `3` | Max concurrent AI sessions globally |
| `OPENCODE_MAX_PER_PROJECT` | `1` | Max concurrent sessions per project |
| `SESSION_TIMEOUT` | `2700000` (45 min) | Session timeout in ms |
| `CODER_MODEL_PROVIDER` | `anthropic` | AI model provider |
| `CODER_MODEL_ID` | `claude-opus-4-6` | AI model ID |
| `CIRCUIT_BREAKER_THRESHOLD` | `2` | Consecutive failures before auto-pause |
| `CIRCUIT_BREAKER_WINDOW` | `3600000` (1 hour) | Failure counting window in ms |
| `ITEM_DISPATCH_FAILURE_LIMIT` | `3` | Per-item failures before auto-shelving |
| `LIZ_PROJECT_ROOT` | `~/liz` | Host path for container path translation |

### API Token Resolution

The API token is resolved in priority order:
1. `TRACKER_API_TOKEN` environment variable
2. `TRACKER_API_TOKEN` in `~/.config/liz/.env`
3. Token file at `{STORE_DIR}/auth_token` (auto-generated on first run)

If no token exists anywhere, a random 32-byte hex token is generated and saved to `{STORE_DIR}/auth_token` with mode 0600.

### Deep Link URL Helpers

Three URL builder functions in `config.ts`:

| Function | Format | Purpose |
|---|---|---|
| `buildOpencodeSessionUrl(id, dir)` | `{PUBLIC_URL}/{b64dir}/session/{id}` | Browser link to a session |
| `buildOpencodeDirectoryUrl(dir)` | `{PUBLIC_URL}/{b64dir}/session` | Browser link to project sessions |
| `buildOpencodeApiSessionUrl(dir)` | `{SERVER_URL}/session?directory={dir}` | Server-side API endpoint |

The `base64UrlEncode()` function encodes directory paths using standard base64 with URL-safe character substitutions (`+` → `-`, `/` → `_`, padding stripped).

---

## 4. REST API

The HTTP server is built on raw `http.createServer` with manual routing (no Express). It handles REST API routes, static file serving (the dashboard), MCP routing, and SSE for live updates.

### Authentication

Write endpoints (`POST`, `PUT`, `PATCH`, `DELETE`) require `Authorization: Bearer <token>`. Read endpoints (`GET`) are unauthenticated. If no token is configured, auth is disabled for backward compatibility.

### Routes

#### Projects

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/projects` | List all projects (ordered by tab_order) |
| `POST` | `/api/v1/projects` | Create a project |
| `GET` | `/api/v1/projects/:id` | Get a project |
| `PATCH` | `/api/v1/projects/:id` | Update project fields |
| `DELETE` | `/api/v1/projects/:id` | Delete a project and all its items |
| `PUT` | `/api/v1/projects/reorder` | Reorder project tabs |
| `GET` | `/api/v1/projects/:id/stats` | Get project statistics (counts by state/priority/assignee) |
| `GET` | `/api/v1/projects/:id/tracker` | Get kanban-grouped view (items grouped by state) |

#### Work Items

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/items` | List items with filters (`project_id`, `state`, `priority`, `assignee`, `platform`) |
| `POST` | `/api/v1/items` | Create an item |
| `GET` | `/api/v1/items/:id` | Get an item |
| `PATCH` | `/api/v1/items/:id` | Update item fields |
| `DELETE` | `/api/v1/items/:id` | Delete an item |
| `POST` | `/api/v1/items/:id/state` | Transition item state (body: `{ state, actor, comment? }`) |
| `POST` | `/api/v1/items/:id/lock` | Lock an item (body: `{ agent }`) |
| `POST` | `/api/v1/items/:id/unlock` | Unlock an item |
| `POST` | `/api/v1/items/clear-stale-locks` | Clear locks older than threshold |
| `GET` | `/api/v1/search` | Search items by query string (`q`, optional `project_id`) |

#### Comments

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/items/:id/comments` | List comments for an item |
| `POST` | `/api/v1/items/:id/comments` | Add a comment (body: `{ author, body }`) |
| `PATCH` | `/api/v1/comments/:id` | Update a comment |
| `DELETE` | `/api/v1/comments/:id` | Delete a comment |

#### Dependencies

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/items/:id/dependencies` | List dependencies |
| `POST` | `/api/v1/items/:id/dependencies` | Add a dependency (body: `{ depends_on_id }`) |
| `DELETE` | `/api/v1/items/:id/dependencies/:dep_id` | Remove a dependency |

#### Attachments

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/items/:id/attachments` | List attachments |
| `POST` | `/api/v1/items/:id/attachments` | Upload an attachment (multipart form) |
| `GET` | `/api/v1/attachments/:id` | Download an attachment file |
| `DELETE` | `/api/v1/attachments/:id` | Delete an attachment |

#### Transitions & Versions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/items/:id/transitions` | Get state transition history |
| `GET` | `/api/v1/items/:id/versions` | Get description version history |
| `POST` | `/api/v1/items/:id/versions` | Save a description version snapshot |

#### Watchers

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/items/:id/watchers` | List watchers |
| `POST` | `/api/v1/items/:id/watchers` | Add a watcher |
| `DELETE` | `/api/v1/items/:id/watchers/:entity` | Remove a watcher |

#### Orchestrator

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/orchestrator/status` | Get orchestrator status (enabled, paused, active sessions) |
| `POST` | `/api/v1/orchestrator/pause` | Pause the orchestrator |
| `POST` | `/api/v1/orchestrator/resume` | Resume the orchestrator |
| `POST` | `/api/v1/orchestrator/emergency-stop` | Emergency stop — pause + cancel all active sessions |
| `POST` | `/api/v1/orchestrator/restart` | Request a safe restart |
| `GET` | `/api/v1/orchestrator/restart` | Check restart status |
| `DELETE` | `/api/v1/orchestrator/restart` | Cancel a pending restart |
| `GET` | `/api/v1/orchestrator/safe-to-restart` | Quick safety check for restart |

#### Dispatch & Sessions

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/items/:id/dispatch` | Manually dispatch an item to OpenCode |
| `GET` | `/api/v1/items/:id/session` | Get session info (ID, status, OpenCode URL) |
| `POST` | `/api/v1/items/:id/session/abort` | Abort an active session |
| `GET` | `/api/v1/items/:id/audits` | Get execution audit history |

#### Cross-Project Views

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/attention` | Items needing owner attention (needs_input, in_review, testing, brainstorming) |
| `GET` | `/api/v1/recent` | Recently updated items across all projects |

### Static File Serving

The server serves `src/ui/index.html` for the root path (`/`) and `src/ui/sw.js` for the service worker. Attachment files are served from `{STORE_DIR}/attachments/`.

---

## 5. MCP Server

Streamable HTTP MCP endpoint at `/mcp`. Each request creates a fresh `McpServer` instance with a `StreamableHTTPServerTransport` — fully stateless, no session persistence between requests.

### Tools (29)

#### Project Management
| Tool | Description |
|---|---|
| `tracker_list_projects` | List all projects |
| `tracker_create_project` | Create a new project |
| `tracker_project_stats` | Get statistics for a project |

#### Work Item CRUD
| Tool | Description |
|---|---|
| `tracker_create_item` | Create a work item |
| `tracker_get_item` | Get item by ID or key (e.g. "LIZ-42") |
| `tracker_list_items` | List items with filters |
| `tracker_update_item` | Update item fields |
| `tracker_change_state` | Transition item state |

#### Comments & Collaboration
| Tool | Description |
|---|---|
| `tracker_add_comment` | Add a comment to an item |
| `tracker_watch_item` | Add a watcher to an item |
| `tracker_view` | Get full item view (item + comments + transitions + dependencies) |

#### Locking
| Tool | Description |
|---|---|
| `tracker_lock_item` | Lock an item (prevents concurrent edits) |
| `tracker_unlock_item` | Unlock an item |
| `tracker_clear_stale_locks` | Clear locks older than threshold |

#### Dependencies
| Tool | Description |
|---|---|
| `tracker_add_dependency` | Add a blocking dependency |
| `tracker_remove_dependency` | Remove a dependency |
| `tracker_get_blockers` | Get items blocking a given item |

#### Attachments
| Tool | Description |
|---|---|
| `tracker_upload_attachment` | Upload a file attachment (base64-encoded) |
| `tracker_upload_attachment_from_path` | Upload from a filesystem path (with container path translation) |
| `tracker_list_attachments` | List attachments for an item |
| `tracker_delete_attachment` | Delete an attachment |

#### Orchestrator Control
| Tool | Description |
|---|---|
| `tracker_dispatch_item` | Manually dispatch an item to OpenCode |
| `tracker_get_session_status` | Get session status for an item |
| `tracker_abort_session` | Abort an active session |
| `tracker_orchestrator_status` | Get orchestrator status |
| `tracker_emergency_stop` | Emergency stop — pause + kill all sessions |
| `tracker_safe_restart` | Request a safe restart (waits for active sessions) |
| `tracker_restart_status` | Check restart safety and status |
| `tracker_cancel_restart` | Cancel a pending restart |
| `tracker_validate_agent_config` | Check that the tracker-worker agent config file exists |

### Actor Class Override

All MCP tool calls that perform state transitions pass `actorClassOverride: "agent"`, which forces the actor class to `agent` regardless of the actor name string. This prevents prompt injection via actor name spoofing (an AI agent sending `actor="dashboard"` to bypass approval restrictions).

### Container Path Translation

The `tracker_upload_attachment_from_path` tool supports container path translation for agents running inside containers. Paths starting with `/workspace/group/` or `/workspace/project/` are mapped to host filesystem paths using `LIZ_PROJECT_ROOT`.

---

## 6. AI Orchestrator

The orchestrator automatically dispatches approved work items to [OpenCode](https://opencode.ai) AI coding sessions. It is disabled by default (`ORCHESTRATOR_ENABLED=false`).

### Prerequisites

1. A running OpenCode server (`opencode serve --hostname 0.0.0.0 --port 3000`)
2. OpenCode configured with the tracker as an HTTP MCP server
3. A `tracker-worker` agent definition at `~/.config/opencode/agents/tracker-worker.md`
4. `ORCHESTRATOR_ENABLED=true` in the tracker's environment

### Dispatch Types

The orchestrator handles three types of dispatch:

#### 1. Coder Dispatch (state = `approved`)

For items with `bot_dispatch=1`. The orchestrator:
1. Creates an OpenCode session with title `{KEY}: {title}`
2. Builds a prompt containing: item details, description, comments (segregated pre/post-approval), dependencies, attachments, project context, security rules, and blocked file patterns
3. Sends the prompt to the `tracker-worker` agent with the configured AI model
4. Embeds image attachments (up to 4.5 MB each) as base64 data URLs in the prompt
5. Monitors via SSE for completion/failure

#### 2. Research Dispatch (state = `clarification`)

For items moved to `clarification` from `brainstorming`. The orchestrator:
1. Creates an OpenCode session with title `[Research] {KEY}: {title}`
2. Builds a research-specific prompt (no code changes, just investigation)
3. The research agent reads source files, updates the item description with a concrete spec, adds a comment, and moves the item back to `brainstorming`

#### 3. Review Dispatch (state = `in_review`)

For items in `in_review` where the most recent transition was by the orchestrator with comment "Testing feedback from owner:". This enables a feedback loop where the human comments during testing and the agent automatically picks up the feedback.

### Session Lifecycle

```
dispatch() called
    │
    ▼
session_status = 'pending'   ─── OpenCode session created
    │
    ▼
session_status = 'running'   ─── Prompt sent, SSE shows 'busy'
    │
    ├── SSE 'idle' event ──────► handleSessionComplete()
    │                               session_status = 'completed'
    │                               Safety net: unlock if still locked
    │
    ├── SSE 'error' event ─────► handleSessionError()
    │                               session_status = 'failed'
    │                               Add error comment, unlock
    │
    └── Timeout ───────────────► checkStaleSessions()
                                    session_status = 'failed'
                                    Kill process, unlock
```

### SSE Event Monitoring

The orchestrator connects to OpenCode's global SSE endpoint (`/global/event`) and processes:

| Event | Action |
|---|---|
| `session.status` (busy) | Update lastActivityAt, reset compaction flag |
| `session.status` (retry) | Mark as compacting (413 recovery) |
| `session.status` (idle) | Handle completion |
| `session.idle` | Handle completion |
| `session.compacted` | Mark compacting, cancel deferred errors |
| `message.part.updated` (compaction) | Mark compacting |
| `session.error` | Handle error (with 413 grace period) |

SSE reconnects with exponential backoff (1s → 2s → 4s → max 30s).

### Compaction Recovery

When OpenCode encounters a 413 (Request Entity Too Large) error, it auto-compacts the context and retries. The orchestrator recognises this pattern:
1. Detects 413-related errors and defers error handling for 15 seconds
2. Marks the session as `compacting` with an extended 30-minute timeout
3. If the session recovers (returns to `busy`), the deferred error is cancelled
4. If it doesn't recover, the error is processed normally

### Stale Session Detection

Every scheduler tick checks for sessions that have exceeded `SESSION_TIMEOUT`:
1. Checks if the OpenCode server PID is still alive
2. If the process died, marks session as failed immediately
3. If alive but over timeout (and not compacting), attempts graceful kill via signal escalation: SIGHUP → wait 2s → SIGTERM → wait 8s

### Per-Project Concurrency

`OPENCODE_MAX_PER_PROJECT` (default: 1) prevents multiple agents working on the same project simultaneously, which would cause git conflicts. The global `OPENCODE_MAX_CONCURRENT` limit also applies.

### Circuit Breaker

If `CIRCUIT_BREAKER_THRESHOLD` (default: 2) consecutive dispatches fail within `CIRCUIT_BREAKER_WINDOW` (default: 1 hour), the orchestrator auto-pauses. Resuming resets the circuit breaker.

Image-too-large errors count toward the circuit breaker because they never self-heal via compaction.

### Per-Item Retry Limit

If a single item fails dispatch `ITEM_DISPATCH_FAILURE_LIMIT` (default: 3) times, the orchestrator auto-moves it to `needs_input` and stops retrying. The counter resets when the item is re-approved.

### Safe Restart

When the tracker itself needs to restart (e.g. after a code change), the safe restart mechanism prevents interrupting active AI sessions:

1. Checks for active sessions (in-memory + database)
2. If no sessions: restarts immediately via `launchctl kickstart -k`
3. If sessions exist: pauses orchestrator, polls every 5 seconds until sessions complete, then restarts
4. 30-minute timeout — cancels restart and resumes orchestrator if sessions haven't completed

### Prompt Construction

The `buildPrompt()` function assembles a comprehensive prompt including:
- Item metadata (key, title, priority, platform, labels, assignee)
- Project context (operational instructions)
- Rework warning (if item has been in_development before, with full transition history)
- Description (the approved spec)
- Comments (segregated into pre-approval and post-approval with security warnings)
- Dependencies (completed blockers)
- Attachments (listing, with images embedded as base64)
- Security rules (7 rules about what the agent must not do)
- Blocked file patterns (paths the agent must not modify)
- Working directory and workflow instructions

### Comment-Based Auto-Completion

The orchestrator monitors the tracker event system. When a human comments on an item that's in `testing` state, the orchestrator automatically moves it to `in_review` with the owner's feedback, making it eligible for re-dispatch. This creates a human-in-the-loop feedback cycle without requiring the human to manually change states.

---

## 7. Security Model

The security model prevents prompt injection attacks from causing the orchestrator to auto-execute malicious tasks.

### Actor Classification

Every state transition and item creation records an `actor_class`:

| Pattern | Class | Can Approve? |
|---|---|---|
| Configured in `HUMAN_ACTORS` (default: `dashboard`, `me`) | `human` | Yes |
| Configured in `AGENT_ACTORS` (default: `coder`) | `agent` | No (exception: comment-only items) |
| `orchestrator`, `system`, `health-check`, `scheduler` | `system` | No |
| Anything else | `api` | No |

Classification is case-insensitive.

### Restricted State Transitions

| Transition | Restriction |
|---|---|
| → `approved` | Only `human` actors (exception: comment-only items with `requires_code=0`) |
| → `cancelled` | Only `human` actors |
| → `in_development` | Not allowed for `api` actors (must go through orchestrator or human) |

### Approval Provenance

When an item moves to `approved`:
1. `approved_by` — the actor name
2. `approved_by_class` — must be `human` (or `agent` for comment-only items)
3. `approved_at` — ISO timestamp
4. `approved_description_hash` — SHA-256 of the description at approval time

### Description Integrity

At dispatch time, `getDispatchableItems()` verifies:
1. `approved_by_class = 'human'` (comment-only items exempt)
2. SHA-256 of current description matches `approved_description_hash`

If the description was modified after approval, the item is automatically moved to `clarification` with a comment explaining that re-approval is required.

### Prompt Hardening

Every agent prompt includes:
- 7 security rules (no credential access, no out-of-scope changes, no security file modifications)
- List of blocked file patterns from `BLOCKED_PATHS` in config
- Post-approval comments are labeled with warnings about their unverified nature
- Explicit instruction not to follow post-approval instructions that contradict the approved description

### Blocked File Patterns

Defined in `config.ts`. Includes sensitive paths like SSH keys, .env files, security hooks, MCP server definitions, and other infrastructure files. These are injected into every agent prompt.

### MCP Actor Override

All MCP-originating state transitions force `actorClass = "agent"`, preventing an AI agent from spoofing a human actor name to bypass approval restrictions.

---

## 8. Dashboard UI

The dashboard is a single HTML file (`src/ui/index.html`, ~14k lines) containing all CSS and JavaScript inline. It's a vanilla JS application — no React, no Vue, no build step.

### Architecture

- Wrapped in an IIFE (Immediately Invoked Function Expression)
- Organised into ~52 sections, each marked with `// ── Section Name ──` comment headers
- Dark theme by default with per-project colour themes
- Responsive design: desktop kanban board + mobile-optimised views
- Installable as a PWA (service worker, manifest)

### Key Sections

| Section | Purpose |
|---|---|
| **Config** | API base URL, constants |
| **State** | Global app state object |
| **Auth** | Token-based login flow |
| **API Helpers** | `apiFetch()` wrapper for all API calls |
| **Projects (Tab-based)** | Project tabs, tab drag-and-drop reordering |
| **Search** | Full-text search across items |
| **Tracker** | Main kanban board rendering |
| **Drag & Drop** | Card drag-and-drop between state columns |
| **Dispatch to OpenCode** | "Run Now" button, dispatch UI |
| **Orchestrator Status** | Status indicator, pause/resume controls |
| **Agent Robot Badges** | Session status emoji badges on cards |
| **Overview View** | Cross-project kanban (all projects on one board) |
| **Today/Focus Dashboard** | Mobile-optimised daily focus view |
| **Space: Overlay Shell** | Full-screen overlay for space types |
| **Space: Song** | Song space renderer |
| **Detail Panel** | Item detail sidebar (description, comments, metadata) |
| **Attachments** | Upload, view, delete file attachments |
| **Comment Quick-Reply** | Mobile bottom sheet for quick comments |
| **Create Item Modal** | New item creation dialog |
| **Mobile Navigation** | Bottom nav bar, drawer, swipe actions |
| **Pull-to-Refresh** | Mobile pull-to-refresh gesture |
| **Quick-Create** | Inline item creation on mobile |
| **Auto Refresh** | Periodic data refresh |
| **Triage Mode** | Card-by-card triage workflow |
| **Offline Support** | Service worker registration, offline fallbacks |

### Shared Helpers

Reusable utility functions in the "Shared Helpers" section:

| Helper | Purpose |
|---|---|
| `esc(s)` | HTML-escape a string |
| `agentStatusHtml(status)` | Render session status emoji badge |
| `renderMarkdown(md)` | Lightweight markdown-to-HTML renderer |
| `descriptionPreview(s, full)` | Strip markdown, return 100-char preview |
| `sortItems(items, mode)` | Sort by priority or date |
| `refreshCurrentView()` | Reload current view |
| `executeSearch(query, container, onSelect)` | Run search and populate results |
| `buildOpencodeUrl(sessionId, dir)` | Build OpenCode deep link |
| `base64UrlEncode(str)` | Encode for OpenCode URL paths |

### Features

- **Kanban board** with configurable state columns and drag-and-drop
- **Card density** modes (compact, normal, expanded)
- **Project themes** (midnight, ocean, forest, sunset, lavender)
- **Real-time status** — session status badges, orchestrator controls
- **Detail panel** — full item editing, markdown descriptions, comments, attachments
- **Triage mode** — card-by-card review workflow for mobile
- **Pull-to-refresh** and swipe actions on mobile
- **Offline support** via service worker

---

## 9. Spaces

Spaces extend work items into purpose-built workspaces. Each item has a `space_type` (default: `standard`) that determines its editing interface.

### Space Types

| Type | Icon | Description |
|---|---|---|
| `standard` | | Default — opens the normal detail panel |
| `song` | | Songwriting workspace — split-pane lyrics editor + conversation + metadata bar |

### How It Works

1. Projects define active space types via `active_spaces` (JSON array)
2. When creating an item, if the project has multiple active spaces, a picker appears
3. Items with `space_type !== "standard"` open a full-screen overlay instead of the detail panel
4. The overlay renders the space-specific layout
5. `space_data` stores arbitrary JSON for space-specific fields (e.g. genre, key, BPM for songs)
6. Description versions enable version history comparison within spaces

### Adding a New Space Type

1. Add the type to the Space Type Registry section in `index.html`
2. Create a renderer function (e.g. `renderSongSpace()`)
3. Register the space in the overlay shell's type dispatch
4. Add any custom fields to `space_data` (no schema migration needed — it's a JSON blob)

---

## 10. Deployment

### Requirements

- Node.js >= 20
- No external database server (SQLite is embedded)
- For orchestrator: a running OpenCode server

### Quick Start

```bash
npm install
cp .env.example .env   # Edit as needed
npm run dev             # Development with hot reload
```

### Production

```bash
npm run build           # Compile TypeScript to dist/
npm start               # Run compiled version
```

### Service Management (macOS launchd)

The tracker runs as a launchd service (`com.tracker.server`):

```bash
# Safe restart (recommended — waits for active sessions)
./scripts/safe-restart.sh
./scripts/safe-restart.sh --build    # Build first, then restart
./scripts/safe-restart.sh --force    # Force restart (skip session check)

# Direct launchctl commands
launchctl kickstart -k gui/$(id -u)/com.tracker.server
launchctl bootout gui/$(id -u)/com.tracker.server
```

### Graceful Shutdown

The process handles `SIGTERM` and `SIGINT`:
1. Stops the orchestrator (clears intervals, closes SSE)
2. Closes the HTTP server (finishes in-flight requests)
3. Force exits after 5 seconds if graceful shutdown hangs

### Work Item Pipeline

```
brainstorming → clarification → brainstorming → approved → in_development → in_review → testing → done
                     ↓                                            ↕
               (research agent)                             needs_input
```

- **brainstorming** — idea phase, defining requirements
- **clarification** — triggers research agent to gather info and refine spec
- **approved** — human-approved, ready for AI dispatch (or manual development)
- **in_development** — actively being worked on (locked by agent or human)
- **in_review** — implementation complete, ready for review
- **testing** — human testing the implementation
- **needs_input** — blocked, waiting for human input
- **done** — completed
- **cancelled** — can be set from any state (human only)

### Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

Tests use Vitest with an in-memory SQLite database. The `_initTestTrackerDatabase()` function creates a fresh DB with all migrations applied for each test suite.

---

## License

[GPLv3](LICENSE)
