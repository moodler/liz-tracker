# Liz Tracker

Standalone project management tracker with kanban UI, REST API, MCP tools, and OpenCode orchestrator.

## Architecture

- **Port:** 1000 (bound to 0.0.0.0 for LAN access)
- **Dashboard:** http://localhost:1000
- **REST API:** http://localhost:1000/api/v1/
- **MCP endpoint:** http://localhost:1000/mcp (Streamable HTTP, stateless)
- **Database:** SQLite at `store/tracker.db` (WAL mode)
- **Service:** launchd `com.tracker.server` (macOS) or run directly

## Key Files

| File | Description |
| --- | --- |
| `src/index.ts` | Entry point — init DB, start server, optionally start orchestrator |
| `src/config.ts` | Config from env vars / `.env` file: PORT, STORE_DIR, TRACKER_PUBLIC_URL, TRACKER_SHORT_URL, OPENCODE_SERVER_URL, OPENCODE_PUBLIC_URL, ORCHESTRATOR_ENABLED, ORCHESTRATOR_INTERVAL, OPENCODE_MAX_CONCURRENT, OPENCODE_MAX_PER_PROJECT |
| `src/logger.ts` | Pino logger with pino-pretty |
| `src/db.ts` | SQLite database layer — schema, CRUD, events, migrations |
| `src/api.ts` | HTTP server — REST API + static file serving + MCP routing |
| `src/mcp-server.ts` | MCP tool definitions using @modelcontextprotocol/sdk |
| `src/orchestrator.ts` | OpenCode orchestrator — dispatches approved items to sessions, monitors via SSE |
| `src/ui/index.html` | Kanban dashboard (vanilla JS, ~13k lines, dark theme, drag-and-drop) |
| `scripts/safe-restart.sh` | Safe restart script — checks for active sessions before restarting |

## Development

```bash
npm run dev          # Run with tsx (hot reload)
npm run build        # Compile TypeScript to dist/
npm run typecheck    # Type-check without emitting
npm start            # Run compiled version
npm test             # Run all tests (MANDATORY before committing)
npm run test:watch   # Watch mode for TDD
npm run test:coverage # Run tests with coverage report
```

### Testing

**Always run `npm test` before committing and pushing.** Tests run automatically via the pre-push hook (`.githooks/pre-push`) when you `git push`.

