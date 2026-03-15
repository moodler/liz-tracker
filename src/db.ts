/**
 * Tracker Database Layer
 *
 * SQLite schema and data access functions for the project tracker.
 * Standalone module — no external dependencies beyond better-sqlite3.
 */

import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { STORE_DIR, HUMAN_ACTORS, AGENT_ACTORS, OWNER_NAME } from "./config.js";
import { logger } from "./logger.js";

let db: Database.Database;

// ── Types ──

export interface Project {
  id: string;
  name: string;
  short_name: string;
  description: string;
  context: string; // Project-level context injected into every agent prompt
  theme: string;
  next_seq: number;
  working_directory: string;
  opencode_project_id: string;
  tab_order: number;
  orchestration: number; // 0 or 1 (SQLite boolean) — whether orchestrator manages this project
  active_spaces: string; // JSON array of active space types (e.g. '["standard","song"]')
  created_at: string;
  updated_at: string;
}

export const VALID_STATES = [
  "brainstorming",
  "clarification",
  "approved",
  "in_development",
  "in_review",
  "needs_input",
  "testing",
  "done",
  "cancelled",
] as const;

export type WorkItemState = (typeof VALID_STATES)[number];

export const STATE_GROUPS: Record<string, WorkItemState[]> = {
  unstarted: ["brainstorming", "clarification"],
  started: [
    "approved",
    "in_development",
    "in_review",
    "needs_input",
    "testing",
  ],
  completed: ["done"],
  cancelled: ["cancelled"],
};

export const VALID_PRIORITIES = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
] as const;
export type Priority = (typeof VALID_PRIORITIES)[number];

export const VALID_PLATFORMS = ["any", "server", "ios", "web"] as const;
export type Platform = (typeof VALID_PLATFORMS)[number];

// ── Actor Classification (Section 4.2) ──

export type ActorClass = "human" | "agent" | "system" | "api";

/**
 * Classify an actor string into an actor class.
 * - Human actors are configured via HUMAN_ACTORS in config (default: "dashboard", "me")
 * - Agent actors are configured via AGENT_ACTORS in config (default: "coder", "harmoni")
 * - "orchestrator", "system", "health-check" → system
 * - Unknown actors default to "api" (conservative — blocked from approval)
 *
 * Add custom human/agent names via env vars: HUMAN_ACTORS="alice,bob" AGENT_ACTORS="my-bot"
 */
export function classifyActor(actor: string): ActorClass {
  const lower = actor.toLowerCase();

  // Human actors — dashboard UI or configured human identifiers
  if (HUMAN_ACTORS.includes(lower)) return "human";

  // Agent actors — AI/bot identifiers
  if (AGENT_ACTORS.includes(lower)) return "agent";

  // System actors — automated internal processes
  if (["orchestrator", "system", "health-check", "scheduler"].includes(lower))
    return "system";

  // API / unknown — conservative default (cannot approve)
  return "api";
}

