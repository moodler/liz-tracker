# Liz Tracker

<p align="center">
  <img src="logo.png" alt="Liz Tracker" width="400">
</p>

## Run your life efficiently from any device

A self-hosted project management tracker with a beautiful kanban UI, purpose-built workspaces, AI agent integration, and an optional orchestrator that automatically dispatches work to AI coding sessions.

Created by [Martin Dougiamas](https://github.com/moodler). I am building this for myself, and development is VERY active. I'm happy to take requests but I'm more focussed on my needs than yours right now! That said, I'm trying to keep it useful for anyone.

## What You Get

### Kanban Dashboard

A dark-themed, drag-and-drop kanban board that works beautifully on desktop, tablet, and phone. Each platform gets its own optimised layout — not just a responsive resize, but a genuinely different touch-friendly UI on mobile. Installable as a PWA so it feels like a native app.

### Spaces — Purpose-Built Workspaces

Work items aren't just tickets. Each item can open into a full-screen workspace tailored to its type:

| Space | What it does |
| --- | --- |
| **Standard** | Classic tracker item — detail panel with description, comments, attachments |
| **Song** | Songwriting workspace — split-pane lyrics editor with version history, conversation sidebar, metadata bar (genre, key, BPM), cover art, and inline CriticMarkup comments |
| **Text** | Writing workspace — markdown editor with conversation sidebar and inline CriticMarkup comments for articles, blogs, or any long-form text |
| **Engagement** | Coordination hub for contractors and services — contact card, quote/financials, milestone timeline, document attachments, communications log, and discussion sidebar |
| **Scheduled** | Recurring task manager — schedule config (daily/weekly/custom cron), live status panel, task instructions, TODO and IGNORE lists, run history |
| **Travel** | Trip planner — day-by-day itinerary with timezone-aware segments (flights, lodging, transport, activities, restaurants, meetings), automatic gap detection, and cover images |
| **Presentation** | Presentation development workspace — 3-tab layout (Description, Slides, Deck) with discussion sidebar and DeckWright integration |

Projects choose which space types are available, and you pick the type when creating an item.

### Work Item Pipeline

Items flow through a clear lifecycle:

```
brainstorming → clarification → approved → in_development → in_review → testing → done
```

- **Brainstorming** — capture ideas and define requirements
- **Clarification** — optionally trigger a research agent to gather info and flesh out the spec
- **Approved** — human-approved and ready for work (or automatic dispatch to AI)
- **In development → In review → Testing → Done** — standard workflow
- **Needs input** — blocked, waiting for human input
- **Cancelled** — archive from any state

### AI Agent Integration

Any MCP-compatible AI agent can manage your tracker programmatically via 50+ tools — create items, update status, add comments, manage travel segments, update engagement milestones, and more. Connect your agent to the MCP endpoint and it can work alongside you.

### AI Orchestrator

Optionally let the tracker automatically dispatch approved work items to AI coding sessions. Two dispatch backends are supported:

- **Session Runner** (`DISPATCH_MODE=runner`) — runs Claude Code directly via the Agent SDK as a child process. No external services needed. Includes a dashboard session viewer with live activity feed, human steering, and persistent transcripts.
- **OpenCode** (`DISPATCH_MODE=opencode`) — dispatches to [OpenCode](https://opencode.ai) sessions via its SDK.

The orchestrator:

- Polls for approved items and creates coding sessions automatically
- Sends research agents to flesh out specs during the clarification phase
- Monitors progress via SSE and updates item status in real time
- **Comment-based auto-completion** — when the owner comments "looks good", "done", "LGTM" etc. on items in testing or in_review, the orchestrator auto-advances them to done
- **Review feedback redispatch** — when the owner leaves non-acknowledgment feedback on items in testing, the orchestrator automatically moves them back to in_review and dispatches a new coder session to address the feedback
- **Scheduled task time gating** — scheduled tasks wait for their configured time/day before dispatching, with timezone-aware checks for daily, weekly, hourly, and monthly frequencies
- **Recurring scheduled task recycling** — when a recurring scheduled task completes, the orchestrator automatically recycles it back to `approved` for the next execution cycle, preserving original human approval provenance
- **Expired scheduled task auto-close** — scheduled tasks with a past due date are automatically moved to done
- **Dashboard session viewer** — watch agent activity in real-time (tool calls, reasoning, errors), send steering messages to redirect the agent, and review session transcripts after completion
- Includes safety features: actor classification (only humans can approve), description integrity checks, circuit breakers, per-item retry limits, and an emergency stop button

### Other Features

- **Comments and discussion** — threaded comments on any item, with inline CriticMarkup in Song and Text spaces
- **Attachments** — upload files and images to any item, including paste-from-clipboard support
- **Dependencies** — link items that block each other
- **Cover images** — visual cover art for Song and Travel items
- **Deep links** — shareable URLs that open directly to any item, with Open Graph meta tags for rich link previews in iMessage, Slack, etc.
- **Activity log** — unified timeline of all mutations (state changes, comments, description edits, attachments) with actor attribution and filtering
- **AI categorization** — one-click AI-powered field extraction from description text
- **Search** — full-text search across all items
- **Today dashboard** — cross-project attention view showing items needing action, with priority sorting and due date display
- **Project reordering** — drag-and-drop project tab ordering
- **Webhook notifications** — optional comment webhook for external integrations
- **LAN access** — accessible from any device on your network, installable as a PWA

---

## Quick Start

```bash
# Install dependencies
npm install

# Copy and edit configuration
cp .env.example .env

# Run in development mode (hot reload)
npm run dev

# Or build and run
npm run build
npm start
```

The server starts on port 1000 by default. Open `http://localhost:1000` for the dashboard.

## Configuration

Copy `.env.example` to `.env` and edit as needed. Key settings:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `1000` | Server port |
| `STORE_DIR` | `./store` | Directory for SQLite database and attachments |
| `OWNER_NAME` | `Owner` | Your display name (used as default assignee) |
| `HUMAN_ACTORS` | `dashboard,me` | Comma-separated names classified as human (can approve items) |
| `AGENT_ACTORS` | `coder` | Comma-separated names classified as AI agents |
| `TRACKER_API_TOKEN` | (auto-generated) | Bearer token for API endpoints |
| `TRACKER_PUBLIC_URL` | `http://localhost:{PORT}` | Tracker dashboard URL (for links and fallback base) |
| `TRACKER_SHORT_URL` | (same as `TRACKER_PUBLIC_URL`) | Short base URL for item deep links (e.g. `http://t` → `http://t/TRACK-187`) |
| `ANTHROPIC_API_KEY` | (none) | Enables AI categorization in the dashboard |
| `AI_CATEGORIZE_MODEL` | `claude-haiku-4-5-20251001` | Model for AI categorization |
| `WEBHOOK_URL` | (none) | URL to POST comment webhook notifications to |
| `WEBHOOK_SECRET` | (none) | Shared secret for authenticating webhook payloads |
| `ASSISTANT_PROJECT_ROOT` | `~/assistant` | Root directory for container path translation (agent file uploads) |

On first run, an API token is auto-generated and saved to `store/auth_token`. See `.env.example` for all options including orchestrator settings.

## Architecture

- **Runtime:** Node.js + TypeScript, vanilla JS frontend (no frameworks)
- **Database:** SQLite with WAL mode — single file, no external dependencies
- **UI:** Pre-compiled from `src/ui/core.html` + `src/ui/spaces/*.js` into a single `index.html`
- **API:** REST at `/api/v1/` + MCP at `/mcp` (Streamable HTTP, stateless)

```
src/
├── index.ts          # Entry point
├── config.ts         # Environment configuration
├── db.ts             # SQLite database layer (schema, CRUD, migrations)
├── api.ts            # HTTP server — REST API + static files + MCP routing + OG meta tag injection
├── mcp-server.ts     # MCP tool definitions (50+ tools, including dynamic space plugin tools)
├── orchestrator.ts   # AI orchestrator — dispatches work to coding sessions, monitors progress
├── session-runner.ts # Session runner — direct Claude Code execution via Agent SDK
├── runner-types.ts   # Shared types for runner stdio JSON protocol
├── logger.ts         # Pino logger
├── spaces/           # Space plugin backends (types, registry, per-space logic)
│   ├── types.ts      # SpacePlugin interface
│   ├── registry.ts   # Plugin registration
│   ├── index.ts      # Registration manifest
│   ├── standard.ts   # Standard space (identity only)
│   ├── song.ts       # Song space backend
│   ├── text.ts       # Text space backend
│   ├── engagement.ts # Engagement space backend (6 routes, 7 MCP tools)
│   ├── scheduled.ts  # Scheduled space backend (4 routes, 4 MCP tools)
│   ├── travel.ts     # Travel space backend (4 routes, 4 MCP tools)
│   └── presentation.ts # Presentation space backend (4 routes, DeckWright integration + thumbnail proxy)
└── ui/
    ├── core.html     # Dashboard shell + plugin registry + overlay
    └── spaces/       # Per-space UI renderers (JS plugins)
```

### Adding a New Space

The space system is fully pluggable — add a new space type with just 2 files + 1 registry line:

1. Create `src/spaces/{name}.ts` — backend (parser, API routes, MCP tools)
2. Create `src/ui/spaces/{name}.js` — frontend renderer
3. Add `registerSpace({name}Plugin)` to `src/spaces/index.ts`
4. Run `npm run build`

No changes needed to `api.ts`, `mcp-server.ts`, `db.ts`, or the UI shell.

## REST API

Write endpoints require `Authorization: Bearer <token>`. Read endpoints are unauthenticated.

### Projects

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/projects` | List all projects |
| `POST` | `/api/v1/projects` | Create a project |
| `PUT` | `/api/v1/projects/reorder` | Reorder project tabs |
| `GET` | `/api/v1/projects/:id` | Get a project |
| `PATCH` | `/api/v1/projects/:id` | Update a project (name, description, context, theme, working_directory, opencode_project_id, orchestration, active_spaces) |
| `DELETE` | `/api/v1/projects/:id` | Delete a project |
| `GET` | `/api/v1/projects/:id/stats` | Get project statistics |
| `GET` | `/api/v1/projects/:id/tracker` | Get kanban-grouped view for a project |

### Work Items

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/items` | List items (filterable by project, state, priority, assignee, search) |
| `POST` | `/api/v1/items` | Create an item |
| `GET` | `/api/v1/items/:id` | Get an item (with comments, transitions, dependencies, attachments) |
| `PATCH` | `/api/v1/items/:id` | Update an item (supports `space_type`, `space_data`, `project_id` for cross-project moves) |
| `DELETE` | `/api/v1/items/:id` | Delete an item |
| `POST` | `/api/v1/items/:id/state` | Transition item state |
| `POST` | `/api/v1/items/:id/lock` | Lock an item |
| `POST` | `/api/v1/items/:id/unlock` | Unlock an item |
| `POST` | `/api/v1/items/clear-stale-locks` | Clear locks older than 2 hours |
| `GET` | `/api/v1/items/recent` | Recently updated items (filterable by project, with limit) |
| `POST` | `/api/v1/items/ai-categorize` | AI-powered field extraction from description text |

### Comments, Dependencies, Attachments

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/items/:id/comments` | List comments |
| `POST` | `/api/v1/items/:id/comments` | Add a comment |
| `PATCH` | `/api/v1/comments/:id` | Update a comment |
| `DELETE` | `/api/v1/comments/:id` | Delete a comment |
| `GET` | `/api/v1/items/:id/dependencies` | List dependencies |
| `POST` | `/api/v1/items/:id/dependencies` | Add a dependency |
| `DELETE` | `/api/v1/items/:id/dependencies/:depId` | Remove a dependency |
| `GET` | `/api/v1/items/:id/attachments` | List attachments |
| `POST` | `/api/v1/items/:id/attachments` | Upload an attachment (JSON with base64 or multipart/form-data) |
| `GET` | `/api/v1/attachments/:id` | Serve attachment file |
| `GET` | `/api/v1/attachments/:id/meta` | Get attachment metadata |
| `DELETE` | `/api/v1/attachments/:id` | Delete an attachment |
| `GET` | `/api/v1/items/:id/transitions` | List state transitions |
| `GET` | `/api/v1/items/:id/watchers` | List watchers |
| `POST` | `/api/v1/items/:id/watchers` | Add a watcher |
| `DELETE` | `/api/v1/items/:id/watchers/:entity` | Remove a watcher |

### Space-Specific Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/items/:id/versions` | Description version history |
| `POST` | `/api/v1/items/:id/versions` | Save a description version snapshot |
| `POST` | `/api/v1/items/:id/versions/revert` | Revert description to a specific version |
| `PUT` | `/api/v1/items/:id/cover` | Set/replace cover image |
| `DELETE` | `/api/v1/items/:id/cover` | Remove cover image |
| `POST` | `/api/v1/items/:id/scheduled/todo` | Add TODO items |
| `DELETE` | `/api/v1/items/:id/scheduled/todo` | Remove TODO items |
| `POST` | `/api/v1/items/:id/scheduled/ignore` | Add IGNORE rules |
| `DELETE` | `/api/v1/items/:id/scheduled/ignore` | Remove IGNORE rules |
| `PATCH` | `/api/v1/items/:id/engagement/contact` | Update engagement contact |
| `PATCH` | `/api/v1/items/:id/engagement/quote` | Update engagement quote/financials |
| `POST` | `/api/v1/items/:id/engagement/milestones` | Add milestones |
| `DELETE` | `/api/v1/items/:id/engagement/milestones` | Remove milestones |
| `POST` | `/api/v1/items/:id/engagement/comms` | Add comms log entries |
| `PATCH` | `/api/v1/items/:id/engagement/settings` | Update engagement settings |
| `PATCH` | `/api/v1/items/:id/travel/trip` | Update travel trip metadata |
| `POST` | `/api/v1/items/:id/travel/segments` | Add travel segments |
| `PATCH` | `/api/v1/items/:id/travel/segments` | Update a travel segment |
| `DELETE` | `/api/v1/items/:id/travel/segments` | Remove travel segments |
| `PATCH` | `/api/v1/items/:id/presentation/deck` | Update deck config (slug + URL) |
| `GET` | `/api/v1/items/:id/presentation/deck-mdx` | Read deck MDX from DeckWright |
| `GET` | `/api/v1/items/:id/presentation/deck-thumbnails` | Fetch slide thumbnails (cached proxy, `?refresh=1` to bust cache) |
| `GET` | `/api/v1/items/:id/presentation/deck-thumb` | Serve a cached slide thumbnail image |

### Activity Log

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/activity` | List recent activity (global, filterable by project, item, action, actor, since, search) |
| `GET` | `/api/v1/projects/:id/activity` | Activity for a specific project |
| `GET` | `/api/v1/items/:id/activity` | Activity for a specific item |

### Cross-Project Views

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/attention` | Items needing attention (cross-project) |
| `GET` | `/api/v1/overview` | Cross-project kanban view with all items |
| `GET` | `/api/v1/search?q=...` | Full-text search across items (supports issue key lookup) |

### Orchestrator

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/orchestrator/status` | Get orchestrator status |
| `POST` | `/api/v1/orchestrator/pause` | Pause the orchestrator |
| `POST` | `/api/v1/orchestrator/resume` | Resume the orchestrator |
| `POST` | `/api/v1/orchestrator/emergency-stop` | Emergency stop |
| `POST` | `/api/v1/orchestrator/restart` | Safe restart |
| `GET` | `/api/v1/orchestrator/restart` | Check restart status |
| `DELETE` | `/api/v1/orchestrator/restart` | Cancel pending restart |
| `GET` | `/api/v1/orchestrator/safe-to-restart` | Check if safe to restart |
| `POST` | `/api/v1/items/:id/dispatch` | Manually dispatch an item |
| `GET` | `/api/v1/items/:id/session` | Get session info for an item |
| `POST` | `/api/v1/items/:id/session/abort` | Abort active session for an item |
| `GET` | `/api/v1/items/:id/session/events` | SSE stream of session events (runner mode) |
| `POST` | `/api/v1/items/:id/session/steer` | Send steering message to running agent (runner mode) |
| `GET` | `/api/v1/items/:id/audits` | Execution audits for an item (includes transcripts) |

### Utility

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/states` | List valid states and priorities |
| `GET` | `/api/v1/config` | Public dashboard configuration |
| `POST` | `/api/v1/auth/verify` | Verify API token |
| `GET` | `/api/v1/auth/status` | Check authentication status |

## MCP Server

The MCP endpoint at `/mcp` (Streamable HTTP, stateless) exposes 50+ tools for AI agents. Connect any MCP-compatible client to `http://localhost:1000/mcp`.

Tools cover: project and item CRUD, state transitions, comments, watchers, dependencies, attachments, orchestrator control (dispatch, abort, emergency stop, safe restart), cover images, agent config validation, agent reference documentation, and all space-specific operations (scheduled TODOs/IGNORE rules, engagement milestones/contacts/quotes/comms/settings, travel segments/trips).

## AI Orchestrator Setup

The orchestrator is disabled by default. Two dispatch backends are available.

### Option A: Session Runner (recommended)

Uses the Claude Agent SDK to run Claude Code directly — no external services needed.

1. **Enable in `.env`:**
   ```
   ORCHESTRATOR_ENABLED=true
   DISPATCH_MODE=runner
   ```

2. **Set a working directory** on each project you want to orchestrate (via project settings in the dashboard).

3. **Ensure Claude Code is installed** and authenticated (the runner uses your Claude Max subscription or API key).

That's it. The tracker spawns Claude Code sessions as child processes and communicates via stdio JSON.

### Option B: OpenCode

Uses [OpenCode](https://opencode.ai) as the session manager.

1. **Install OpenCode** and start the server:
   ```bash
   opencode serve --hostname 0.0.0.0 --port 3000
   ```

2. **Connect OpenCode to the tracker's MCP server** — add to your OpenCode config:
   ```json
   {
     "mcp_servers": {
       "tracker": {
         "type": "http",
         "url": "http://localhost:1000/mcp",
         "enabled": true
       }
     }
   }
   ```

3. **Enable in `.env`:**
   ```
   ORCHESTRATOR_ENABLED=true
   DISPATCH_MODE=opencode
   OPENCODE_SERVER_URL=http://localhost:3000
   ```

4. **Set a working directory** on each project you want to orchestrate (via project settings in the dashboard).

### Orchestrator Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ORCHESTRATOR_ENABLED` | `false` | Master switch |
| `DISPATCH_MODE` | `opencode` | `runner` (direct Claude Code) or `opencode` (OpenCode SDK) |
| `OPENCODE_SERVER_URL` | `http://localhost:3000` | OpenCode server URL for API calls |
| `OPENCODE_PUBLIC_URL` | (same as server URL) | OpenCode URL for browser deep links |
| `ORCHESTRATOR_INTERVAL` | `30000` | Poll interval (ms) |
| `OPENCODE_MAX_CONCURRENT` | `3` | Max concurrent sessions globally |
| `OPENCODE_MAX_PER_PROJECT` | `1` | Max concurrent sessions per project |
| `SESSION_TIMEOUT` | `2700000` | Session timeout (ms, default 45 minutes) |
| `CODER_MODEL_PROVIDER` | `anthropic` | Model provider for coder sessions |
| `CODER_MODEL_ID` | `claude-opus-4-6` | Model ID for coder sessions |
| `CIRCUIT_BREAKER_THRESHOLD` | `2` | Consecutive failures before auto-pause |
| `CIRCUIT_BREAKER_WINDOW` | `3600000` | Failure counting window (ms, default 1 hour) |
| `ITEM_DISPATCH_FAILURE_LIMIT` | `3` | Per-item failures before auto-shelving |

### Safety Features

- **Actor classification** — only human actors can approve items for execution
- **Description integrity** — SHA-256 hash verified at dispatch to detect tampering
- **Circuit breaker** — auto-pauses after consecutive failures
- **Per-item retry limit** — auto-shelves items that fail repeatedly
- **Emergency stop** — dashboard button to pause orchestrator and cancel all sessions
- **Safe restart** — waits for active sessions to complete before restarting
- **Blocked file patterns** — prevents AI agents from modifying security-critical files
- **Execution audits** — full audit trail of every dispatch (item, session, prompt hash, status)
- **Session timeout** — stale sessions auto-detected and aborted (default 45 minutes)
- **Agent config validation** — pre-flight check before dispatch to ensure agent config is valid
- **Session recovery** — on tracker restart, recovers active sessions and polls their status
- **Scheduled task recycling** — recurring scheduled tasks are automatically recycled back to approved after completion, preserving approval provenance
- **Scheduled task time gating** — tasks only dispatch when their configured schedule time arrives (timezone-aware)

## Claude Code Skills, Commands, and Hooks

The project includes custom Claude Code skills, commands, and hooks in `.claude/` that guide both interactive developer sessions and orchestrator-dispatched autonomous sessions.

### Commands

Slash commands available during Claude Code sessions:

| Command | Description |
| --- | --- |
| `/verify` | Comprehensive pre-commit gate — runs `npm run build`, `npm test`, checks for stray `console.log`, and shows `git status` |
| `/code-review` | Security + quality review of uncommitted changes — checks actor classification, `esc()` usage, blocked file paths, and common issues |
| `/build-fix` | Incremental TypeScript error fixer — runs `tsc`, identifies errors, and fixes them with minimal diffs while respecting security-critical file guardrails |

### Skills

Skills in `.claude/skills/` provide domain-specific guidance. They activate automatically based on the work being done, and the orchestrator recommends relevant skills in dispatch prompts based on item content keywords.

| Skill | Origin | Description |
| --- | --- | --- |
| **tdd-workflow** | Adapted from ECC | Test-driven development discipline for Vitest + in-memory SQLite |
| **security-review** | Adapted from ECC | General security checklist — secrets, SQL injection, XSS, auth patterns |
| **search-first** | Adapted from ECC | Research-before-coding workflow, referencing shared helpers and constants |
| **node-sqlite-patterns** | Adapted from ECC | better-sqlite3 patterns — query optimization, schema design, WAL mode |
| **tracker-security-review** | Custom | Project-specific security — actor classification, approval provenance, description integrity, blocked paths, MCP tool authorization |
| **space-plugin-dev** | Custom | Step-by-step guide for building new space plugins (all 5 parts: backend, frontend, registry, MCP tools, tests) |
| **mcp-tool-dev** | Custom | MCP tool development guide — Zod validation, actor handling, naming conventions, error responses |
| **orchestrator-safe-dev** | Custom | Safety guidelines for orchestrator code — state machine, dispatch, SSE, circuit breaker, safe restart |

### Hooks

Project-level hooks in `.claude/settings.json`:

| Hook | Trigger | Description |
| --- | --- | --- |
| **TypeScript type-check** | `PostToolUse:Edit` | Runs `tsc --noEmit` after `.ts` file edits to catch type errors immediately |
| **Console.log detection** | `Stop` | Warns about `console.log` found in modified `.ts` files (should use logger instead) |

### Dispatch Integration

When the orchestrator dispatches an item to a coding session, `buildPrompt()` scans the item's title and description for keywords and injects a "Recommended skills" section into the prompt. This directs the agent to read the relevant `.claude/skills/` files before making changes. Keyword categories:

- **tracker-security-review** — security, auth, actor, approval, provenance, token, credential, etc.
- **orchestrator-safe-dev** — orchestrator, dispatch, session runner, state transition, circuit breaker, SSE, etc.
- **space-plugin-dev** — space plugin, new space, space type, registerSpace, etc.
- **mcp-tool-dev** — MCP tool, MCP server, new tool, add tool, etc.

Multiple skills can be recommended simultaneously when an item matches multiple categories.

### Sub-agent Optimization

Claude Code's Agent tool spawns sub-agents that benefit from Anthropic's prompt caching — the shared system prompt prefix is cached, making sub-agent input tokens ~90% cheaper. This is handled automatically by the `claude_code` system prompt preset used in both interactive and dispatched sessions. CLAUDE.md includes guidance on when sub-agents are most beneficial for this codebase (parallel exploration, research tasks, independent verifications, multi-file impact analysis).

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

Tests use [Vitest](https://vitest.dev/) with an in-memory SQLite database. Test suites cover:

- `src/db.test.ts` — actor classification, state transitions, security rules, project/item CRUD, locks, dependencies, comments, approval provenance, cross-project moves, activity log
- `src/orchestrator.test.ts` — PID-based stale session detection, agent config validation, URL helpers, error classification, scheduled task time gating, prompt splitting
- `src/session-runner.test.ts` — SDK message mapping, stdio protocol integration tests (event flow, steering)
- `src/spaces/travel.test.ts` — type-aware segment deduplication keys

## License

[GPLv3](LICENSE)