- Tests use [Vitest](https://vitest.dev/) and run against an in-memory SQLite database
- Test files: `src/**/*.test.ts`
- The `_initTestTrackerDatabase()` function in `db.ts` creates a fresh in-memory DB for each test suite

**Current test coverage:**
- `src/db.test.ts` — actor classification, state transitions (incl. security rules), project/item CRUD, locks, dependencies, comments, approval provenance, move between projects

**To activate the pre-push hook** (run once per clone):
```bash
git config core.hooksPath .githooks
```

## Service Management

```bash
# Safe restart (recommended — waits for active agent sessions to finish)
./scripts/safe-restart.sh
./scripts/safe-restart.sh --build        # Build first, then safe restart
./scripts/safe-restart.sh --force        # Force restart (skip session check)
./scripts/safe-restart.sh --status       # Check if safe to restart

# macOS launchd examples:
launchctl kickstart -k gui/$(id -u)/com.tracker.server
launchctl bootout gui/$(id -u)/com.tracker.server
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tracker.server.plist

# View logs
tail -f logs/tracker.log
tail -f logs/tracker.error.log
```

## Orchestrator

The orchestrator automatically dispatches approved `requires_code` work items to OpenCode sessions.

### Config

All configuration is via `.env` file or environment variables. See `.env.example` for all options.

| Variable | Default | Description |
| --- | --- | --- |
| `TRACKER_PUBLIC_URL` | `http://localhost:{PORT}` | Tracker dashboard URL for the dashboard and fallback base for item links |
| `TRACKER_SHORT_URL` | (same as `TRACKER_PUBLIC_URL`) | Short base URL for **item deep links**. Set to a short hostname (e.g. `http://t`) for the shortest possible links. `buildItemUrl(key)` constructs `{TRACKER_SHORT_URL}/{KEY}` (e.g. `http://t/TRACK-187`). The SPA fallback serves index.html for `/{KEY}` paths, and `handleInitialDeepLink()` in the client JS detects the key in the pathname and opens the item |
| `ORCHESTRATOR_ENABLED` | `false` | Master switch — must be `true` to enable |
| `OPENCODE_SERVER_URL` | `http://localhost:3000` | OpenCode server URL for **orchestrator API calls** |
| `OPENCODE_PUBLIC_URL` | (same as server URL) | OpenCode URL for **browser deeplinks** in the dashboard (can differ from `OPENCODE_SERVER_URL` when browsers reach the server via a different network) |
| `ORCHESTRATOR_INTERVAL` | `30000` | Poll interval (ms) for checking dispatchable items |
| `OPENCODE_MAX_CONCURRENT` | `3` | Max concurrent OpenCode sessions (global across all projects) |
| `OPENCODE_MAX_PER_PROJECT` | `1` | Max concurrent sessions per project (prevents git conflicts within a single repo) |
| `TRACKER_API_TOKEN` | (auto-generated) | Bearer token for write API endpoints |
| `CIRCUIT_BREAKER_THRESHOLD` | `2` | Consecutive failures before auto-pause |
| `CIRCUIT_BREAKER_WINDOW` | `3600000` | Window (ms) for counting failures (1 hour) |
| `ITEM_DISPATCH_FAILURE_LIMIT` | `3` | Per-item failures before auto-shelving to needs_input |

### How it works

**Coder dispatch (state=`approved`):**
1. Every `ORCHESTRATOR_INTERVAL`, the scheduler checks for eligible items (state=`approved`, `requires_code`=true, not locked, not blocked, no active session)
2. Creates an OpenCode session via the SDK (`@opencode-ai/sdk`) with title `{KEY}: {title}`
3. Sends a prompt using the `tracker-worker` agent
4. Monitors session progress via SSE events from `/global/event`
5. Updates `session_status` on the work item: pending → running → completed/failed

**Research dispatch (state=`clarification`):**
1. Every `ORCHESTRATOR_INTERVAL`, the scheduler also checks for items in `clarification` state (not locked, not blocked, no active session)
2. Creates an OpenCode session with title `[Research] {KEY}: {title}`
3. Sends a research prompt (no code changes — read/research/update spec/comment/move back to brainstorming)
4. The research agent updates the description and adds a comment, then moves the item back to `brainstorming`
5. The human reviews the improved spec and approves it for development

### Session lifecycle

- `pending` — Session created, prompt being sent
- `running` — OpenCode is actively working
- `completed` — Session finished, orchestrator cleaned up
- `failed` — Session errored or aborted
- `idle` — Session returned to idle (transitional)
- `waiting_for_permission` — Session paused, waiting for user to grant/deny a permission in OpenCode UI (e.g. external directory access)

### Safety features

- Disabled by default
- Only dispatches `approved` + `requires_code` items
- Respects locks, dependencies, and existing sessions
- Concurrency limit (default 1)
- Safety net: if session exits without unlocking, orchestrator adds a comment and unlocks
- SSE reconnection with exponential backoff

### Security (auto-execution hardening)

Prevents prompt injection attacks from causing the orchestrator to auto-execute malicious tasks. Only human-approved items with verified descriptions get dispatched.

#### Actor classification (`classifyActor()` in db.ts)

Every state transition and item creation records an `actor_class`:

| Actor pattern | Class | Can approve? |
| --- | --- | --- |
| `dashboard`, `me` + `HUMAN_ACTORS` env | `human` | ✅ |
| `coder`, `harmoni` + `AGENT_ACTORS` env | `agent` | ❌ |
| `orchestrator`, `system` | `system` | ❌ |
| anything else | `api` | ❌ |

Only `human`-class actors can move items to `approved` or `cancelled`. Attempts by other actor classes throw an error (403 from API, error from MCP).

**MCP enforcement:** All items created via MCP tools have `created_by` forced to `"Harmoni"` (TRACK-213). This prevents agents from impersonating human actors (e.g. passing `created_by: "dashboard"`) to bypass actor classification. Similarly, state changes via MCP force `actor_class = "agent"` (LIZ-57).

**Exception:** Comment-only items (`requires_code=0`) can be approved by agents. Since they don't grant code access, they don't present a security risk. This allows multiple agents to discuss and take turns on an issue without requiring human re-approval on every turn.

#### Approval provenance

When an item is moved to `approved`, the system records:
- `approved_by` — the actor name
- `approved_by_class` — must be `human` (or `agent` for comment-only items)
- `approved_at` — ISO timestamp
- `approved_description_hash` — SHA-256 of the description at approval time

#### Description integrity

At dispatch time, `getDispatchableItems()` verifies:
1. `approved_by_class = 'human'` — item was approved by a human (comment-only items are exempt from this check)
2. SHA-256 of current description matches `approved_description_hash` — description hasn't been tampered with since approval

If either check fails, the item is silently excluded from dispatch.

#### Prompt hardening

The orchestrator's `buildPrompt()` injects security rules into every coder bot prompt:
- Coder bots must not modify security-critical files (see blocked paths in `config.ts`)
- Coder bots must not create new tracker items or approve items
- Coder bots must not modify tracker infrastructure
- Comments added after approval are segregated and labeled as "post-approval" in the prompt

#### Blocked file patterns

Defined in `config.ts` as `BLOCKED_PATHS`. Includes paths like `src/db.ts`, `src/api.ts`, `src/orchestrator.ts`, `src/mcp-server.ts`, `src/config.ts`, `.env`, `CLAUDE.md`, etc. — anything that could undermine security if modified by a coder bot.

#### Circuit breaker

If 2 consecutive dispatches fail within 1 hour (configurable via `CIRCUIT_BREAKER_THRESHOLD` and `CIRCUIT_BREAKER_WINDOW`), the orchestrator auto-pauses and logs a warning. Resuming the orchestrator resets the circuit breaker.

Note: Image-too-large errors (e.g. oversized attachments) count toward the circuit breaker even though other 413/context-length errors are exempt (since image size never self-heals via compaction).

#### Per-item retry limit

If a single work item fails dispatch `ITEM_DISPATCH_FAILURE_LIMIT` times (default: 3), the orchestrator auto-moves it to `needs_input` and stops retrying. This prevents a single broken item (e.g. oversized attachment) from looping indefinitely. The counter resets when the item is re-approved (e.g. after fixing the underlying issue).

#### Emergency stop

- **API:** `POST /api/v1/orchestrator/emergency-stop` — pauses orchestrator + cancels all active sessions
- **MCP:** `tracker_emergency_stop` tool
- **Dashboard:** Red 🛑 STOP button in the topbar (visible when sessions are active)

#### Safe restart

When working on the tracker itself, agents must use the safe restart mechanism to avoid interrupting other agents' active sessions. The system checks for active OpenCode sessions before allowing a restart.

**How it works:**
1. Checks for active agent sessions (in-memory + database)
2. If no sessions: restarts immediately via `launchctl kickstart -k`
3. If sessions exist: pauses the orchestrator (no new dispatches), polls every 5s until sessions complete, then restarts
4. 30-minute timeout — if sessions haven't completed, the restart is cancelled and the orchestrator is resumed
5. Graceful shutdown handler ensures clean exit on SIGTERM (closes SSE, stops polling)

**Methods:**
- **Shell script:** `./scripts/safe-restart.sh` (recommended) — builds, checks, and restarts
- **API:** `POST /api/v1/orchestrator/restart` with body `{"wait": true, "reason": "...", "force": false}`
- **API:** `GET /api/v1/orchestrator/restart` — check restart status
- **API:** `GET /api/v1/orchestrator/safe-to-restart` — quick safety check
- **API:** `DELETE /api/v1/orchestrator/restart` — cancel a pending restart
- **MCP:** `tracker_safe_restart` — request a safe restart
- **MCP:** `tracker_restart_status` — check if safe to restart / pending restart status
- **MCP:** `tracker_cancel_restart` — cancel a pending restart

**Important:** Agents working on the tracker should NEVER use `launchctl kickstart -k` directly. Always use `./scripts/safe-restart.sh` or the `tracker_safe_restart` MCP tool.

#### Execution audits

Table `tracker_execution_audits` records every dispatch:
- `item_id`, `session_id`, `started_at`, `completed_at`
- `description_hash` — hash of description at dispatch time
- `prompt_hash` — hash of the full prompt sent to the coder bot
- `status` — `running`, `completed`, `failed`
- **API:** `GET /api/v1/items/:id/audits` — retrieve audits for an item

#### API authentication

Write endpoints (POST, PUT, PATCH, DELETE) require a bearer token:
- Set via `TRACKER_API_TOKEN` env var or `.env` file
- Header: `Authorization: Bearer <token>`
- GET/read endpoints remain unauthenticated
- If no token is configured, one is auto-generated on first run

### API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/v1/items/:id/dispatch` | Manually dispatch an item |
| `GET` | `/api/v1/items/:id/session` | Get session info for an item |
| `GET` | `/api/v1/orchestrator/status` | Get orchestrator status |
| `POST` | `/api/v1/orchestrator/pause` | Pause the orchestrator |
| `POST` | `/api/v1/orchestrator/resume` | Resume the orchestrator |
| `POST` | `/api/v1/orchestrator/emergency-stop` | Emergency stop — pause + cancel all sessions |
| `GET` | `/api/v1/items/:id/audits` | Get execution audits for an item |
| `GET` | `/api/v1/orchestrator/restart` | Check restart status and safety |
| `POST` | `/api/v1/orchestrator/restart` | Request a safe restart (wait/force options) |
| `DELETE` | `/api/v1/orchestrator/restart` | Cancel a pending restart |
| `GET` | `/api/v1/orchestrator/safe-to-restart` | Quick check if restart is safe |

### MCP Tools

| Tool | Description |
| --- | --- |
| `tracker_dispatch_item` | Manually dispatch a work item to OpenCode |
| `tracker_get_session_status` | Get session status for an item |
| `tracker_orchestrator_status` | Get orchestrator status |
| `tracker_emergency_stop` | Emergency stop — pause + cancel all sessions |
| `tracker_safe_restart` | Safely restart the tracker (waits for active sessions) |
| `tracker_restart_status` | Check restart safety and pending restart status |
| `tracker_cancel_restart` | Cancel a pending restart request |
| `tracker_add_scheduled_todo` | Add TODO items to a scheduled task (simple string array) |
| `tracker_remove_scheduled_todo` | Remove TODO items from a scheduled task by index |
| `tracker_add_scheduled_ignore` | Add IGNORE rules to a scheduled task (simple string array) |
| `tracker_remove_scheduled_ignore` | Remove IGNORE rules from a scheduled task by index |
| `tracker_update_engagement_contact` | Update contact/contractor details on an engagement item (partial update) |
| `tracker_update_engagement_quote` | Update quote/financial details on an engagement item (partial update) |
| `tracker_add_engagement_milestone` | Add milestones to an engagement item |
| `tracker_remove_engagement_milestone` | Remove milestones from an engagement item by index |
| `tracker_update_engagement_milestone` | Update an existing milestone's label, date, or status |
| `tracker_add_engagement_comms` | Add communication log entries to an engagement item |
| `tracker_update_engagement_settings` | Update engagement settings (gmail_query, calendar_tag) |
| `tracker_set_cover_image` | Set/replace cover image on a song or engagement item (base64 data) |
| `tracker_set_cover_image_from_path` | Set/replace cover image from a local file path |
| `tracker_remove_cover_image` | Remove cover image from a song or engagement item |

### Per-project setup

Each tracker project needs a `working_directory` set (via project settings in the dashboard, or `PATCH /api/v1/projects/:id`). This tells the orchestrator which directory to use when creating OpenCode sessions.

### Deep links

OpenCode session URLs use the format `{OPENCODE_PUBLIC_URL}/{base64url(directory)}/session/{session_id}`. The OpenCode server serves the SPA for any path not matching a known API route, so the client-side router handles navigation. The SPA's SolidJS router expects `/:dir/session/:id` — the `{directory}` is the project's `working_directory`, base64url-encoded (standard base64 with `+` → `-`, `/` → `_`, padding stripped). **Do NOT include `/s/` in the path** — the SPA router has no base path prefix, so adding `/s/` causes the router to misinterpret `s` as the `:dir` parameter and redirect to the home page. These links appear in the tracker dashboard on cards with active sessions.

**URL helpers** (in `config.ts`):

| Helper | Format | Purpose |
| --- | --- | --- |
| `buildItemUrl(key)` | `{TRACKER_SHORT_URL}/{KEY}` | Shortest deep link to a tracker work item (SPA fallback serves index.html, client-side `handleInitialDeepLink()` opens the item) |
| `buildOpencodeSessionUrl(id, dir)` | `{PUBLIC_URL}/{b64dir}/session/{id}` | Link to a specific session |
| `buildOpencodeDirectoryUrl(dir)` | `{PUBLIC_URL}/{b64dir}/session` | Link to project session list |
| `buildOpencodeApiSessionUrl(dir)` | `{SERVER_URL}/session?directory={dir}` | Server-side API endpoint |

**Deep link dispatch evaluation:** Deep links are for *viewing* sessions in the browser, not for *creating* them programmatically. The OpenCode SPA's route `/:dir/session/:id?` has an optional ID parameter, but navigating to `/:dir/session` (no ID) simply shows the session list — it does not create a new session. Automated dispatch must use the SDK API (`session.create` + `session.promptAsync`). The dual-URL architecture (`OPENCODE_SERVER_URL` for API calls, `OPENCODE_PUBLIC_URL` for browser links) remains necessary because the tracker process and browsers may be on different networks.

**Dispatch response includes deep links:** When `dispatchItem()` creates a session, it returns an `opencodeUrl` deep link alongside the session ID. The dashboard's "Run Now" button shows a clickable "Open in OpenCode" link after dispatch, and the orchestrator logs the deep link URL for each dispatch for observability.

## States Pipeline

```
brainstorming → clarification → brainstorming → approved → in_development → in_review → testing → done
                     ↓                                            ↕
               (research agent)                             needs_input
                     ↓
               [updates spec, adds comment]
```

Also: `cancelled` (can be set from any state)

### The `clarification` state — Research Agent Flow

Moving a work item from `brainstorming → clarification` triggers the orchestrator to dispatch a **research agent** (not a coder). The research agent will:

1. Read relevant source files and/or fetch documentation
2. **Update the item description** with a concrete implementation spec
3. **Add a comment** summarising findings, recommended approach, estimated complexity
4. Move the item back to `brainstorming` when done

The human then reviews the improved spec and either:
- Approves the item for development (`brainstorming → approved`)
- Refines it further and sends it back to `clarification`

**Note:** The orchestrator also moves items to `clarification` automatically when it detects a description was modified after approval. In that case the human must re-approve from the dashboard.

## Spaces

Spaces turn work items into purpose-built workspaces. Each item has a `space_type` field (default: `standard`) that determines its editing interface.

### Database Fields

- `work_items.space_type` — Space type name (e.g. `standard`, `song`). Default: `standard`
- `work_items.space_data` — JSON blob for space-specific custom fields (e.g. song metadata: genre, key, BPM)
- `projects.active_spaces` — JSON array of active space types for this project (e.g. `["standard","song"]`)
- `tracker_description_versions` table — Version history of item descriptions (used by the Song space's version selector)

### Space Types

| Type | Icon | Description |
| --- | --- | --- |
| `standard` | document (SVG) | Default tracker view — opens the normal detail panel |
| `song` | music note (SVG) | Songwriting workspace — split-pane lyrics editor + conversation + metadata bar |
| `text` | text lines (SVG) | Writing workspace — markdown editor + conversation for articles, blogs, long-form text |
| `engagement` | briefcase (SVG) | Coordination workspace for contractors, services, and external engagements — structured dashboard (contact, quote, milestones, documents, comms log) + discussion sidebar. Uses `space_data` JSON for all structured content. |
| `scheduled` | clock (SVG) | Scheduled task workspace — schedule config (frequency, time, days), live status panel (next/last run, run count), task instructions editor, TODO list, IGNORE list + run history sidebar. Used by the HARMONI project for recurring automated tasks. `space_data` stores a JSON string (see format below). |

#### Scheduled Task `space_data` Format

When updating a scheduled task's `space_data` via MCP tools or the API, the value must be a **JSON string** with this exact structure:

```json
{
  "schedule": {
    "frequency": "daily",
    "time": "07:00",
    "days_of_week": null,
    "timezone": "Australia/Perth",
    "cron_override": null
  },
  "status": {
    "next_run": null,
    "last_run": null,
    "last_status": null,
    "last_duration_ms": null,
    "run_count": 0
  },
  "todo": ["plain string task 1", "plain string task 2"],
  "ignore": ["plain string rule 1", "plain string rule 2"]
}
```

**Critical rules:**
- `todo` and `ignore` must be arrays of **plain strings** — never objects. Using objects like `{"text": "task"}` will cause `[object Object]` to display in the UI.
- Always include **all four top-level keys** (`schedule`, `status`, `todo`, `ignore`). The entire `space_data` is replaced on update, not merged.
- To update just the `todo` list: first GET the item to read the current `space_data`, parse it, modify the `todo` array, then PUT/PATCH back the full JSON string.
- `frequency` options: `"once"`, `"hourly"`, `"daily"`, `"weekly"`, `"monthly"`, `"manual"`, `"custom"` (with `cron_override`).
- `days_of_week` is only used when `frequency` is `"weekly"`: an array of lowercase day names like `["monday", "wednesday", "friday"]`.

**Preferred: Use dedicated MCP tools instead of raw `space_data` updates.**

Agents should use these simpler tools instead of constructing `space_data` JSON manually:

| MCP Tool | Description |
| --- | --- |
| `tracker_add_scheduled_todo` | Add TODO items — pass `item_id` and `items` (array of strings) |
| `tracker_remove_scheduled_todo` | Remove TODO items — pass `item_id` and `indices` (array of index numbers) |
| `tracker_add_scheduled_ignore` | Add IGNORE rules — pass `item_id` and `rules` (array of strings) |
| `tracker_remove_scheduled_ignore` | Remove IGNORE rules — pass `item_id` and `indices` (array of index numbers) |

These tools handle the GET→parse→modify→save cycle internally and only accept plain strings, making it impossible to accidentally create `[object Object]` entries.

#### Engagement `space_data` Format

Engagement items store structured data in `space_data` as a JSON string:

```json
{
  "contractor": { "company": "", "contact": "", "phone": "", "mobile": "", "email": "", "address": "" },
  "quote": { "reference": "", "date": "", "expiry": "", "status": "pending", "total": 0, "currency": "AUD", "includes_gst": true, "line_items": [{ "desc": "Item description", "amount": 100.00 }] },
  "payment": { "status": "not_started", "deposits": [], "invoices": [] },
  "milestones": [{ "label": "Milestone name", "date": "2026-03-15", "status": "upcoming" }],
  "gmail_query": "from:email OR to:email",
  "calendar_tag": "ISSUE-KEY",
  "comms_log": [{ "direction": "inbound", "date": "2026-03-15", "subject": "Subject line", "snippet": "Brief excerpt" }]
}
```

**Preferred: Use dedicated MCP tools instead of raw `space_data` updates.**

Agents should use these simpler tools instead of constructing `space_data` JSON manually:

| MCP Tool | Description |
| --- | --- |
| `tracker_update_engagement_contact` | Update contact details — pass individual fields (`company`, `contact`, `phone`, `mobile`, `email`, `address`). Only provided fields are updated. |
| `tracker_update_engagement_quote` | Update quote/financial — pass individual fields (`reference`, `total`, `currency`, `status`, `line_items`, `payment_status`). Only provided fields are updated. |
| `tracker_add_engagement_milestone` | Add milestones — pass `milestones` array of `{ label, date?, status? }` objects |
| `tracker_remove_engagement_milestone` | Remove milestones — pass `indices` array of index numbers |
| `tracker_update_engagement_milestone` | Update a milestone — pass `index` and the fields to change |
| `tracker_add_engagement_comms` | Add comms log entries — pass `entries` array of `{ direction, date, subject, snippet? }` |
| `tracker_update_engagement_settings` | Update `gmail_query` and `calendar_tag` |

These tools handle the GET→parse→modify→save cycle internally, so agents never need to construct the full `space_data` JSON.

### API Endpoints

- `PATCH /items/:id` — accepts `space_type`, `space_data`, and `project_id` fields. Passing `project_id` moves the item to another project (allocates new seq_number, resets space if needed).
- `PATCH /projects/:id` — accepts `active_spaces` field (JSON array)
- `GET /items/:id/versions` — returns description version history
- `POST /items/:id/versions` — save a description version snapshot
- `POST /items/:id/scheduled/todo` — add TODO items (`{ items: ["string1", "string2"] }`)
- `DELETE /items/:id/scheduled/todo` — remove TODO items (`{ indices: [0, 2] }`)
- `POST /items/:id/scheduled/ignore` — add IGNORE rules (`{ rules: ["rule1"] }`)
- `DELETE /items/:id/scheduled/ignore` — remove IGNORE rules (`{ indices: [0] }`)
- `PATCH /items/:id/engagement/contact` — update engagement contact details (`{ company?, contact?, phone?, ... }`)
- `PATCH /items/:id/engagement/quote` — update engagement quote/financial (`{ reference?, total?, currency?, line_items?, payment_status?, ... }`)
- `POST /items/:id/engagement/milestones` — add engagement milestones (`{ milestones: [{ label, date?, status? }] }`)
- `DELETE /items/:id/engagement/milestones` — remove engagement milestones (`{ indices: [0, 2] }`)
- `POST /items/:id/engagement/comms` — add engagement comms log (`{ entries: [{ direction, date, subject, snippet? }] }`)
- `PATCH /items/:id/engagement/settings` — update engagement settings (`{ gmail_query?, calendar_tag? }`)
- `PUT /items/:id/cover` — set/replace cover image on song or engagement items (multipart/form-data or JSON with base64 `data`)
- `DELETE /items/:id/cover` — remove cover image from song or engagement items

### UI Sections

- `// ── Space: Type Registry ──` — Space type definitions
- `// ── Space: Overlay Shell ──` — Modal overlay container (glass-pane dialog with ~30px border), open/close logic
- `// ── Space: Song ──` — Song space renderer (lyrics pane, conversation, metadata bar)
- `// ── Space: Text ──` — Text space renderer (markdown editor, conversation)
- `// ── Space: Engagement ──` — Engagement space renderer (contact card, quote/financial, milestones, documents, comms log + discussion sidebar)
- `// ── Space: Scheduled ──` — Scheduled task space renderer (schedule config, status panel, task instructions + run history sidebar)

### How It Works

1. Projects define which space types are active via project settings
2. When creating an item, if the project has multiple active spaces, a space type picker appears
3. When opening an item with `space_type !== "standard"`, a modal dialog opens instead of the detail panel (glass-pane aesthetic with ~30px border, rounded edges, tracker visible behind)
4. The modal renders the space-specific layout (e.g. Song space with lyrics + conversation + metadata)
5. Standard items behave exactly as before — zero regression

## Conventions

- Database tables are prefixed with `tracker_` (projects, work_items, comments, transitions, watchers, dependencies)
- All IDs are random hex strings (24 chars)
- Timestamps are ISO 8601 strings
- Work items have sequential keys per project (e.g. LIZ-1, LIZ-2)
- The MCP server runs in stateless mode (new server+transport per request)
- Orchestrator-spawned sessions use `actor="Coder"` for state changes

## Dashboard UI Code Organization

The dashboard (`src/ui/index.html`) is a single vanilla JS file (~13k lines) wrapped in an IIFE. No frameworks, no build step.

### Navigation

The code is organized into ~52 sections, each marked with a comment header:
```js
// ── Section Name ──
```
When adding new features, always add a section header. Use grep for `// ──` to list all sections.

### Shared Helpers & Constants

Reusable utilities are in the **"Shared Helpers"** section (line ~6941). Check here before writing new utility code:

| Helper | Purpose |
| --- | --- |
| `esc(s)` | HTML-escape a string |
| `agentStatusHtml(status)` | Render session status emoji badge for cards |
| `renderMarkdown(md)` | Lightweight markdown → HTML renderer |
| `descriptionPreview(s, full)` | Strip markdown, return plain-text preview (100 chars) |
| `sortItems(items, mode)` | Sort items array by priority or date |
| `refreshCurrentView()` | Reload the current view (tracker, attention, or today dashboard) |
| `renderSearchResultItem(item)` | Render a search result list item HTML |
| `executeSearch(query, container, onSelect)` | Run search and populate results container |
| `buildOpencodeUrl(sessionId, dir)` | Build OpenCode deep link URL |
| `base64UrlEncode(str)` | Encode string to base64url (for OpenCode directory paths) |

Shared constants (defined near the top of the JS, line ~6657):

| Constant | Purpose |
| --- | --- |
| `PRIORITY_ORDER` | Maps priority names to sort order (`{ urgent: 0, high: 1, ... }`) |
| `SESSION_STATUS_MAP` | Maps session status strings to `{ emoji, tooltip }` for card badges |