export interface WorkItem {
  id: string;
  project_id: string;
  title: string;
  description: string;
  state: WorkItemState;
  priority: Priority;
  assignee: string | null;
  labels: string; // JSON array
  position: number;
  seq_number: number;
  requires_code: number; // 0 or 1 (SQLite boolean)
  bot_dispatch: number; // 0 or 1 (SQLite boolean) — whether to dispatch to bot
  platform: Platform;
  date_due: string | null; // ISO 8601 date string (YYYY-MM-DD) or null
  link: string | null; // Optional URL associated with this item
  space_type: string; // Space type (e.g. "standard", "song", "text", "engagement")
  space_data: string | null; // JSON blob for space-specific custom fields
  locked_by: string | null;
  locked_at: string | null;
  session_id: string | null;
  session_status: string | null;
  opencode_pid: number | null;
  created_by: string;
  created_by_class: ActorClass;
  approved_by: string | null;
  approved_by_class: ActorClass | null;
  approved_at: string | null;
  approved_description_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  work_item_id: string;
  author: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Transition {
  id: string;
  work_item_id: string;
  from_state: WorkItemState | null;
  to_state: WorkItemState;
  actor: string;
  actor_class: ActorClass;
  comment: string | null;
  created_at: string;
}

export interface Watcher {
  id: string;
  work_item_id: string;
  entity: string;
  notify_via: string;
  created_at: string;
}

export interface Dependency {
  id: string;
  work_item_id: string; // this item is blocked...
  depends_on_id: string; // ...by this item
  created_at: string;
}

export interface Attachment {
  id: string;
  work_item_id: string;
  comment_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string; // Relative path within STORE_DIR
  uploaded_by: string;
  created_at: string;
}

export interface DescriptionVersion {
  id: string;
  work_item_id: string;
  version: number;
  description: string;
  saved_by: string;
  created_at: string;
}

// ── Schema ──

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS tracker_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracker_work_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      state TEXT NOT NULL DEFAULT 'brainstorming',
      priority TEXT NOT NULL DEFAULT 'none',
      assignee TEXT,
      labels TEXT DEFAULT '[]',
      position INTEGER DEFAULT 0,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES tracker_projects(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_wi_project ON tracker_work_items(project_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_wi_state ON tracker_work_items(state);
    CREATE INDEX IF NOT EXISTS idx_tracker_wi_assignee ON tracker_work_items(assignee);

    CREATE TABLE IF NOT EXISTS tracker_comments (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      author TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_comments_wi ON tracker_comments(work_item_id);

    CREATE TABLE IF NOT EXISTS tracker_transitions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      actor TEXT NOT NULL,
      comment TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_transitions_wi ON tracker_transitions(work_item_id);

    CREATE TABLE IF NOT EXISTS tracker_watchers (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      entity TEXT NOT NULL,
      notify_via TEXT NOT NULL DEFAULT 'internal',
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id),
      UNIQUE(work_item_id, entity)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_watchers_wi ON tracker_watchers(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_watchers_entity ON tracker_watchers(entity);

    CREATE TABLE IF NOT EXISTS tracker_dependencies (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      depends_on_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id),
      FOREIGN KEY (depends_on_id) REFERENCES tracker_work_items(id),
      UNIQUE(work_item_id, depends_on_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_deps_wi ON tracker_dependencies(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_deps_on ON tracker_dependencies(depends_on_id);

    CREATE TABLE IF NOT EXISTS tracker_attachments (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      comment_id TEXT,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      storage_path TEXT NOT NULL,
      uploaded_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id),
      FOREIGN KEY (comment_id) REFERENCES tracker_comments(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_attachments_wi ON tracker_attachments(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_attachments_comment ON tracker_attachments(comment_id);

    CREATE TABLE IF NOT EXISTS tracker_description_versions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      saved_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_desc_versions_wi ON tracker_description_versions(work_item_id);
  `);
}

// ── Init ──

function genId(): string {
  return crypto.randomBytes(12).toString("hex");
}

function now(): string {
  return new Date().toISOString();
}

export const VALID_THEMES = [
  "midnight",
  "ocean",
  "forest",
  "sunset",
  "lavender",
] as const;
export type ProjectTheme = (typeof VALID_THEMES)[number];

export function initTrackerDatabase(): void {
  const dbPath = path.join(STORE_DIR, "tracker.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Migration: rename board_* tables to tracker_* (one-time, from board->tracker rename)
  const oldTables = [
    "board_projects",
    "board_work_items",
    "board_comments",
    "board_transitions",
    "board_watchers",
    "board_dependencies",
  ];
  for (const old of oldTables) {
    try {
      const newName = old.replace("board_", "tracker_");
      db.exec(`ALTER TABLE ${old} RENAME TO ${newName}`);
      logger.info(`Renamed table ${old} -> ${newName}`);
    } catch {
      // Table doesn't exist or already renamed
    }
  }

  createSchema(db);

  // Migrations
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN theme TEXT NOT NULL DEFAULT 'midnight'",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN locked_by TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN locked_at TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN requires_code INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN short_name TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 1",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN seq_number INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN platform TEXT NOT NULL DEFAULT 'any'",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN working_directory TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN session_id TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN session_status TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN tab_order INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN opencode_project_id TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    // Column already exists
  }

  // Security migrations (Section 4.2, 4.3, 4.6)
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN created_by_class TEXT NOT NULL DEFAULT 'api'",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN approved_by TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN approved_by_class TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN approved_at TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN approved_description_hash TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_transitions ADD COLUMN actor_class TEXT NOT NULL DEFAULT 'api'",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN opencode_pid INTEGER DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN bot_dispatch INTEGER NOT NULL DEFAULT 0",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN orchestration INTEGER NOT NULL DEFAULT 1",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN context TEXT NOT NULL DEFAULT ''",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN date_due TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN link TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN space_type TEXT NOT NULL DEFAULT 'standard'",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_work_items ADD COLUMN space_data TEXT DEFAULT NULL",
    );
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      "ALTER TABLE tracker_projects ADD COLUMN active_spaces TEXT NOT NULL DEFAULT '[\"standard\"]'",
    );
  } catch {
    // Column already exists
  }

  // Backfill: set bot_dispatch=1 for all items that have requires_code=1
  // (preserves existing behavior — items that had requires_code were previously auto-dispatched)
  try {
    const backfilled = db.prepare(
      "UPDATE tracker_work_items SET bot_dispatch = 1 WHERE requires_code = 1 AND bot_dispatch = 0",
    ).run();
    if (backfilled.changes > 0) {
      logger.info(`Backfilled bot_dispatch=1 for ${backfilled.changes} items with requires_code=1`);
    }
  } catch {
    // Ignore errors during backfill
  }

  // Execution audit table (Section 4.6.2)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_execution_audits (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      files_modified TEXT DEFAULT '[]',
      files_created TEXT DEFAULT '[]',
      files_deleted TEXT DEFAULT '[]',
      exit_status TEXT DEFAULT 'pending',
      git_branch TEXT,
      git_diff_stats TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_audits_wi ON tracker_execution_audits(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_tracker_audits_session ON tracker_execution_audits(session_id);
  `);

  // Backfill: assign tab_order to projects that have 0 (default) — preserve existing order by updated_at
  const projectsNeedingTabOrder = db
    .prepare("SELECT id FROM tracker_projects WHERE tab_order = 0 ORDER BY updated_at DESC")
    .all() as Array<{ id: string }>;
  if (projectsNeedingTabOrder.length > 0) {
    const updateTabOrder = db.prepare("UPDATE tracker_projects SET tab_order = ? WHERE id = ?");
    for (let i = 0; i < projectsNeedingTabOrder.length; i++) {
      updateTabOrder.run(i + 1, projectsNeedingTabOrder[i].id);
    }
    logger.info(`Backfilled tab_order for ${projectsNeedingTabOrder.length} projects`);
  }

  // Backfill: assign short_names to projects that don't have one
  const projectsNeedingShortName = db
    .prepare("SELECT id, name FROM tracker_projects WHERE short_name = ''")
    .all() as Array<{ id: string; name: string }>;
  for (const p of projectsNeedingShortName) {
    const shortName = deriveShortName(p.name);
    db.prepare("UPDATE tracker_projects SET short_name = ? WHERE id = ?").run(
      shortName,
      p.id,
    );
    logger.info(`Backfilled short_name "${shortName}" for project "${p.name}"`);
  }

  // Backfill: assign sequential numbers to existing items that have seq_number=0
  const projectsForSeqBackfill = db
    .prepare("SELECT id, short_name FROM tracker_projects")
    .all() as Array<{ id: string; short_name: string }>;
  for (const proj of projectsForSeqBackfill) {
    const items = db
      .prepare(
        "SELECT id FROM tracker_work_items WHERE project_id = ? AND seq_number = 0 ORDER BY created_at ASC",
      )
      .all(proj.id) as Array<{ id: string }>;
    if (items.length === 0) continue;

    // Get current max seq_number for items that already have one
    const maxExisting = db
      .prepare(
        "SELECT COALESCE(MAX(seq_number), 0) as max_seq FROM tracker_work_items WHERE project_id = ? AND seq_number > 0",
      )
      .get(proj.id) as { max_seq: number };
    let seq = maxExisting.max_seq + 1;

    for (const item of items) {
      db.prepare(
        "UPDATE tracker_work_items SET seq_number = ? WHERE id = ?",
      ).run(seq, item.id);
      seq++;
    }
    // Update the project's next_seq counter
    db.prepare("UPDATE tracker_projects SET next_seq = ? WHERE id = ?").run(
      seq,
      proj.id,
    );
    logger.info(
      `Backfilled ${items.length} sequential numbers for project "${proj.short_name}" (next_seq=${seq})`,
    );
  }

  // Normalize historical agent actor names to "Coder"
  const agentAliases = ["Claude", "claude", "opencode", "agent", "coder-bot", "Claude (Coder)"];
  const placeholders = agentAliases.map(() => "?").join(", ");
  const tables: Array<{ table: string; column: string }> = [
    { table: "tracker_work_items", column: "created_by" },
    { table: "tracker_work_items", column: "assignee" },
    { table: "tracker_work_items", column: "locked_by" },
    { table: "tracker_work_items", column: "approved_by" },
    { table: "tracker_comments", column: "author" },
    { table: "tracker_transitions", column: "actor" },
  ];
  for (const { table, column } of tables) {
    try {
      const result = db
        .prepare(`UPDATE ${table} SET ${column} = 'Coder' WHERE ${column} IN (${placeholders})`)
        .run(...agentAliases);
      if (result.changes > 0) {
        logger.info(`Normalized ${result.changes} "${column}" values to "Coder" in ${table}`);
      }
    } catch {
      // Table or column might not exist yet
    }
  }

  logger.info("Tracker database initialized");
}

/** @internal - for tests only */
export function _initTestTrackerDatabase(): void {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  createSchema(db);

  // Apply all migrations so the in-memory schema matches the production schema.
  // These mirror the ALTER TABLE migrations in initTrackerDatabase().
  const migrations = [
    "ALTER TABLE tracker_projects ADD COLUMN theme TEXT NOT NULL DEFAULT 'midnight'",
    "ALTER TABLE tracker_work_items ADD COLUMN locked_by TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN locked_at TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN requires_code INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tracker_projects ADD COLUMN short_name TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tracker_projects ADD COLUMN next_seq INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE tracker_work_items ADD COLUMN seq_number INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tracker_work_items ADD COLUMN platform TEXT NOT NULL DEFAULT 'any'",
    "ALTER TABLE tracker_projects ADD COLUMN working_directory TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tracker_work_items ADD COLUMN session_id TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN session_status TEXT DEFAULT NULL",
    "ALTER TABLE tracker_projects ADD COLUMN tab_order INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tracker_projects ADD COLUMN opencode_project_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tracker_work_items ADD COLUMN created_by_class TEXT NOT NULL DEFAULT 'api'",
    "ALTER TABLE tracker_work_items ADD COLUMN approved_by TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN approved_by_class TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN approved_at TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN approved_description_hash TEXT DEFAULT NULL",
    "ALTER TABLE tracker_transitions ADD COLUMN actor_class TEXT NOT NULL DEFAULT 'api'",
    "ALTER TABLE tracker_work_items ADD COLUMN opencode_pid INTEGER DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN bot_dispatch INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tracker_projects ADD COLUMN orchestration INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE tracker_projects ADD COLUMN context TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE tracker_work_items ADD COLUMN date_due TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN link TEXT DEFAULT NULL",
    "ALTER TABLE tracker_work_items ADD COLUMN space_type TEXT NOT NULL DEFAULT 'standard'",
    "ALTER TABLE tracker_work_items ADD COLUMN space_data TEXT DEFAULT NULL",
    "ALTER TABLE tracker_projects ADD COLUMN active_spaces TEXT NOT NULL DEFAULT '[\"standard\"]'",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch {
      // Column already exists (shouldn't happen in fresh in-memory DB, but safe to ignore)
    }
  }

  // Create execution audits table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_execution_audits (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      files_modified TEXT DEFAULT '[]',
      files_created TEXT DEFAULT '[]',
      files_deleted TEXT DEFAULT '[]',
      exit_status TEXT DEFAULT 'pending',
      git_branch TEXT,
      git_diff_stats TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
  `);

  // Create description versions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_description_versions (
      id TEXT PRIMARY KEY,
      work_item_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      saved_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL,
      FOREIGN KEY (work_item_id) REFERENCES tracker_work_items(id)
    );
  `);
}

// ── Event System ──

export type TrackerEventType =
  | "work_item.created"
  | "work_item.updated"
  | "work_item.moved"
  | "work_item.state_changed"
  | "work_item.deleted"
  | "comment.created"
  | "comment.updated"
  | "comment.deleted"
  | "attachment.created"
  | "attachment.deleted";

export interface TrackerEvent {
  type: TrackerEventType;
  work_item_id: string;
  project_id: string;
  actor: string;
  data: Record<string, unknown>;
  timestamp: string;
}

type TrackerEventListener = (event: TrackerEvent) => void;
const listeners: TrackerEventListener[] = [];

export function onTrackerEvent(listener: TrackerEventListener): void {
  listeners.push(listener);
}

function emit(event: TrackerEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      logger.warn({ err }, "Tracker event listener error");
    }
  }
}

// ── Projects CRUD ──

/**
 * Generate a default short_name from a project name.
 * "Liz Development" -> "LIZ", "World Domination" -> "WD", "Renovations" -> "REN"
 */
function deriveShortName(name: string): string {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) {
    return words[0].substring(0, 3).toUpperCase();
  }
  // Use initials for multi-word names, but if the first word is short and recognizable, use it
  if (words[0].length <= 4) {
    return words[0].toUpperCase();
  }
  return words
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function createProject(data: {
  name: string;
  short_name?: string;
  description?: string;
  context?: string;
  theme?: string;
  working_directory?: string;
  opencode_project_id?: string;
  orchestration?: boolean;
}): Project {
  const shortName = (
    data.short_name || deriveShortName(data.name)
  ).toUpperCase();
  // New projects get appended to the end of the tab order
  const maxOrder = (db.prepare("SELECT COALESCE(MAX(tab_order), 0) as max_order FROM tracker_projects").get() as { max_order: number }).max_order;
  const project: Project = {
    id: genId(),
    name: data.name,
    short_name: shortName,
    description: data.description || "",
    context: data.context || "",
    theme: data.theme || "midnight",
    next_seq: 1,
    working_directory: data.working_directory || "",
    opencode_project_id: data.opencode_project_id || "",
    tab_order: maxOrder + 1,
    orchestration: data.orchestration !== undefined ? (data.orchestration ? 1 : 0) : 1,
    active_spaces: '["standard"]',
    created_at: now(),
    updated_at: now(),
  };
  db.prepare(
    `INSERT INTO tracker_projects (id, name, short_name, description, context, theme, next_seq, working_directory, opencode_project_id, tab_order, orchestration, active_spaces, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    project.id,
    project.name,
    project.short_name,
    project.description,
    project.context,
    project.theme,
    project.next_seq,
    project.working_directory,
    project.opencode_project_id,
    project.tab_order,
    project.orchestration,
    project.active_spaces,
    project.created_at,
    project.updated_at,
  );
  return project;
}

export function getProject(id: string): Project | undefined {
  return db.prepare("SELECT * FROM tracker_projects WHERE id = ?").get(id) as
    | Project
    | undefined;
}

export function listProjects(): Project[] {
  return db
    .prepare("SELECT * FROM tracker_projects ORDER BY tab_order ASC, updated_at DESC")
    .all() as Project[];
}

export function updateProject(
  id: string,
  data: Partial<Pick<Project, "name" | "short_name" | "description" | "context" | "theme" | "working_directory" | "opencode_project_id" | "orchestration" | "active_spaces">>,
): Project | undefined {
  const existing = getProject(id);
  if (!existing) return undefined;

  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [now()];

  if (data.name !== undefined) {
    fields.push("name = ?");
    values.push(data.name);
  }
  if (data.short_name !== undefined) {
    fields.push("short_name = ?");
    values.push(data.short_name.toUpperCase());
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
  }
  if (data.context !== undefined) {
    fields.push("context = ?");
    values.push(data.context);
  }
  if (data.theme !== undefined) {
    fields.push("theme = ?");
    values.push(data.theme);
  }
  if (data.working_directory !== undefined) {
    fields.push("working_directory = ?");
    values.push(data.working_directory);
  }
  if (data.opencode_project_id !== undefined) {
    fields.push("opencode_project_id = ?");
    values.push(data.opencode_project_id);
  }
  if (data.orchestration !== undefined) {
    fields.push("orchestration = ?");
    values.push(data.orchestration);
  }
  if (data.active_spaces !== undefined) {
    fields.push("active_spaces = ?");
    values.push(data.active_spaces);
  }

  values.push(id);
  db.prepare(
    `UPDATE tracker_projects SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...values);
  return getProject(id);
}

export function reorderProjects(orderedIds: string[]): void {
  const stmt = db.prepare("UPDATE tracker_projects SET tab_order = ? WHERE id = ?");
  const runAll = db.transaction(() => {
    for (let i = 0; i < orderedIds.length; i++) {
      stmt.run(i + 1, orderedIds[i]);
    }
  });
  runAll();
}

export function deleteProject(id: string): boolean {
  // Delete all child records first
  const items = listWorkItems({ project_id: id });
  for (const item of items) {
    deleteWorkItem(item.id);
  }
  const result = db
    .prepare("DELETE FROM tracker_projects WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

// ── Work Items CRUD ──

export function createWorkItem(data: {
  project_id: string;
  title: string;
  description?: string;
  state?: WorkItemState;
  priority?: Priority;
  assignee?: string;
  labels?: string[];
  requires_code?: boolean;
  bot_dispatch?: boolean;
  platform?: Platform;
  date_due?: string | null;
  link?: string | null;
  space_type?: string;
  space_data?: string | null;
  created_by?: string;
}): WorkItem {
  const ts = now();
  const state = data.state || "brainstorming";
  const createdBy = data.created_by || "system";
  const createdByClass = classifyActor(createdBy);

  // Atomically allocate the next sequence number for this project
  const seqResult = db
    .prepare(
      "UPDATE tracker_projects SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq",
    )
    .get(data.project_id) as { next_seq: number } | undefined;
  const seqNumber = seqResult ? seqResult.next_seq - 1 : 0; // next_seq was incremented, so subtract 1

  // If created directly in 'approved' state by a human actor, populate approval provenance
  const description = data.description || "";
  const isDirectApproval = state === "approved" && createdByClass === "human";

  const item: WorkItem = {
    id: genId(),
    project_id: data.project_id,
    title: data.title,
    description,
    state,
    priority: data.priority || "none",
    assignee: data.assignee || null,
    labels: JSON.stringify(data.labels || []),
    position: 0,
    seq_number: seqNumber,
    requires_code: data.requires_code ? 1 : 0,
    bot_dispatch: data.bot_dispatch !== undefined ? (data.bot_dispatch ? 1 : 0) : (data.requires_code ? 1 : 0),
    platform: data.platform || "any",
    date_due: data.date_due || null,
    link: data.link || null,
    space_type: data.space_type || "standard",
    space_data: data.space_data || null,
    locked_by: null,
    locked_at: null,
    session_id: null,
    session_status: null,
    opencode_pid: null,
    created_by: createdBy,
    created_by_class: createdByClass,
    approved_by: isDirectApproval ? createdBy : null,
    approved_by_class: isDirectApproval ? createdByClass : null,
    approved_at: isDirectApproval ? ts : null,
    approved_description_hash: isDirectApproval ? hashDescription(description) : null,
    created_at: ts,
    updated_at: ts,
  };

  // Set position to max+1 within this state
  const maxPos = db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) as max_pos FROM tracker_work_items WHERE project_id = ? AND state = ?",
    )
    .get(data.project_id, state) as { max_pos: number };
  item.position = maxPos.max_pos + 1;

  db.prepare(
    `INSERT INTO tracker_work_items (id, project_id, title, description, state, priority, assignee, labels, position, seq_number, requires_code, bot_dispatch, platform, date_due, link, space_type, space_data, created_by, created_by_class, approved_by, approved_by_class, approved_at, approved_description_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    item.id,
    item.project_id,
    item.title,
    item.description,
    item.state,
    item.priority,
    item.assignee,
    item.labels,
    item.position,
    item.seq_number,
    item.requires_code,
    item.bot_dispatch,
    item.platform,
    item.date_due,
    item.link,
    item.space_type,
    item.space_data,
    item.created_by,
    item.created_by_class,
    item.approved_by,
    item.approved_by_class,
    item.approved_at,
    item.approved_description_hash,
    item.created_at,
    item.updated_at,
  );

  // Log approval provenance if created directly in approved state
  if (isDirectApproval) {
    logger.info(
      { itemId: item.id, actor: createdBy, actorClass: createdByClass, descHash: item.approved_description_hash!.slice(0, 12) },
      "Item created directly in approved state with description hash",
    );
  }

  // Record initial transition
  recordTransition(item.id, null, state, item.created_by, "Created");

  emit({
    type: "work_item.created",
    work_item_id: item.id,
    project_id: item.project_id,
    actor: item.created_by,
    data: { title: item.title, state: item.state },
    timestamp: ts,
  });

  return item;
}

export function getWorkItem(id: string): WorkItem | undefined {
  return db.prepare("SELECT * FROM tracker_work_items WHERE id = ?").get(id) as
    | WorkItem
    | undefined;
}

/** Compute the display key for a work item, e.g. "LIZ-3". */
export function getWorkItemKey(item: WorkItem): string {
  const project = getProject(item.project_id);
  const prefix = project?.short_name || "???";
  return `${prefix}-${item.seq_number}`;
}

/**
 * Look up a work item by its display key (e.g. "LIZ-3").
 * Returns undefined if the key format is invalid or item not found.
 */
export function getWorkItemByKey(key: string): WorkItem | undefined {
  const match = key.match(/^([A-Z]+)-(\d+)$/i);
  if (!match) return undefined;

  const shortName = match[1].toUpperCase();
  const seqNumber = parseInt(match[2], 10);

  const project = db
    .prepare("SELECT id FROM tracker_projects WHERE UPPER(short_name) = ?")
    .get(shortName) as { id: string } | undefined;
  if (!project) return undefined;

  return db
    .prepare(
      "SELECT * FROM tracker_work_items WHERE project_id = ? AND seq_number = ?",
    )
    .get(project.id, seqNumber) as WorkItem | undefined;
}

export interface WorkItemFilters {
  project_id?: string;
  state?: WorkItemState;
  assignee?: string;
  priority?: Priority;
  search?: string;
  label?: string;
}

export function listWorkItems(filters?: WorkItemFilters): WorkItem[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.project_id) {
    conditions.push("project_id = ?");
    params.push(filters.project_id);
  }
  if (filters?.state) {
    conditions.push("state = ?");
    params.push(filters.state);
  }
  if (filters?.assignee) {
    conditions.push("assignee = ?");
    params.push(filters.assignee);
  }
  if (filters?.priority) {
    conditions.push("priority = ?");
    params.push(filters.priority);
  }
  if (filters?.search) {
    conditions.push("(title LIKE ? OR description LIKE ?)");
    const pattern = `%${filters.search}%`;
    params.push(pattern, pattern);
  }
  if (filters?.label) {
    conditions.push("labels LIKE ?");
    params.push(`%"${filters.label}"%`);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return db
    .prepare(
      `SELECT * FROM tracker_work_items ${where} ORDER BY state, position, updated_at DESC`,
    )
    .all(...params) as WorkItem[];
}

/**
 * Get recently updated work items, optionally filtered by project.
 * Used by the blocker picker UI to show recent issues for selection.
 */
export function getRecentItems(
  projectId?: string,
  limit: number = 20,
): WorkItem[] {
  if (projectId) {
    return db
      .prepare(
        `SELECT * FROM tracker_work_items
         WHERE project_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(projectId, limit) as WorkItem[];
  }
  return db
    .prepare(
      `SELECT * FROM tracker_work_items
       ORDER BY updated_at DESC
       LIMIT ?`,
    )
    .all(limit) as WorkItem[];
}

export function updateWorkItem(
  id: string,
  data: Partial<
    Pick<
      WorkItem,
      | "title"
      | "description"
      | "priority"
      | "assignee"
      | "labels"
      | "position"
      | "requires_code"
      | "bot_dispatch"
      | "platform"
      | "date_due"
      | "link"
      | "space_type"
      | "space_data"
    >
  > & { actor?: string },
): WorkItem | undefined {
  const existing = getWorkItem(id);
  if (!existing) return undefined;

  const fields: string[] = ["updated_at = ?"];
  const values: unknown[] = [now()];

  if (data.title !== undefined) {
    fields.push("title = ?");
    values.push(data.title);
  }
  if (data.description !== undefined) {
    fields.push("description = ?");
    values.push(data.description);
    // Auto-save old description as a version snapshot (if it actually changed)
    if (existing.description && data.description !== existing.description) {
      // Check if the latest version already matches the old description (avoid duplicates)
      const latestVer = db
        .prepare(
          "SELECT description FROM tracker_description_versions WHERE work_item_id = ? ORDER BY version DESC LIMIT 1",
        )
        .get(id) as { description: string } | undefined;
      if (!latestVer || latestVer.description !== existing.description) {
        createDescriptionVersion({
          work_item_id: id,
          description: existing.description,
          saved_by: data.actor || "system",
        });
      }
    }
  }
  if (data.priority !== undefined) {
    fields.push("priority = ?");
    values.push(data.priority);
  }
  if (data.assignee !== undefined) {
    fields.push("assignee = ?");
    values.push(data.assignee || null);
  }
  if (data.labels !== undefined) {
    fields.push("labels = ?");
    values.push(
      typeof data.labels === "string"
        ? data.labels
        : JSON.stringify(data.labels),
    );
  }
  if (data.position !== undefined) {
    fields.push("position = ?");
    values.push(data.position);
  }
  if (data.requires_code !== undefined) {
    fields.push("requires_code = ?");
    values.push(data.requires_code ? 1 : 0);
  }
  if (data.bot_dispatch !== undefined) {
    fields.push("bot_dispatch = ?");
    values.push(data.bot_dispatch ? 1 : 0);
  }
  if (data.platform !== undefined) {
    fields.push("platform = ?");
    values.push(data.platform);
  }
  if (data.date_due !== undefined) {
    fields.push("date_due = ?");
    values.push(data.date_due || null);
  }
  if (data.link !== undefined) {
    fields.push("link = ?");
    values.push(data.link || null);
  }
  if (data.space_type !== undefined) {
    fields.push("space_type = ?");
    values.push(data.space_type);
  }
  if (data.space_data !== undefined) {
    fields.push("space_data = ?");
    values.push(data.space_data || null);
  }

  values.push(id);
  db.prepare(
    `UPDATE tracker_work_items SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...values);

  const updated = getWorkItem(id)!;
  emit({
    type: "work_item.updated",
    work_item_id: id,
    project_id: updated.project_id,
    actor: data.actor || "system",
    data: { ...data },
    timestamp: updated.updated_at,
  });

  return updated;
}

/**
 * Move a work item to a different project.
 *
 * Allocates a new seq_number from the target project, updates project_id,
 * and resets space_type to "standard" if the current space isn't active
 * on the destination project.
 */
export function moveWorkItem(
  id: string,
  targetProjectId: string,
  actor?: string,
): WorkItem | undefined {
  const existing = getWorkItem(id);
  if (!existing) return undefined;

  // No-op if same project
  if (existing.project_id === targetProjectId) return existing;

  const targetProject = getProject(targetProjectId);
  if (!targetProject) return undefined;

  // Allocate a new seq_number from the target project
  const seqResult = db
    .prepare(
      "UPDATE tracker_projects SET next_seq = next_seq + 1 WHERE id = ? RETURNING next_seq",
    )
    .get(targetProjectId) as { next_seq: number } | undefined;
  const newSeqNumber = seqResult ? seqResult.next_seq - 1 : 0;

  // Check if the item's current space_type is active on the target project
  const activeSpaces: string[] = targetProject.active_spaces
    ? (typeof targetProject.active_spaces === "string"
        ? JSON.parse(targetProject.active_spaces)
        : targetProject.active_spaces)
    : ["standard"];

  const currentSpace = existing.space_type || "standard";
  const resetSpace = !activeSpaces.includes(currentSpace);

  const ts = now();
  const fields = [
    "project_id = ?",
    "seq_number = ?",
    "position = 0",
    "updated_at = ?",
  ];
  const values: unknown[] = [targetProjectId, newSeqNumber, ts];

  if (resetSpace) {
    fields.push("space_type = ?", "space_data = ?");
    values.push("standard", null);
  }

  values.push(id);
  db.prepare(
    `UPDATE tracker_work_items SET ${fields.join(", ")} WHERE id = ?`,
  ).run(...values);

  const updated = getWorkItem(id)!;

  // Record the move in the transition history
  const sourceProject = getProject(existing.project_id);
  const oldKey = `${sourceProject?.short_name || "???"}-${existing.seq_number}`;
  const newKey = `${targetProject.short_name}-${newSeqNumber}`;
  const moveComment = `Moved from ${sourceProject?.name || "unknown"} (${oldKey}) to ${targetProject.name} (${newKey})`;
  recordTransition(
    id,
    existing.state as WorkItemState,
    existing.state as WorkItemState,
    actor || "system",
    moveComment,
  );

  emit({
    type: "work_item.moved",
    work_item_id: id,
    project_id: updated.project_id,
    actor: actor || "system",
    data: {
      from_project_id: existing.project_id,
      to_project_id: targetProjectId,
      old_seq_number: existing.seq_number,
      new_seq_number: newSeqNumber,
      space_reset: resetSpace,
    },
    timestamp: updated.updated_at,
  });

  return updated;
}

/**
 * Compute SHA-256 hash of a string (used for description integrity).
 */
function hashDescription(description: string): string {
  return crypto.createHash("sha256").update(description).digest("hex");
}

/**
 * Change the state of a work item.
 *
 * Security controls (Section 4.5):
 * - Only human actors can move items to `approved` state
 * - When moving to `approved`, records approval metadata and description hash
 * - When leaving `approved`, clears approval metadata
 *
 * @param actorClassOverride — When provided, overrides the actor class derived from
 *   the actor name string. Used by the MCP server to enforce "agent" class for all
 *   MCP-originating requests, preventing prompt injection bypasses via actor name spoofing.
 */
export function changeWorkItemState(
  id: string,
  newState: WorkItemState,
  actor: string,
  comment?: string,
  actorClassOverride?: ActorClass,
): WorkItem | undefined {
  const existing = getWorkItem(id);
  if (!existing) return undefined;
  if (existing.state === newState) return existing;

  const ts = now();
  const oldState = existing.state;
  // Use override if provided (e.g. MCP server always passes "agent" to prevent
  // actor name spoofing), otherwise classify from the actor name string.
  const actorClass = actorClassOverride ?? classifyActor(actor);

  // ── Section 4.5: Restricted state transitions ──
  // Only human actors can approve items for auto-execution.
  // Exception: comment-only items (requires_code=0) can be approved by agents,
  // since they don't present a security risk (no code changes). This allows
  // multiple agents to discuss and take turns on an issue without requiring
  // human re-approval on every turn.
  if (newState === "approved" && actorClass !== "human" && existing.requires_code !== 0) {
    throw new Error(
      `Only human actors can approve items for execution. ` +
      `Actor "${actor}" classified as "${actorClass}". ` +
      `Agent-created items must be approved by a human via the dashboard.`,
    );
  }

  // Only human actors can cancel items
  if (newState === "cancelled" && actorClass !== "human") {
    throw new Error(
      `Only human actors can cancel items. Actor "${actor}" classified as "${actorClass}".`,
    );
  }

  // Block API actors from moving items to in_development (must go through orchestrator or human)
  if (newState === "in_development" && actorClass === "api") {
    throw new Error(
      `API actors cannot move items to in_development. Use the orchestrator or dashboard.`,
    );
  }

  // Update position for the new state column
  const maxPos = db
    .prepare(
      "SELECT COALESCE(MAX(position), -1) as max_pos FROM tracker_work_items WHERE project_id = ? AND state = ?",
    )
    .get(existing.project_id, newState) as { max_pos: number };

  db.prepare(
    "UPDATE tracker_work_items SET state = ?, position = ?, updated_at = ? WHERE id = ?",
  ).run(newState, maxPos.max_pos + 1, ts, id);

  // ── Automatic assignee management ──
  // Set the assignee based on the new state to ensure proper ownership tracking:
  // - in_development: assign to the actor (coder taking the work), or OWNER_NAME if done from dashboard
  // - testing, needs_input, brainstorming: assign to OWNER_NAME (owner review needed)
  const ownerStates: WorkItemState[] = ["testing", "needs_input", "brainstorming"];
  if (newState === "in_development") {
    // If a human takes the item, assign to OWNER_NAME; otherwise to the actor (e.g. Coder)
    const assignee = actorClass === "human" ? OWNER_NAME : actor;
    db.prepare(
      "UPDATE tracker_work_items SET assignee = ? WHERE id = ?",
    ).run(assignee, id);
  } else if (ownerStates.includes(newState)) {
    db.prepare(
      "UPDATE tracker_work_items SET assignee = ? WHERE id = ?",
    ).run(OWNER_NAME, id);
  }

  // ── Section 4.2 + 4.3: Approval metadata ──
  if (newState === "approved") {
    const descHash = hashDescription(existing.description);
    db.prepare(
      `UPDATE tracker_work_items SET
        approved_by = ?, approved_by_class = ?, approved_at = ?,
        approved_description_hash = ?
       WHERE id = ?`,
    ).run(actor, actorClass, ts, descHash, id);

    logger.info(
      { itemId: id, actor, actorClass, descHash: descHash.slice(0, 12) },
      "Item approved with description hash",
    );
  }

  // If moving OUT of approved (e.g. back to clarification), clear approval metadata
  if (oldState === "approved" && newState !== "approved") {
    db.prepare(
      `UPDATE tracker_work_items SET
        approved_by = NULL, approved_by_class = NULL, approved_at = NULL,
        approved_description_hash = NULL
       WHERE id = ?`,
    ).run(id);
  }

  recordTransition(id, oldState, newState, actor, comment || null);

  const updated = getWorkItem(id)!;
  emit({
    type: "work_item.state_changed",
    work_item_id: id,
    project_id: updated.project_id,
    actor,
    data: { from_state: oldState, to_state: newState, comment, actor_class: actorClass },
    timestamp: ts,
  });

  return updated;
}

export function deleteWorkItem(id: string): boolean {
  const item = getWorkItem(id);
  if (!item) return false;

  db.prepare(
    "DELETE FROM tracker_dependencies WHERE work_item_id = ? OR depends_on_id = ?",
  ).run(id, id);
  db.prepare("DELETE FROM tracker_watchers WHERE work_item_id = ?").run(id);
  db.prepare("DELETE FROM tracker_transitions WHERE work_item_id = ?").run(id);
  db.prepare("DELETE FROM tracker_comments WHERE work_item_id = ?").run(id);
  db.prepare("DELETE FROM tracker_attachments WHERE work_item_id = ?").run(id);
  db.prepare("DELETE FROM tracker_description_versions WHERE work_item_id = ?").run(id);
  const result = db
    .prepare("DELETE FROM tracker_work_items WHERE id = ?")
    .run(id);

  if (result.changes > 0) {
    emit({
      type: "work_item.deleted",
      work_item_id: id,
      project_id: item.project_id,
      actor: "system",
      data: { title: item.title },
      timestamp: now(),
    });
  }

  return result.changes > 0;
}

// ── Description Versions ──

/** Save a version snapshot of the item's description. */
export function createDescriptionVersion(data: {
  work_item_id: string;
  description: string;
  saved_by?: string;
}): DescriptionVersion {
  const ts = now();
  // Get the next version number for this item
  const maxVersion = db
    .prepare(
      "SELECT COALESCE(MAX(version), 0) as max_ver FROM tracker_description_versions WHERE work_item_id = ?",
    )
    .get(data.work_item_id) as { max_ver: number };
  const version = maxVersion.max_ver + 1;

  const ver: DescriptionVersion = {
    id: genId(),
    work_item_id: data.work_item_id,
    version,
    description: data.description,
    saved_by: data.saved_by || "system",
    created_at: ts,
  };

  db.prepare(
    `INSERT INTO tracker_description_versions (id, work_item_id, version, description, saved_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(ver.id, ver.work_item_id, ver.version, ver.description, ver.saved_by, ver.created_at);

  return ver;
}

/** List all description versions for a work item, ordered by version ascending. */
export function listDescriptionVersions(workItemId: string): DescriptionVersion[] {
  return db
    .prepare(
      "SELECT * FROM tracker_description_versions WHERE work_item_id = ? ORDER BY version ASC",
    )
    .all(workItemId) as DescriptionVersion[];
}

/** Get a specific description version by ID. */
export function getDescriptionVersion(id: string): DescriptionVersion | undefined {
  return db
    .prepare("SELECT * FROM tracker_description_versions WHERE id = ?")
    .get(id) as DescriptionVersion | undefined;
}

/** Revert an item's description to a specific version. Saves current description as a new version first. */
export function revertToDescriptionVersion(
  workItemId: string,
  versionId: string,
  actor?: string,
): { item: WorkItem; version: DescriptionVersion } | undefined {
  const item = getWorkItem(workItemId);
  if (!item) return undefined;
  const ver = getDescriptionVersion(versionId);
  if (!ver || ver.work_item_id !== workItemId) return undefined;

  // Save current description as a version snapshot before reverting
  // (updateWorkItem auto-versioning will handle this)
  const updated = updateWorkItem(workItemId, {
    description: ver.description,
    actor: actor || "system",
  });
  if (!updated) return undefined;

  return { item: updated, version: ver };
}

/** Delete all description versions for a work item (used when deleting items). */
export function deleteDescriptionVersions(workItemId: string): void {
  db.prepare("DELETE FROM tracker_description_versions WHERE work_item_id = ?").run(workItemId);
}

// ── Locking ──

/** Lock an item to signal an agent is actively working on it right now. */
export function lockWorkItem(id: string, agent: string): WorkItem | undefined {
  const existing = getWorkItem(id);
  if (!existing) return undefined;

  const ts = now();
  db.prepare(
    "UPDATE tracker_work_items SET locked_by = ?, locked_at = ?, updated_at = ? WHERE id = ?",
  ).run(agent, ts, ts, id);

  return getWorkItem(id)!;
}

/** Unlock an item (agent finished or handing off). */
export function unlockWorkItem(id: string): WorkItem | undefined {
  const existing = getWorkItem(id);
  if (!existing) return undefined;

  db.prepare(
    "UPDATE tracker_work_items SET locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?",
  ).run(now(), id);

  return getWorkItem(id)!;
}

/**
 * Clear stale locks — items locked longer than `maxAgeMs` (default 2 hours).
 * Returns the items that were unlocked. Adds a comment noting the lock expired.
 */
export function clearStaleLocks(
  maxAgeMs: number = 2 * 60 * 60 * 1000,
): WorkItem[] {
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
  const stale = db
    .prepare(
      "SELECT * FROM tracker_work_items WHERE locked_by IS NOT NULL AND locked_at < ?",
    )
    .all(cutoff) as WorkItem[];

  for (const item of stale) {
    db.prepare(
      "UPDATE tracker_work_items SET locked_by = NULL, locked_at = NULL, updated_at = ? WHERE id = ?",
    ).run(now(), item.id);
    createComment({
      work_item_id: item.id,
      author: "system",
      body: `Lock expired (was locked by ${item.locked_by} since ${item.locked_at}). Agent may have crashed. Item is available for pickup again.`,
    });
    logger.warn(
      `Cleared stale lock on "${item.title}" (was locked by ${item.locked_by})`,
    );
  }

  return stale;
}

// ── Comments CRUD ──

/**
 * Noise phrases that should never be posted as comments.
 * Matched case-insensitively against the trimmed comment body.
 * Added to block Harmony session restart notices from polluting work items.
 */
const BLOCKED_COMMENT_PHRASES: string[] = [
  "session restarted.",
  "session restarted",
];

export function createComment(data: {
  work_item_id: string;
  author: string;
  body: string;
}): Comment {
  // Block noise phrases from being posted as comments (e.g. Harmony restart notices)
  const trimmed = data.body.trim().toLowerCase();
  if (BLOCKED_COMMENT_PHRASES.some((phrase) => trimmed === phrase.toLowerCase())) {
    throw new Error(`Comment blocked: "${data.body.trim()}" is a known noise phrase`);
  }

  const ts = now();
  const comment: Comment = {
    id: genId(),
    work_item_id: data.work_item_id,
    author: data.author,
    body: data.body,
    created_at: ts,
    updated_at: ts,
  };
  db.prepare(
    `INSERT INTO tracker_comments (id, work_item_id, author, body, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    comment.id,
    comment.work_item_id,
    comment.author,
    comment.body,
    comment.created_at,
    comment.updated_at,
  );

  // Touch the work item's updated_at
  db.prepare("UPDATE tracker_work_items SET updated_at = ? WHERE id = ?").run(
    ts,
    data.work_item_id,
  );

  const item = getWorkItem(data.work_item_id);
  if (item) {
    emit({
      type: "comment.created",
      work_item_id: data.work_item_id,
      project_id: item.project_id,
      actor: data.author,
      data: { comment_id: comment.id, body: data.body },
      timestamp: ts,
    });
  }

  return comment;
}

/**
 * Get comment counts for multiple work items in a single query.
 * Returns a map of work_item_id → comment count.
 */
export function getCommentCounts(workItemIds: string[]): Record<string, number> {
  if (workItemIds.length === 0) return {};
  const placeholders = workItemIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT work_item_id, COUNT(*) as count FROM tracker_comments WHERE work_item_id IN (${placeholders}) GROUP BY work_item_id`,
    )
    .all(...workItemIds) as Array<{ work_item_id: string; count: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.work_item_id] = row.count;
  }
  return counts;
}

export function listComments(workItemId: string): Comment[] {
  return db
    .prepare(
      "SELECT * FROM tracker_comments WHERE work_item_id = ? ORDER BY created_at",
    )
    .all(workItemId) as Comment[];
}

export function updateComment(
  id: string,
  data: { body: string; actor?: string },
): Comment | undefined {
  const existing = db
    .prepare("SELECT * FROM tracker_comments WHERE id = ?")
    .get(id) as Comment | undefined;
  if (!existing) return undefined;

  const ts = now();
  db.prepare(
    "UPDATE tracker_comments SET body = ?, updated_at = ? WHERE id = ?",
  ).run(data.body, ts, id);

  return db
    .prepare("SELECT * FROM tracker_comments WHERE id = ?")
    .get(id) as Comment;
}

export function deleteComment(id: string): boolean {
  const result = db
    .prepare("DELETE FROM tracker_comments WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

// ── Transitions ──

function recordTransition(
  workItemId: string,
  fromState: WorkItemState | null,
  toState: WorkItemState,
  actor: string,
  comment: string | null,
): Transition {
  const actorClass = classifyActor(actor);
  const transition: Transition = {
    id: genId(),
    work_item_id: workItemId,
    from_state: fromState,
    to_state: toState,
    actor,
    actor_class: actorClass,
    comment,
    created_at: now(),
  };
  db.prepare(
    `INSERT INTO tracker_transitions (id, work_item_id, from_state, to_state, actor, actor_class, comment, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transition.id,
    transition.work_item_id,
    transition.from_state,
    transition.to_state,
    transition.actor,
    transition.actor_class,
    transition.comment,
    transition.created_at,
  );
  return transition;
}

export function listTransitions(workItemId: string): Transition[] {
  return db
    .prepare(
      "SELECT * FROM tracker_transitions WHERE work_item_id = ? ORDER BY created_at",
    )
    .all(workItemId) as Transition[];
}

// ── Watchers ──

export function addWatcher(data: {
  work_item_id: string;
  entity: string;
  notify_via?: string;
}): Watcher {
  const watcher: Watcher = {
    id: genId(),
    work_item_id: data.work_item_id,
    entity: data.entity,
    notify_via: data.notify_via || "internal",
    created_at: now(),
  };
  db.prepare(
    `INSERT OR IGNORE INTO tracker_watchers (id, work_item_id, entity, notify_via, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    watcher.id,
    watcher.work_item_id,
    watcher.entity,
    watcher.notify_via,
    watcher.created_at,
  );
  return watcher;
}

export function listWatchers(workItemId: string): Watcher[] {
  return db
    .prepare(
      "SELECT * FROM tracker_watchers WHERE work_item_id = ? ORDER BY created_at",
    )
    .all(workItemId) as Watcher[];
}

export function removeWatcher(workItemId: string, entity: string): boolean {
  const result = db
    .prepare(
      "DELETE FROM tracker_watchers WHERE work_item_id = ? AND entity = ?",
    )
    .run(workItemId, entity);
  return result.changes > 0;
}

// ── Dependencies ──

/** Add a dependency: work_item_id is blocked by depends_on_id. */
export function addDependency(
  workItemId: string,
  dependsOnId: string,
): Dependency {
  if (workItemId === dependsOnId) {
    throw new Error("An item cannot depend on itself");
  }
  // Check for circular dependency (A depends on B, B depends on A)
  const reverse = db
    .prepare(
      "SELECT id FROM tracker_dependencies WHERE work_item_id = ? AND depends_on_id = ?",
    )
    .get(dependsOnId, workItemId);
  if (reverse) {
    throw new Error(
      "Circular dependency: the target item already depends on this item",
    );
  }

  const dep: Dependency = {
    id: genId(),
    work_item_id: workItemId,
    depends_on_id: dependsOnId,
    created_at: now(),
  };
  db.prepare(
    `INSERT OR IGNORE INTO tracker_dependencies (id, work_item_id, depends_on_id, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(dep.id, dep.work_item_id, dep.depends_on_id, dep.created_at);
  return dep;
}

/** Remove a dependency. */
export function removeDependency(
  workItemId: string,
  dependsOnId: string,
): boolean {
  const result = db
    .prepare(
      "DELETE FROM tracker_dependencies WHERE work_item_id = ? AND depends_on_id = ?",
    )
    .run(workItemId, dependsOnId);
  return result.changes > 0;
}

/** Get items that block this item (its dependencies). */
export function getDependencies(workItemId: string): WorkItem[] {
  return db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_dependencies d ON d.depends_on_id = wi.id
       WHERE d.work_item_id = ?
       ORDER BY wi.priority DESC, wi.created_at`,
    )
    .all(workItemId) as WorkItem[];
}

/** Get items that this item blocks (its dependents). */
export function getDependents(workItemId: string): WorkItem[] {
  return db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_dependencies d ON d.work_item_id = wi.id
       WHERE d.depends_on_id = ?
       ORDER BY wi.priority DESC, wi.created_at`,
    )
    .all(workItemId) as WorkItem[];
}

/**
 * Check if an item is blocked — i.e., has any dependency not in 'done', 'testing', or 'cancelled'.
 */
export function isBlocked(workItemId: string): boolean {
  const blockers = db
    .prepare(
      `SELECT COUNT(*) as count FROM tracker_work_items wi
       JOIN tracker_dependencies d ON d.depends_on_id = wi.id
       WHERE d.work_item_id = ? AND wi.state NOT IN ('done', 'testing', 'cancelled')`,
    )
    .get(workItemId) as { count: number };
  return blockers.count > 0;
}

/**
 * Get all unfinished blockers for an item (dependencies not yet done/testing/cancelled).
 */
export function getBlockers(workItemId: string): WorkItem[] {
  return db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_dependencies d ON d.depends_on_id = wi.id
       WHERE d.work_item_id = ? AND wi.state NOT IN ('done', 'testing', 'cancelled')
       ORDER BY wi.priority DESC, wi.created_at`,
    )
    .all(workItemId) as WorkItem[];
}

// ── Stats ──

export interface TrackerStats {
  total_items: number;
  by_state: Record<string, number>;
  by_priority: Record<string, number>;
  by_assignee: Record<string, number>;
}

export function getProjectStats(projectId: string): TrackerStats {
  const items = listWorkItems({ project_id: projectId });
  const stats: TrackerStats = {
    total_items: items.length,
    by_state: {},
    by_priority: {},
    by_assignee: {},
  };

  for (const item of items) {
    stats.by_state[item.state] = (stats.by_state[item.state] || 0) + 1;
    stats.by_priority[item.priority] =
      (stats.by_priority[item.priority] || 0) + 1;
    if (item.assignee) {
      stats.by_assignee[item.assignee] =
        (stats.by_assignee[item.assignee] || 0) + 1;
    }
  }

  return stats;
}

// ── Session / Orchestrator Functions ──

export type SessionStatus = "pending" | "running" | "completed" | "failed" | "idle" | "waiting_for_permission";

/** Set session info on a work item (called by orchestrator). */
export function setSessionInfo(
  itemId: string,
  sessionId: string,
  status: SessionStatus,
  pid?: number,
): void {
  if (pid !== undefined) {
    db.prepare(
      "UPDATE tracker_work_items SET session_id = ?, session_status = ?, opencode_pid = ?, updated_at = ? WHERE id = ?",
    ).run(sessionId, status, pid, now(), itemId);
  } else {
    db.prepare(
      "UPDATE tracker_work_items SET session_id = ?, session_status = ?, updated_at = ? WHERE id = ?",
    ).run(sessionId, status, now(), itemId);
  }
}

/** Clear session info from a work item. */
export function clearSessionInfo(itemId: string): void {
  db.prepare(
    "UPDATE tracker_work_items SET session_id = NULL, session_status = NULL, opencode_pid = NULL, updated_at = ? WHERE id = ?",
  ).run(now(), itemId);
}

/** Update just the session status (e.g. pending -> running -> completed). */
export function updateSessionStatus(
  itemId: string,
  status: SessionStatus,
): void {
  db.prepare(
    "UPDATE tracker_work_items SET session_status = ?, updated_at = ? WHERE id = ?",
  ).run(status, now(), itemId);
}

/**
 * Get items eligible for dispatch by the orchestrator.
 *
 * Security criteria (Sections 4.2, 4.3):
 * - state=approved, bot_dispatch=1, not locked, not blocked
 * - approved_by_class='human' — only human-approved items (Section 4.2.2)
 *   Exception: comment-only items (requires_code=0) can be dispatched without
 *   human approval, since they don't present a security risk (no code changes).
 * - approved_description_hash matches current description (Section 4.3.1)
  * - no active session (session_status NOT IN pending/running/waiting_for_permission)
  *
  * Note: bot_dispatch controls whether the orchestrator should dispatch the item.
  * requires_code controls whether the bot should make code changes (vs just research/think).
  *
  * Ordered by priority (urgent first) then age (oldest first).
  */
export function getDispatchableItems(limit: number = 1): WorkItem[] {
  const priorityOrder = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
  const items = db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_projects p ON p.id = wi.project_id
       WHERE wi.state = 'approved'
         AND wi.bot_dispatch = 1
          AND (wi.approved_by_class = 'human' OR wi.requires_code = 0)
         AND wi.locked_by IS NULL
         AND p.orchestration = 1
         AND (wi.session_status IS NULL OR wi.session_status NOT IN ('pending', 'running', 'waiting_for_permission'))
          AND NOT EXISTS (
            SELECT 1 FROM tracker_dependencies d
            JOIN tracker_work_items dep ON dep.id = d.depends_on_id
            WHERE d.work_item_id = wi.id AND dep.state NOT IN ('done', 'testing', 'cancelled')
          )
       ORDER BY ${priorityOrder}, wi.created_at ASC
       LIMIT ?`,
    )
    .all(limit) as WorkItem[];

  // Section 4.3.1: Verify description integrity at dispatch time
  return items.filter((item) => {
    if (!item.approved_description_hash) {
      logger.warn(
        { itemId: item.id },
        "Skipping dispatch: item has no approved_description_hash",
      );
      return false;
    }
    const currentHash = hashDescription(item.description);
    if (currentHash !== item.approved_description_hash) {
      logger.warn(
        { itemId: item.id, approved: item.approved_description_hash.slice(0, 12), current: currentHash.slice(0, 12) },
        "Description modified after approval — re-approval required",
      );
      // Add comment and move back to clarification
      createComment({
        work_item_id: item.id,
        author: "orchestrator",
        body: "⚠️ Description modified after approval — re-approval required. " +
          "The description hash at approval time does not match the current description. " +
          "A human must re-approve this item from the dashboard.",
      });
      changeWorkItemState(
        item.id,
        "clarification",
        "orchestrator",
        "Description modified after approval — moved back for re-approval",
      );
      return false;
    }
    return true;
  });
}

/**
 * Get items eligible for clarification dispatch.
 *
 * An item is eligible if it:
 * - Is in 'clarification' state (manually set by a human from brainstorming)
 * - Is not locked
 * - Has no active session
 * - Has no unfinished dependencies
 *
 * These items will be dispatched to a research agent (not a coder) to:
 * - Do background research on the topic
 * - Improve/expand the spec in the item description
 * - Report findings in comments
 *
 * Ordered by priority (urgent first) then age (oldest first).
 */
export function getClarifiableItems(limit: number = 1): WorkItem[] {
  const priorityOrder = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
  return db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_projects p ON p.id = wi.project_id
       WHERE wi.state = 'clarification'
         AND wi.locked_by IS NULL
         AND p.orchestration = 1
         AND (wi.session_status IS NULL OR wi.session_status NOT IN ('pending', 'running', 'waiting_for_permission'))
          AND NOT EXISTS (
            SELECT 1 FROM tracker_dependencies d
            JOIN tracker_work_items dep ON dep.id = d.depends_on_id
            WHERE d.work_item_id = wi.id AND dep.state NOT IN ('done', 'testing', 'cancelled')
          )
       ORDER BY ${priorityOrder}, wi.created_at ASC
       LIMIT ?`,
    )
    .all(limit) as WorkItem[];
}

/**
 * Get items eligible for dispatch from 'in_review' state.
 *
 * These are items that:
 * 1. Are in 'in_review' state
 * 2. Have their most recent 'in_review' transition made by the orchestrator
 *    with a comment starting with "Testing feedback from owner:" — this means
 *    the item was moved back to in_review because a human (owner) commented
 *    with feedback/questions during testing.
 * 3. Are not locked, have no active session, have no unfinished dependencies
 *
 * This is the security-safe path: only items that entered in_review specifically
 * due to human owner feedback during testing get auto-dispatched. Items that
 * ended up in in_review via other paths (e.g. agent moved there normally) do
 * NOT get auto-dispatched from here — they go through the normal testing flow.
 */
export function getDispatchableReviewItems(limit: number = 1): WorkItem[] {
  const priorityOrder = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
  return db
    .prepare(
      `SELECT wi.* FROM tracker_work_items wi
       JOIN tracker_projects p ON p.id = wi.project_id
       WHERE wi.state = 'in_review'
         AND wi.locked_by IS NULL
         AND p.orchestration = 1
         AND (wi.session_status IS NULL OR wi.session_status NOT IN ('pending', 'running', 'waiting_for_permission'))
          AND NOT EXISTS (
            SELECT 1 FROM tracker_dependencies d
            JOIN tracker_work_items dep ON dep.id = d.depends_on_id
            WHERE d.work_item_id = wi.id AND dep.state NOT IN ('done', 'testing', 'cancelled')
          )
          AND EXISTS (
           SELECT 1 FROM tracker_transitions t
           WHERE t.work_item_id = wi.id
             AND t.to_state = 'in_review'
             AND t.actor = 'orchestrator'
             AND t.comment LIKE 'Testing feedback from owner:%'
             AND t.created_at = (
               SELECT MAX(t2.created_at) FROM tracker_transitions t2
               WHERE t2.work_item_id = wi.id AND t2.to_state = 'in_review'
             )
         )
       ORDER BY ${priorityOrder}, wi.updated_at ASC
       LIMIT ?`,
    )
    .all(limit) as WorkItem[];
}

/** Get items that have an active session (pending, running, or waiting_for_permission). */
export function getActiveSessionItems(): WorkItem[] {
  return db
    .prepare(
      "SELECT * FROM tracker_work_items WHERE session_status IN ('pending', 'running', 'waiting_for_permission')",
    )
    .all() as WorkItem[];
}

/** Find work item by its OpenCode session ID. */
export function getWorkItemBySessionId(sessionId: string): WorkItem | undefined {
  return db
    .prepare("SELECT * FROM tracker_work_items WHERE session_id = ?")
    .get(sessionId) as WorkItem | undefined;
}

/**
 * Find scheduled-space items whose date_due has passed.
 * Returns items with space_type='scheduled', a non-null date_due that is
 * before today, and NOT already in done/cancelled state.
 * Used by the orchestrator to auto-expire scheduled tasks.
 */
export function getExpiredScheduledItems(): WorkItem[] {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return db
    .prepare(
      `SELECT * FROM tracker_work_items
       WHERE space_type = 'scheduled'
         AND date_due IS NOT NULL
         AND date_due < ?
         AND state NOT IN ('done', 'cancelled')`,
    )
    .all(today) as WorkItem[];
}

// ── Execution Audits (Section 4.6.2) ──

export interface ExecutionAudit {
  id: string;
  work_item_id: string;
  session_id: string;
  started_at: string;
  completed_at: string | null;
  files_modified: string; // JSON array
  files_created: string; // JSON array
  files_deleted: string; // JSON array
  exit_status: "pending" | "success" | "failure" | "timeout";
  git_branch: string | null;
  git_diff_stats: string | null;
  created_at: string;
}

/** Create an execution audit record when a session starts. */
export function createExecutionAudit(data: {
  work_item_id: string;
  session_id: string;
  git_branch?: string;
}): ExecutionAudit {
  const ts = now();
  const audit: ExecutionAudit = {
    id: genId(),
    work_item_id: data.work_item_id,
    session_id: data.session_id,
    started_at: ts,
    completed_at: null,
    files_modified: "[]",
    files_created: "[]",
    files_deleted: "[]",
    exit_status: "pending",
    git_branch: data.git_branch || null,
    git_diff_stats: null,
    created_at: ts,
  };
  db.prepare(
    `INSERT INTO tracker_execution_audits (id, work_item_id, session_id, started_at, exit_status, git_branch, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(audit.id, audit.work_item_id, audit.session_id, audit.started_at, audit.exit_status, audit.git_branch, audit.created_at);
  return audit;
}

/** Update an execution audit when a session completes. */
export function completeExecutionAudit(
  sessionId: string,
  data: {
    exit_status: "success" | "failure" | "timeout";
    files_modified?: string[];
    files_created?: string[];
    files_deleted?: string[];
    git_diff_stats?: string;
  },
): void {
  const ts = now();
  db.prepare(
    `UPDATE tracker_execution_audits SET
      completed_at = ?, exit_status = ?,
      files_modified = ?, files_created = ?, files_deleted = ?,
      git_diff_stats = ?
     WHERE session_id = ?`,
  ).run(
    ts,
    data.exit_status,
    JSON.stringify(data.files_modified || []),
    JSON.stringify(data.files_created || []),
    JSON.stringify(data.files_deleted || []),
    data.git_diff_stats || null,
    sessionId,
  );
}

/** Get execution audits for a work item. */
export function getExecutionAudits(workItemId: string): ExecutionAudit[] {
  return db
    .prepare(
      "SELECT * FROM tracker_execution_audits WHERE work_item_id = ? ORDER BY created_at DESC",
    )
    .all(workItemId) as ExecutionAudit[];
}

// ── Attention Items (cross-project) ──

export const ATTENTION_STATES: WorkItemState[] = [
  "needs_input",
  "in_review",
  "testing",
  "brainstorming",
];

export interface AttentionProject {
  project: Project;
  items: (WorkItem & { key: string })[];
}

/**
 * Get all items across all projects that need the owner's attention.
 * States: needs_input, in_review, testing, brainstorming.
 * Grouped by project, sorted by priority within each group.
 */
export function getAttentionItems(): AttentionProject[] {
  const placeholders = ATTENTION_STATES.map(() => "?").join(", ");
  const priorityOrder =
    "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END";
  const items = db
    .prepare(
      `SELECT * FROM tracker_work_items
       WHERE state IN (${placeholders})
       ORDER BY ${priorityOrder}, updated_at DESC`,
    )
    .all(...ATTENTION_STATES) as WorkItem[];

  // Group by project
  const projectMap = new Map<string, (WorkItem & { key: string })[]>();
  for (const item of items) {
    if (!projectMap.has(item.project_id)) {
      projectMap.set(item.project_id, []);
    }
    const project = getProject(item.project_id);
    const prefix = project?.short_name || "???";
    projectMap.get(item.project_id)!.push({
      ...item,
      key: `${prefix}-${item.seq_number}`,
    });
  }

  // Build result with project info
  const result: AttentionProject[] = [];
  for (const [projectId, projectItems] of projectMap) {
    const project = getProject(projectId);
    if (project) {
      result.push({ project, items: projectItems });
    }
  }

  return result;
}

// ── Attachments CRUD ──

/** Maximum file size for attachments: 10MB */
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

/** Create an attachment record in the database. */
export function createAttachment(data: {
  work_item_id: string;
  comment_id?: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  uploaded_by?: string;
}): Attachment {
  const ts = now();
  const attachment: Attachment = {
    id: genId(),
    work_item_id: data.work_item_id,
    comment_id: data.comment_id || null,
    filename: data.filename,
    mime_type: data.mime_type,
    size_bytes: data.size_bytes,
    storage_path: data.storage_path,
    uploaded_by: data.uploaded_by || "system",
    created_at: ts,
  };

  db.prepare(
    `INSERT INTO tracker_attachments (id, work_item_id, comment_id, filename, mime_type, size_bytes, storage_path, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attachment.id,
    attachment.work_item_id,
    attachment.comment_id,
    attachment.filename,
    attachment.mime_type,
    attachment.size_bytes,
    attachment.storage_path,
    attachment.uploaded_by,
    attachment.created_at,
  );

  // Touch the work item
  db.prepare("UPDATE tracker_work_items SET updated_at = ? WHERE id = ?").run(
    ts,
    data.work_item_id,
  );

  const item = getWorkItem(data.work_item_id);
  if (item) {
    emit({
      type: "attachment.created",
      work_item_id: data.work_item_id,
      project_id: item.project_id,
      actor: data.uploaded_by || "system",
      data: { attachment_id: attachment.id, filename: data.filename, mime_type: data.mime_type, size_bytes: data.size_bytes },
      timestamp: ts,
    });
  }

  return attachment;
}

/** Get a single attachment by ID. */
export function getAttachment(id: string): Attachment | undefined {
  return db.prepare("SELECT * FROM tracker_attachments WHERE id = ?").get(id) as
    | Attachment
    | undefined;
}

/** List all attachments for a work item. */
export function listAttachments(workItemId: string): Attachment[] {
  return db
    .prepare(
      "SELECT * FROM tracker_attachments WHERE work_item_id = ? ORDER BY created_at",
    )
    .all(workItemId) as Attachment[];
}

/** Delete an attachment record from the database. Does NOT delete the file on disk. */
export function deleteAttachment(id: string): Attachment | undefined {
  const attachment = getAttachment(id);
  if (!attachment) return undefined;

  db.prepare("DELETE FROM tracker_attachments WHERE id = ?").run(id);

  const ts = now();
  const item = getWorkItem(attachment.work_item_id);
  if (item) {
    emit({
      type: "attachment.deleted",
      work_item_id: attachment.work_item_id,
      project_id: item.project_id,
      actor: "system",
      data: { attachment_id: id, filename: attachment.filename },
      timestamp: ts,
    });
  }

  return attachment;
}
