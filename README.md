# Liz Tracker

<p align="center">
  <img src="logo.png" alt="Liz Tracker" width="400">
</p>

A lightweight, self-hosted project management tracker with a kanban UI, REST API, MCP tools for AI agents, and an optional orchestrator that automatically dispatches approved work items to AI coding sessions.

Created by [Martin Dougiamas](https://github.com/moodler). Built with TypeScript, SQLite, and vanilla JS. No frameworks, no build step for the frontend.

## Features

- **Kanban dashboard** — drag-and-drop board with dark theme, installable as a PWA
- **REST API** — full CRUD for projects, work items, comments, attachments, dependencies
- **MCP server** — 30 tools for AI agents to manage work items programmatically (Streamable HTTP)
- **AI orchestrator** — automatically dispatches approved items to [OpenCode](https://opencode.ai) coding sessions, monitors progress via SSE, and handles failures with circuit breakers and per-item retry limits
- **Spaces** — extensible full-screen workspaces (e.g. a songwriting space with lyrics editor + conversation)
- **Security hardening** — actor classification, approval provenance, description integrity checks, and blocked file patterns to prevent prompt injection in auto-executed tasks
- **SQLite with WAL** — single-file database, no external dependencies

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

Copy `.env.example` to `.env` and edit as needed:

```bash
cp .env.example .env
```

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `1000` | Server port |
| `STORE_DIR` | `./store` | Directory for SQLite database and attachments |
| `OWNER_NAME` | `Owner` | Your display name (used as default assignee) |
| `HUMAN_ACTORS` | `dashboard,me` | Comma-separated names classified as human (can approve items) |
| `AGENT_ACTORS` | `coder` | Comma-separated names classified as AI agents |
| `TRACKER_API_TOKEN` | (auto-generated) | Bearer token for write API endpoints |

Environment variables override `.env` values. On first run, an API token is auto-generated and saved to `store/auth_token`. See `.env.example` for the full list of options.

## Architecture

```
src/
├── index.ts          # Entry point — init DB, start server
├── config.ts         # Environment variable configuration
├── db.ts             # SQLite database layer (schema, CRUD, migrations)
├── api.ts            # HTTP server — REST API + static files + MCP routing
├── mcp-server.ts     # MCP tool definitions (30 tools)
├── orchestrator.ts   # AI orchestrator — dispatches work to OpenCode sessions
├── logger.ts         # Pino logger
└── ui/
    └── index.html    # Kanban dashboard (vanilla JS, single file)
```

## Work Item Pipeline

```
brainstorming → clarification → brainstorming → approved → in_development → in_review → testing → done
                     ↓                                            ↕
               (research agent)                             needs_input
```

- **brainstorming** — idea phase, defining requirements
- **clarification** — triggers a research agent to gather info and refine the spec
- **approved** — human-approved and ready for development (dispatched by orchestrator)
- **in_development** → **in_review** → **testing** → **done** — standard dev workflow
- **needs_input** — blocked, waiting for human input
- **cancelled** — can be set from any state

## API

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
| `PATCH` | `/api/v1/items/:id` | Update an item |
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

### Orchestrator

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/v1/orchestrator/status` | Get orchestrator status |
| `POST` | `/api/v1/orchestrator/pause` | Pause the orchestrator |
| `POST` | `/api/v1/orchestrator/resume` | Resume the orchestrator |
| `POST` | `/api/v1/orchestrator/emergency-stop` | Emergency stop |
| `POST` | `/api/v1/orchestrator/restart` | Safe restart |

## MCP Server

The MCP endpoint at `/mcp` (Streamable HTTP, stateless) exposes tools for AI agents to interact with the tracker. Connect any MCP-compatible client to `http://localhost:1000/mcp`.

Tools include: project and item CRUD, state transitions, comments, dependencies, attachments, orchestrator control, and more.

## AI Orchestrator

The orchestrator automatically dispatches approved work items to [OpenCode](https://opencode.ai) AI coding sessions. It is disabled by default.

### Prerequisites

The orchestrator requires a running [OpenCode](https://opencode.ai) server. OpenCode is an open-source AI coding assistant that manages sessions, runs agents, and streams events via SSE.

1. **Install OpenCode** — follow the instructions at [opencode.ai](https://opencode.ai)

2. **Start the OpenCode server:**
   ```bash
   opencode serve --hostname 0.0.0.0 --port 3000
   ```

3. **Connect OpenCode to the tracker's MCP server** — add the tracker as an HTTP MCP server in your OpenCode config (`~/.config/opencode/config.json` or equivalent):
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

4. **Enable the orchestrator** in your `.env`:
   ```
   ORCHESTRATOR_ENABLED=true
   OPENCODE_SERVER_URL=http://localhost:3000
   ```

5. **Set a working directory** on each project you want to orchestrate (via project settings in the dashboard, or `PATCH /api/v1/projects/:id` with `working_directory`). This tells the orchestrator which directory to use when creating OpenCode sessions.

### Orchestrator configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ORCHESTRATOR_ENABLED` | `false` | Master switch |
| `OPENCODE_SERVER_URL` | `http://localhost:3000` | OpenCode server URL for API calls |
| `OPENCODE_PUBLIC_URL` | (same as server URL) | OpenCode URL for browser deep links (if different from API URL) |
| `ORCHESTRATOR_INTERVAL` | `30000` | Poll interval (ms) |
| `OPENCODE_MAX_CONCURRENT` | `3` | Max concurrent sessions globally |
| `OPENCODE_MAX_PER_PROJECT` | `1` | Max concurrent sessions per project |
| `CODER_MODEL_PROVIDER` | `anthropic` | AI model provider |
| `CODER_MODEL_ID` | `claude-opus-4-6` | AI model ID |

### How it works

1. Polls for eligible items (state=`approved`, `requires_code=true`, not locked/blocked)
2. Creates an OpenCode session and sends a prompt with the work item details
3. Monitors progress via SSE events
4. Updates item status as the session progresses

### Safety features

- **Actor classification** — only human actors can approve items for execution
- **Description integrity** — SHA-256 hash verified at dispatch time to detect tampering
- **Circuit breaker** — auto-pauses after consecutive failures
- **Per-item retry limit** — auto-shelves items that fail repeatedly
- **Emergency stop** — pauses orchestrator and cancels all active sessions
- **Safe restart** — waits for active sessions to complete before restarting

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

Tests use [Vitest](https://vitest.dev/) with an in-memory SQLite database.

## License

[GPLv3](LICENSE)
