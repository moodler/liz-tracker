# Changelog

## [1.1.0] — 2026-03-13

A major feature release adding the **Spaces** system, the **Today** dashboard, **scheduled tasks**, and numerous UX improvements.

### Spaces System

Spaces turn work items into purpose-built workspaces, each with a specialised editing interface.

- **Song space** — Songwriting workspace with split-pane lyrics editor, cover image, Harmoni chat sidebar, version history with back/forward navigation, auto-versioning, and revert capability (TRACK-153)
- **Text space** — Writing workspace for articles, blogs, and long-form content with markdown editor and conversation sidebar (TRACK-154)
- **Engagement space** — Coordination workspace for contractors and external services with structured dashboard (contact, quote, milestones, documents, comms log) and cover image support (TRACK-167, TRACK-169)
- **Scheduled space** — Task scheduling workspace with frequency/time configuration, live status panel, TODO and IGNORE lists, and dedicated MCP tools for managing them (LIZ-103, TRACK-180, TRACK-181, TRACK-183, TRACK-184)
- Space type selector in issue detail panel with white-line SVG icons (TRACK-155)
- Space icon displayed inline with issue key (TRACK-165)
- View toggle between space overlay and standard tracker views (TRACK-153)
- Modal overlay shell with glass-pane aesthetic for all space types

### Today Dashboard

- New **TODAY** view with priority sorting, due date display, and attention section highlighting items needing action (TRACK-176)
- Centred modal layout shared across detail panel and triage overlay (TRACK-176)
- Launch button in control bar for desktop mode (TRACK-176)
- Timezone bug fix for due date comparison (TRACK-176)
- Filter to show only items assigned to the user or unassigned (TRACK-185)
- Testing items prioritised in attention section (TRACK-186)

### MCP Tools & API

- Accept display keys (e.g. `WRITING-28`) in all MCP tools — no more raw IDs required (LIZ-98)
- Human-readable GUI links (url field) included in MCP tool responses (TRACK-187)
- Dedicated MCP tools for scheduled task management: `tracker_add_scheduled_todo`, `tracker_remove_scheduled_todo`, `tracker_add_scheduled_ignore`, `tracker_remove_scheduled_ignore` (TRACK-184)
- Comment webhook for tracker-as-channel communication (LIZ-98)
- Simplified comment webhook routing using `created_by`/`assignee` instead of watchers (TRACK-175)

### Project Management

- Move issues between projects with new sequence number allocation (TRACK-158)
- Due date support for scheduled space items (TRACK-181)
- Sort by `updated_at` instead of `created_at` so state changes count as activity (TRACK-182)

### UX Improvements

- Comments sort-order toggle button in detail view (TRACK-172)
- Comment form moved to top when sort order is newest-first (TRACK-177)
- Reverse history order in standard view to show most recent first (TRACK-162)
- Scroll to last comment when opening issue pane (TRACK-164)
- Copy button for artifact content with inline "Copied!" popup, works in non-secure contexts (TRACK-153)
- Consistent X close icons across all modal windows (TRACK-178)
- Fix modal close on text selection drag outside dialog (TRACK-179)
- Named window target for OpenCode links to reuse same tab (TRACK-166)
- "Agent requested" renamed to "Coder needed" in dashboard UI (LIZ-106)
- Remove "Triage" text from brainstorming column header button (TRACK-157)

### Security & Stability

- Timing-safe token comparison for API authentication (security hardening)
- XSS fix and dead CSS cleanup (security hardening)
- Block "Session restarted." noise phrases from being posted as comments (TRACK-170)
- Fix SVG attachments causing API error on dispatch (LIZ-105)
- Fix tilde expansion in `ASSISTANT_PROJECT_ROOT` and `file_path` for image uploads (TRACK-171)
- Fix scheduled space comment display on iOS/mobile (TRACK-174)
- Defensive sanitization for scheduled task `space_data` (TRACK-184)

### Infrastructure

- Rename `LIZ_PROJECT_ROOT` to `ASSISTANT_PROJECT_ROOT` for generic use

## [1.0.0] — 2026-01-28

Initial release of Liz Tracker.

- Kanban dashboard with drag-and-drop (vanilla JS, dark theme)
- REST API with bearer token authentication
- MCP tools for AI agent integration
- SQLite database with WAL mode
- OpenCode orchestrator for automated code dispatch
- Security hardening: actor classification, approval provenance, description integrity, circuit breaker
- macOS launchd service integration
