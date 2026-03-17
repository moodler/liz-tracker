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

Any MCP-compatible AI agent can manage your tracker programmatically via 30+ tools — create items, update status, add comments, manage travel segments, update engagement milestones, and more. Connect your agent to the MCP endpoint and it can work alongside you.

### AI Orchestrator

Optionally let the tracker automatically dispatch approved work items to [OpenCode](https://opencode.ai) AI coding sessions. The orchestrator:

- Polls for approved items and creates coding sessions automatically
- Sends research agents to flesh out specs during the clarification phase
- Monitors progress via SSE and updates item status in real time
- Includes safety features: actor classification (only humans can approve), description integrity checks, circuit breakers, per-item retry limits, and an emergency stop button

### Other Features

- **Comments and discussion** — threaded comments on any item, with inline CriticMarkup in Song and Text spaces
- **Attachments** — upload files and images to any item
- **Dependencies** — link items that block each other
- **Cover images** — visual cover art for Song and Travel items
- **Deep links** — shareable URLs that open directly to any item
- **AI categorization** — one-click AI-powered field extraction from description text
- **Search** — full-text search across all items
- **LAN access** — accessible from any device on your network

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
| `TRACKER_API_TOKEN` | (auto-generated) | Bearer token for write API endpoints |
| `ANTHROPIC_API_KEY` | (none) | Enables AI categorization in the dashboard |

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
├── api.ts            # HTTP server — REST API + static files + MCP routing
├── mcp-server.ts     # MCP tool definitions (30+ tools)
├── orchestrator.ts   # AI orchestrator — dispatches work to OpenCode sessions
├── logger.ts         # Pino logger
├── spaces/           # Space plugin backends (types, registry, per-space logic)
│   ├── types.ts      # SpacePlugin interface
│   ├── registry.ts   # Plugin registration
│   ├── index.ts      # Registration manifest
│   ├── song.ts       # Song space backend
│   ├── text.ts       # Text space backend
│   ├── engagement.ts # Engagement space backend (6 routes, 7 MCP tools)
│   ├── scheduled.ts  # Scheduled space backend (4 routes, 4 MCP tools)
│   └── travel.ts     # Travel space backend (4 routes, 4 MCP tools)
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
| `GET` | `/api/v1/projects/:id` | Get a project |
| `PATCH` | `/api/v1/projects/:id` | Update a project |
| `GET` | `/api/v1/projects/:id/stats` | Get project statistics |

### Work Items

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/items` | List items (filterable by project, state, priority) |
| `POST` | `/api/v1/items` | Create an item |
| `GET` | `/api/v1/items/:id` | Get an item |
| `PATCH` | `/api/v1/items/:id` | Update an item (supports `space_type`, `space_data`, `project_id`) |
| `POST` | `/api/v1/items/:id/state` | Transition item state |
| `POST` | `/api/v1/items/:id/lock` | Lock an item |
| `DELETE` | `/api/v1/items/:id/lock` | Unlock an item |

### Comments, Dependencies, Attachments

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/items/:id/comments` | List comments |
| `POST` | `/api/v1/items/:id/comments` | Add a comment |
| `POST` | `/api/v1/items/:id/dependencies` | Add a dependency |
| `DELETE` | `/api/v1/items/:id/dependencies/:depId` | Remove a dependency |
| `GET` | `/api/v1/items/:id/attachments` | List attachments |
| `POST` | `/api/v1/items/:id/attachments` | Upload an attachment |

### Space-Specific Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/items/:id/versions` | Description version history |
| `POST` | `/api/v1/items/:id/versions` | Save a description version snapshot |
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
| `POST` | `/api/v1/items/ai-categorize` | AI-powered field extraction |

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
| `GET` | `/api/v1/items/:id/audits` | Execution audits for an item |

## MCP Server

The MCP endpoint at `/mcp` (Streamable HTTP, stateless) exposes 30+ tools for AI agents. Connect any MCP-compatible client to `http://localhost:1000/mcp`.

Tools cover: project and item CRUD, state transitions, comments, dependencies, attachments, orchestrator control, cover images, and all space-specific operations (scheduled TODOs, engagement milestones/contacts/quotes/comms, travel segments/trips).

## AI Orchestrator Setup

The orchestrator is disabled by default. To enable it:

1. **Install [OpenCode](https://opencode.ai)** and start the server:
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
   OPENCODE_SERVER_URL=http://localhost:3000
   ```

4. **Set a working directory** on each project you want to orchestrate (via project settings in the dashboard).

### Orchestrator Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ORCHESTRATOR_ENABLED` | `false` | Master switch |
| `OPENCODE_SERVER_URL` | `http://localhost:3000` | OpenCode server URL for API calls |
| `OPENCODE_PUBLIC_URL` | (same as server URL) | OpenCode URL for browser deep links |
| `ORCHESTRATOR_INTERVAL` | `30000` | Poll interval (ms) |
| `OPENCODE_MAX_CONCURRENT` | `3` | Max concurrent sessions globally |
| `OPENCODE_MAX_PER_PROJECT` | `1` | Max concurrent sessions per project |

### Safety Features

- **Actor classification** — only human actors can approve items for execution
- **Description integrity** — SHA-256 hash verified at dispatch to detect tampering
- **Circuit breaker** — auto-pauses after consecutive failures
- **Per-item retry limit** — auto-shelves items that fail repeatedly
- **Emergency stop** — dashboard button to pause orchestrator and cancel all sessions
- **Safe restart** — waits for active sessions to complete before restarting
- **Blocked file patterns** — prevents AI agents from modifying security-critical files
- **Execution audits** — full audit trail of every dispatch (item, session, prompt hash, status)

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

Tests use [Vitest](https://vitest.dev/) with an in-memory SQLite database.

## License

[GPLv3](LICENSE)
