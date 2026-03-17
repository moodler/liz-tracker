/**
 * Tracker DB unit tests
 *
 * Uses the in-memory database via _initTestTrackerDatabase() so tests are:
 * - Fast (no disk I/O)
 * - Isolated (fresh DB per describe block via beforeEach)
 * - Safe (never touch the live tracker.db)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestTrackerDatabase,
  classifyActor,
  createProject,
  getProject,
  listProjects,
  updateProject,
  deleteProject,
  createWorkItem,
  getWorkItem,
  getWorkItemKey,
  listWorkItems,
  changeWorkItemState,
  lockWorkItem,
  unlockWorkItem,
  clearStaleLocks,
  addDependency,
  removeDependency,
  isBlocked,
  getBlockers,
  createComment,
  listComments,
  listTransitions,
  updateWorkItem,
  moveWorkItem,
  getDispatchableItems,
  getClarifiableItems,
  createDescriptionVersion,
  listDescriptionVersions,
  getDescriptionVersion,
  revertToDescriptionVersion,
  sanitizeCommentBody,
  VALID_STATES,
  VALID_PRIORITIES,
} from './db.js';
import { OWNER_NAME } from './config.js';

// ── classifyActor ──────────────────────────────────────────────────────────────

describe('classifyActor', () => {
  it('classifies human actors', () => {
    expect(classifyActor('dashboard')).toBe('human');
    expect(classifyActor('Dashboard')).toBe('human');
    expect(classifyActor('me')).toBe('human');
  });

  it('classifies agent actors', () => {
    expect(classifyActor('Coder')).toBe('agent');
    expect(classifyActor('claude')).toBe('agent');
    expect(classifyActor('agent')).toBe('agent');
    expect(classifyActor('opencode')).toBe('agent');
    expect(classifyActor('coder')).toBe('agent');
    expect(classifyActor('Harmoni')).toBe('agent');
    expect(classifyActor('harmoni')).toBe('agent');
    expect(classifyActor('HARMONI')).toBe('agent');
  });

  it('classifies system actors', () => {
    expect(classifyActor('orchestrator')).toBe('system');
    expect(classifyActor('system')).toBe('system');
    expect(classifyActor('health-check')).toBe('system');
    expect(classifyActor('scheduler')).toBe('system');
  });

  it('classifies unknown actors as api (conservative default)', () => {
    expect(classifyActor('api')).toBe('api');
    expect(classifyActor('anonymous')).toBe('api');
    expect(classifyActor('unknown-bot')).toBe('api');
    expect(classifyActor('')).toBe('api');
  });

  it('classification is case-insensitive', () => {
    expect(classifyActor('DASHBOARD')).toBe('human');
    expect(classifyActor('CLAUDE')).toBe('agent');
    expect(classifyActor('ORCHESTRATOR')).toBe('system');
  });
});

// ── Project CRUD ───────────────────────────────────────────────────────────────

describe('Project CRUD', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it('creates a project with auto-derived short_name', () => {
    const p = createProject({ name: 'Liz Development' });
    expect(p.id).toBeTruthy();
    expect(p.name).toBe('Liz Development');
    expect(p.short_name).toBe('LIZ');
    expect(p.description).toBe('');
    expect(p.next_seq).toBe(1);
  });

  it('creates a project with explicit short_name', () => {
    const p = createProject({ name: 'My Project', short_name: 'MP' });
    expect(p.short_name).toBe('MP');
  });

  it('short_name is always uppercased', () => {
    const p = createProject({ name: 'Test', short_name: 'lower' });
    expect(p.short_name).toBe('LOWER');
  });

  it('gets a project by id', () => {
    const created = createProject({ name: 'Test Project' });
    const fetched = getProject(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe('Test Project');
  });

  it('returns undefined for non-existent project', () => {
    expect(getProject('nonexistent')).toBeUndefined();
  });

  it('lists all projects', () => {
    createProject({ name: 'Alpha' });
    createProject({ name: 'Beta' });
    const projects = listProjects();
    expect(projects.length).toBe(2);
  });

  it('updates a project', () => {
    const p = createProject({ name: 'Old Name' });
    const updated = updateProject(p.id, { name: 'New Name', description: 'Updated' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New Name');
    expect(updated!.description).toBe('Updated');
  });

  it('returns undefined when updating non-existent project', () => {
    expect(updateProject('nonexistent', { name: 'New' })).toBeUndefined();
  });

  it('deletes a project and its work items', () => {
    const p = createProject({ name: 'To Delete' });
    createWorkItem({ project_id: p.id, title: 'Child Item' });
    expect(deleteProject(p.id)).toBe(true);
    expect(getProject(p.id)).toBeUndefined();
    expect(listWorkItems({ project_id: p.id })).toHaveLength(0);
  });

  it('returns false when deleting non-existent project', () => {
    expect(deleteProject('nonexistent')).toBe(false);
  });

  it('tab_order increments across multiple projects', () => {
    const p1 = createProject({ name: 'First' });
    const p2 = createProject({ name: 'Second' });
    const p3 = createProject({ name: 'Third' });
    expect(p1.tab_order).toBeLessThan(p2.tab_order);
    expect(p2.tab_order).toBeLessThan(p3.tab_order);
  });
});

// ── Project opencode_project_id ────────────────────────────────────────────────

describe('Project opencode_project_id', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it('defaults opencode_project_id to empty string', () => {
    const p = createProject({ name: 'Test' });
    expect(p.opencode_project_id).toBe('');
  });

  it('creates project with explicit opencode_project_id', () => {
    const p = createProject({
      name: 'With OC ID',
      opencode_project_id: 'oc-proj-abc123',
    });
    expect(p.opencode_project_id).toBe('oc-proj-abc123');
  });

  it('updates opencode_project_id', () => {
    const p = createProject({ name: 'Test' });
    expect(p.opencode_project_id).toBe('');

    const updated = updateProject(p.id, { opencode_project_id: 'oc-proj-xyz789' });
    expect(updated).toBeDefined();
    expect(updated!.opencode_project_id).toBe('oc-proj-xyz789');
  });

  it('preserves opencode_project_id when updating other fields', () => {
    const p = createProject({
      name: 'Test',
      opencode_project_id: 'oc-proj-keep-me',
    });

    const updated = updateProject(p.id, { name: 'New Name' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New Name');
    expect(updated!.opencode_project_id).toBe('oc-proj-keep-me');
  });

  it('getProject returns opencode_project_id', () => {
    const p = createProject({
      name: 'Test',
      opencode_project_id: 'oc-proj-read-test',
    });
    const fetched = getProject(p.id);
    expect(fetched).toBeDefined();
    expect(fetched!.opencode_project_id).toBe('oc-proj-read-test');
  });

  it('can clear opencode_project_id by setting to empty string', () => {
    const p = createProject({
      name: 'Test',
      opencode_project_id: 'oc-proj-to-clear',
    });
    const updated = updateProject(p.id, { opencode_project_id: '' });
    expect(updated).toBeDefined();
    expect(updated!.opencode_project_id).toBe('');
  });
});

// ── Work Item CRUD ─────────────────────────────────────────────────────────────

describe('Work Item CRUD', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test Project' });
    projectId = p.id;
  });

  it('creates a work item with defaults', () => {
    const item = createWorkItem({ project_id: projectId, title: 'My Task' });
    expect(item.id).toBeTruthy();
    expect(item.title).toBe('My Task');
    expect(item.state).toBe('brainstorming');
    expect(item.priority).toBe('none');
    expect(item.labels).toBe('[]');
    expect(item.requires_code).toBe(0);
    expect(item.platform).toBe('any');
  });

  it('allocates sequential seq_numbers', () => {
    const i1 = createWorkItem({ project_id: projectId, title: 'First' });
    const i2 = createWorkItem({ project_id: projectId, title: 'Second' });
    const i3 = createWorkItem({ project_id: projectId, title: 'Third' });
    expect(i1.seq_number).toBe(1);
    expect(i2.seq_number).toBe(2);
    expect(i3.seq_number).toBe(3);
  });

  it('generates correct work item key', () => {
    const p = createProject({ name: 'Liz', short_name: 'LIZ' });
    const item = createWorkItem({ project_id: p.id, title: 'First Issue' });
    expect(getWorkItemKey(item)).toBe('LIZ-1');
  });

  it('gets a work item by id', () => {
    const created = createWorkItem({ project_id: projectId, title: 'Task' });
    const fetched = getWorkItem(created.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(created.id);
  });

  it('returns undefined for non-existent work item', () => {
    expect(getWorkItem('nonexistent')).toBeUndefined();
  });

  it('lists work items with project filter', () => {
    const p2 = createProject({ name: 'Other Project' });
    createWorkItem({ project_id: projectId, title: 'Item 1' });
    createWorkItem({ project_id: projectId, title: 'Item 2' });
    createWorkItem({ project_id: p2.id, title: 'Other' });
    const items = listWorkItems({ project_id: projectId });
    expect(items).toHaveLength(2);
  });

  it('lists work items with state filter', () => {
    createWorkItem({ project_id: projectId, title: 'Brainstorming', state: 'brainstorming' });
    createWorkItem({ project_id: projectId, title: 'Approved', state: 'approved', created_by: 'dashboard' });
    const brainstorming = listWorkItems({ project_id: projectId, state: 'brainstorming' });
    expect(brainstorming).toHaveLength(1);
    expect(brainstorming[0].title).toBe('Brainstorming');
  });

  it('records initial transition on create', () => {
    const item = createWorkItem({ project_id: projectId, title: 'New Item' });
    const transitions = listTransitions(item.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].from_state).toBeNull();
    expect(transitions[0].to_state).toBe('brainstorming');
    expect(transitions[0].comment).toBe('Created');
  });

  it('classifies created_by_class correctly', () => {
    const humanItem = createWorkItem({ project_id: projectId, title: 'Human', created_by: 'dashboard' });
    const agentItem = createWorkItem({ project_id: projectId, title: 'Agent', created_by: 'Coder' });
    expect(humanItem.created_by_class).toBe('human');
    expect(agentItem.created_by_class).toBe('agent');
  });

  it('classifies Harmoni as agent (TRACK-213)', () => {
    const item = createWorkItem({ project_id: projectId, title: 'Harmoni item', created_by: 'Harmoni' });
    expect(item.created_by).toBe('Harmoni');
    expect(item.created_by_class).toBe('agent');
  });
});

// ── State Transitions ──────────────────────────────────────────────────────────

describe('State Transitions', () => {
  let projectId: string;
  let itemId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test' });
    projectId = p.id;
    const item = createWorkItem({ project_id: projectId, title: 'Task' });
    itemId = item.id;
  });

  it('changes state successfully', () => {
    const updated = changeWorkItemState(itemId, 'clarification', 'dashboard');
    expect(updated).toBeDefined();
    expect(updated!.state).toBe('clarification');
  });

  it('records transitions in history', () => {
    changeWorkItemState(itemId, 'clarification', 'dashboard');
    changeWorkItemState(itemId, 'approved', 'dashboard');
    const transitions = listTransitions(itemId);
    // Initial "Created" + 2 state changes
    expect(transitions).toHaveLength(3);
    expect(transitions[1].from_state).toBe('brainstorming');
    expect(transitions[1].to_state).toBe('clarification');
    expect(transitions[2].from_state).toBe('clarification');
    expect(transitions[2].to_state).toBe('approved');
  });

  it('returns existing item if state unchanged (no-op)', () => {
    const original = getWorkItem(itemId)!;
    const result = changeWorkItemState(itemId, 'brainstorming', 'dashboard');
    expect(result!.state).toBe('brainstorming');
    // Should not add a new transition
    const transitions = listTransitions(itemId);
    expect(transitions).toHaveLength(1); // only the initial "Created"
  });

  it('returns undefined for non-existent item', () => {
    expect(changeWorkItemState('nonexistent', 'approved', 'dashboard')).toBeUndefined();
  });

  it('SECURITY: only human actors can approve code items', () => {
    // Create a requires_code item — agents must NOT be able to approve these
    const codeItem = createWorkItem({
      project_id: projectId,
      title: 'Code task',
      requires_code: true,
    });
    expect(() => changeWorkItemState(codeItem.id, 'approved', 'Coder')).toThrow(
      /Only human actors can approve/
    );
    expect(() => changeWorkItemState(codeItem.id, 'approved', 'orchestrator')).toThrow(
      /Only human actors can approve/
    );
    expect(() => changeWorkItemState(codeItem.id, 'approved', 'api-user')).toThrow(
      /Only human actors can approve/
    );
  });

  it('SECURITY: human actors CAN approve items', () => {
    expect(() => changeWorkItemState(itemId, 'approved', 'dashboard')).not.toThrow();
  });

  it('SECURITY: agents CAN approve comment-only items', () => {
    // Comment-only items (requires_code=0) can be approved by agents since
    // they don't present a security risk (no code changes)
    const commentItem = createWorkItem({
      project_id: projectId,
      title: 'Comment only task',
      requires_code: false,
      bot_dispatch: true,
    });
    expect(() => changeWorkItemState(commentItem.id, 'approved', 'Coder')).not.toThrow();
    const updated = getWorkItem(commentItem.id)!;
    expect(updated.state).toBe('approved');
    expect(updated.approved_by).toBe('Coder');
    expect(updated.approved_by_class).toBe('agent');
    expect(updated.approved_description_hash).toBeTruthy();
  });

  it('SECURITY: only human actors can cancel items', () => {
    expect(() => changeWorkItemState(itemId, 'cancelled', 'Coder')).toThrow(
      /Only human actors can cancel/
    );
  });

  it('SECURITY: human actors CAN cancel items', () => {
    expect(() => changeWorkItemState(itemId, 'cancelled', 'dashboard')).not.toThrow();
  });

  it('SECURITY: API actors cannot move items to in_development', () => {
    expect(() => changeWorkItemState(itemId, 'in_development', 'api-caller')).toThrow(
      /API actors cannot move items to in_development/
    );
  });

  it('agent actors can move items to in_development', () => {
    const result = changeWorkItemState(itemId, 'in_development', 'Coder');
    expect(result!.state).toBe('in_development');
  });

  it('records approval provenance when approved', () => {
    changeWorkItemState(itemId, 'approved', 'dashboard', 'Looks good');
    const item = getWorkItem(itemId)!;
    expect(item.approved_by).toBe('dashboard');
    expect(item.approved_by_class).toBe('human');
    expect(item.approved_at).toBeTruthy();
    expect(item.approved_description_hash).toBeTruthy();
    expect(item.approved_description_hash).toHaveLength(64); // SHA-256 hex
  });

  it('clears approval metadata when moved out of approved', () => {
    changeWorkItemState(itemId, 'approved', 'dashboard');
    changeWorkItemState(itemId, 'clarification', 'dashboard');
    const item = getWorkItem(itemId)!;
    expect(item.approved_by).toBeNull();
    expect(item.approved_by_class).toBeNull();
    expect(item.approved_at).toBeNull();
    expect(item.approved_description_hash).toBeNull();
  });

  it('assigns to actor when moved to in_development by agent', () => {
    changeWorkItemState(itemId, 'in_development', 'Coder');
    const item = getWorkItem(itemId)!;
    expect(item.assignee).toBe('Coder');
  });

  it('assigns to actor when moved to in_development by human', () => {
    changeWorkItemState(itemId, 'in_development', 'dashboard');
    const item = getWorkItem(itemId)!;
    expect(item.assignee).toBe(OWNER_NAME);
  });

  it('assigns to actor when moved to needs_input', () => {
    changeWorkItemState(itemId, 'in_development', 'Coder');
    changeWorkItemState(itemId, 'needs_input', 'Coder');
    const item = getWorkItem(itemId)!;
    expect(item.assignee).toBe(OWNER_NAME);
  });

  it('assigns to actor when moved to testing', () => {
    changeWorkItemState(itemId, 'in_development', 'Coder');
    changeWorkItemState(itemId, 'testing', 'Coder');
    const item = getWorkItem(itemId)!;
    expect(item.assignee).toBe(OWNER_NAME);
  });

  it('records comment with transition', () => {
    changeWorkItemState(itemId, 'clarification', 'dashboard', 'Needs more details');
    const transitions = listTransitions(itemId);
    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition.comment).toBe('Needs more details');
  });

  it('records actor_class with transition', () => {
    changeWorkItemState(itemId, 'in_development', 'Coder');
    const transitions = listTransitions(itemId);
    const lastTransition = transitions[transitions.length - 1];
    expect(lastTransition.actor_class).toBe('agent');
  });
});

// ── Lock / Unlock ──────────────────────────────────────────────────────────────

describe('Lock / Unlock', () => {
  let projectId: string;
  let itemId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test' });
    projectId = p.id;
    const item = createWorkItem({ project_id: projectId, title: 'Task' });
    itemId = item.id;
  });

  it('locks a work item', () => {
    const locked = lockWorkItem(itemId, 'Coder');
    expect(locked).toBeDefined();
    expect(locked!.locked_by).toBe('Coder');
    expect(locked!.locked_at).toBeTruthy();
  });

  it('unlocks a work item', () => {
    lockWorkItem(itemId, 'Coder');
    const unlocked = unlockWorkItem(itemId);
    expect(unlocked).toBeDefined();
    expect(unlocked!.locked_by).toBeNull();
    expect(unlocked!.locked_at).toBeNull();
  });

  it('returns undefined when locking non-existent item', () => {
    expect(lockWorkItem('nonexistent', 'Coder')).toBeUndefined();
  });

  it('returns undefined when unlocking non-existent item', () => {
    expect(unlockWorkItem('nonexistent')).toBeUndefined();
  });

  it('clearStaleLocks clears expired locks and adds comment', () => {
    // Lock the item
    lockWorkItem(itemId, 'Coder');

    // Use a negative maxAge so the cutoff is in the future (all locks appear stale)
    // clearStaleLocks(-60000) → cutoff = now + 60s → any locked_at < that is "stale"
    const cleared = clearStaleLocks(-60000);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].id).toBe(itemId);

    // Item should now be unlocked
    const item = getWorkItem(itemId)!;
    expect(item.locked_by).toBeNull();

    // Comment should be added
    const comments = listComments(itemId);
    expect(comments.some(c => c.body.includes('Lock expired'))).toBe(true);
  });

  it('clearStaleLocks does not clear fresh locks', () => {
    lockWorkItem(itemId, 'Coder');
    const cleared = clearStaleLocks(2 * 60 * 60 * 1000); // 2 hours (standard)
    expect(cleared).toHaveLength(0);

    const item = getWorkItem(itemId)!;
    expect(item.locked_by).toBe('Coder');
  });
});

// ── Dependencies ───────────────────────────────────────────────────────────────

describe('Dependencies', () => {
  let projectId: string;
  let itemA: string;
  let itemB: string;
  let itemC: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test' });
    projectId = p.id;
    itemA = createWorkItem({ project_id: projectId, title: 'A' }).id;
    itemB = createWorkItem({ project_id: projectId, title: 'B' }).id;
    itemC = createWorkItem({ project_id: projectId, title: 'C' }).id;
  });

  it('adds a dependency', () => {
    const dep = addDependency(itemA, itemB); // A is blocked by B
    expect(dep.work_item_id).toBe(itemA);
    expect(dep.depends_on_id).toBe(itemB);
  });

  it('isBlocked returns true when blocked by non-done item', () => {
    addDependency(itemA, itemB);
    expect(isBlocked(itemA)).toBe(true);
  });

  it('isBlocked returns false when not blocked', () => {
    expect(isBlocked(itemA)).toBe(false);
  });

  it('isBlocked returns false when blocker is done', () => {
    addDependency(itemA, itemB);
    changeWorkItemState(itemB, 'done', 'dashboard');
    expect(isBlocked(itemA)).toBe(false);
  });

  it('isBlocked returns false when blocker is cancelled', () => {
    addDependency(itemA, itemB);
    changeWorkItemState(itemB, 'cancelled', 'dashboard');
    expect(isBlocked(itemA)).toBe(false);
  });

  it('getBlockers returns unfinished blockers', () => {
    addDependency(itemA, itemB);
    addDependency(itemA, itemC);
    const blockers = getBlockers(itemA);
    expect(blockers).toHaveLength(2);
    const ids = blockers.map(b => b.id);
    expect(ids).toContain(itemB);
    expect(ids).toContain(itemC);
  });

  it('getBlockers excludes done/cancelled blockers', () => {
    addDependency(itemA, itemB);
    addDependency(itemA, itemC);
    changeWorkItemState(itemB, 'done', 'dashboard');
    const blockers = getBlockers(itemA);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].id).toBe(itemC);
  });

  it('removeDependency removes the link', () => {
    addDependency(itemA, itemB);
    expect(isBlocked(itemA)).toBe(true);
    const removed = removeDependency(itemA, itemB);
    expect(removed).toBe(true);
    expect(isBlocked(itemA)).toBe(false);
  });

  it('throws on self-dependency', () => {
    expect(() => addDependency(itemA, itemA)).toThrow(
      /cannot depend on itself/
    );
  });

  it('throws on circular dependency (A→B, B→A)', () => {
    addDependency(itemA, itemB); // A depends on B
    expect(() => addDependency(itemB, itemA)).toThrow(
      /Circular dependency/
    );
  });

  it('removeDependency returns false when dependency does not exist', () => {
    expect(removeDependency(itemA, itemB)).toBe(false);
  });
});

// ── Comments ───────────────────────────────────────────────────────────────────

describe('Comments', () => {
  let projectId: string;
  let itemId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test' });
    projectId = p.id;
    itemId = createWorkItem({ project_id: projectId, title: 'Task' }).id;
  });

  it('creates and lists comments', () => {
    createComment({ work_item_id: itemId, author: 'dashboard', body: 'This looks good' });
    createComment({ work_item_id: itemId, author: 'Coder', body: 'Working on it' });
    const comments = listComments(itemId);
    expect(comments).toHaveLength(2);
    expect(comments[0].body).toBe('This looks good');
    expect(comments[1].body).toBe('Working on it');
  });

  it('comment has correct fields', () => {
    const comment = createComment({ work_item_id: itemId, author: 'dashboard', body: 'Hello' });
    expect(comment.id).toBeTruthy();
    expect(comment.work_item_id).toBe(itemId);
    expect(comment.author).toBe('dashboard');
    expect(comment.body).toBe('Hello');
    expect(comment.created_at).toBeTruthy();
  });

  it('lists comments for specific item only', () => {
    const otherItem = createWorkItem({ project_id: projectId, title: 'Other' });
    createComment({ work_item_id: itemId, author: 'dashboard', body: 'Mine' });
    createComment({ work_item_id: otherItem.id, author: 'dashboard', body: 'Other' });
    expect(listComments(itemId)).toHaveLength(1);
    expect(listComments(otherItem.id)).toHaveLength(1);
  });

  it('blocks noise phrases like "Session restarted."', () => {
    expect(() =>
      createComment({ work_item_id: itemId, author: 'Harmony', body: 'Session restarted.' })
    ).toThrow('Comment blocked');

    // Case-insensitive
    expect(() =>
      createComment({ work_item_id: itemId, author: 'Harmony', body: 'SESSION RESTARTED.' })
    ).toThrow('Comment blocked');

    // Without trailing period
    expect(() =>
      createComment({ work_item_id: itemId, author: 'Harmony', body: 'Session restarted' })
    ).toThrow('Comment blocked');

    // With whitespace padding
    expect(() =>
      createComment({ work_item_id: itemId, author: 'Harmony', body: '  Session restarted.  ' })
    ).toThrow('Comment blocked');

    // Normal comments still work
    const comment = createComment({ work_item_id: itemId, author: 'Harmony', body: 'The session was restarted successfully.' });
    expect(comment.body).toBe('The session was restarted successfully.');
  });
});

// ── Comment Body Sanitization (TRACK-226) ──────────────────────────────────────

describe('sanitizeCommentBody', () => {
  it('returns normal text unchanged', () => {
    expect(sanitizeCommentBody('Hello world')).toBe('Hello world');
  });

  it('returns text with real newlines unchanged', () => {
    const text = 'Line 1\nLine 2\n\nLine 3';
    expect(sanitizeCommentBody(text)).toBe(text);
  });

  it('unescapes literal \\n when no real newlines present', () => {
    const input = 'Line 1\\n\\nLine 2\\nLine 3';
    expect(sanitizeCommentBody(input)).toBe('Line 1\n\nLine 2\nLine 3');
  });

  it('unescapes literal \\t when no real newlines present', () => {
    const input = 'Col1\\tCol2\\nRow2';
    expect(sanitizeCommentBody(input)).toBe('Col1\tCol2\nRow2');
  });

  it('unescapes literal \\" when no real newlines present', () => {
    const input = 'He said \\"hello\\"\\nNext line';
    expect(sanitizeCommentBody(input)).toBe('He said "hello"\nNext line');
  });

  it('unescapes literal \\\\ when no real newlines present', () => {
    const input = 'path\\\\to\\\\file\\nNext';
    expect(sanitizeCommentBody(input)).toBe('path\\to\\file\nNext');
  });

  it('leaves mixed content alone (real + literal newlines)', () => {
    // This simulates code blocks that contain literal \n alongside real newlines
    const input = 'Real newline here\n\nCode: `console.log("hello\\nworld")`';
    expect(sanitizeCommentBody(input)).toBe(input);
  });

  it('returns empty string unchanged', () => {
    expect(sanitizeCommentBody('')).toBe('');
  });
});

describe('createComment sanitizes body', () => {
  let projectId: string;
  let itemId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Test' });
    projectId = p.id;
    itemId = createWorkItem({ project_id: projectId, title: 'Task' }).id;
  });

  it('sanitizes JSON-escaped newlines on insert', () => {
    const comment = createComment({
      work_item_id: itemId,
      author: 'Coder',
      body: '**Title**\\n\\nParagraph text\\nMore text',
    });
    expect(comment.body).toBe('**Title**\n\nParagraph text\nMore text');
  });

  it('leaves normal comments unchanged', () => {
    const comment = createComment({
      work_item_id: itemId,
      author: 'Coder',
      body: 'Simple comment with\nreal newlines',
    });
    expect(comment.body).toBe('Simple comment with\nreal newlines');
  });
});

// ── Approval Provenance (Description Integrity) ────────────────────────────────

describe('Approval Provenance', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Security Test' });
    projectId = p.id;
  });

  it('records approval hash when approved', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Critical Task',
      description: 'Do the thing',
    });
    changeWorkItemState(item.id, 'approved', 'dashboard');
    const approved = getWorkItem(item.id)!;
    expect(approved.approved_description_hash).toBeTruthy();
    expect(approved.approved_description_hash!.length).toBe(64); // SHA-256 hex
  });

  it('different descriptions produce different hashes', () => {
    const itemA = createWorkItem({ project_id: projectId, title: 'A', description: 'desc A' });
    const itemB = createWorkItem({ project_id: projectId, title: 'B', description: 'desc B' });
    changeWorkItemState(itemA.id, 'approved', 'dashboard');
    changeWorkItemState(itemB.id, 'approved', 'dashboard');
    const a = getWorkItem(itemA.id)!;
    const b = getWorkItem(itemB.id)!;
    expect(a.approved_description_hash).not.toBe(b.approved_description_hash);
  });

  it('item created directly in approved state by human gets provenance', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Pre-approved',
      description: 'Some task',
      state: 'approved',
      created_by: 'dashboard',
    });
    expect(item.approved_by).toBe('dashboard');
    expect(item.approved_by_class).toBe('human');
    expect(item.approved_at).toBeTruthy();
    expect(item.approved_description_hash).toBeTruthy();
  });

  it('item created directly in approved state by agent does NOT get provenance', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Agent-approved',
      description: 'Sneaky',
      state: 'approved',
      created_by: 'Coder', // agent — this should fail to get provenance
    });
    // The item is created in 'approved' state by the db layer, but
    // isDirectApproval = false because createdByClass !== 'human'
    // So no approval provenance is recorded
    expect(item.approved_by).toBeNull();
    expect(item.approved_at).toBeNull();
    expect(item.approved_description_hash).toBeNull();
  });
});

// ── Bot Dispatch (bot_dispatch field) ──────────────────────────────────────────

describe('Bot Dispatch', () => {
  let projectId: string;

  beforeEach(() => {
    _initTestTrackerDatabase();
    const p = createProject({ name: 'Bot Test', short_name: 'BOT' });
    projectId = p.id;
  });

  it('defaults bot_dispatch to 0 when requires_code is false', () => {
    const item = createWorkItem({ project_id: projectId, title: 'No bot' });
    expect(item.bot_dispatch).toBe(0);
    expect(item.requires_code).toBe(0);
  });

  it('defaults bot_dispatch to 1 when requires_code is true (backward compat)', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Code item',
      requires_code: true,
    });
    expect(item.bot_dispatch).toBe(1);
    expect(item.requires_code).toBe(1);
  });

  it('allows bot_dispatch=true with requires_code=false (think-only mode)', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Think only',
      bot_dispatch: true,
      requires_code: false,
    });
    expect(item.bot_dispatch).toBe(1);
    expect(item.requires_code).toBe(0);
  });

  it('allows explicit bot_dispatch=false even when requires_code=true', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Code but no dispatch',
      bot_dispatch: false,
      requires_code: true,
    });
    expect(item.bot_dispatch).toBe(0);
    expect(item.requires_code).toBe(1);
  });

  it('updateWorkItem can set bot_dispatch independently', () => {
    const item = createWorkItem({ project_id: projectId, title: 'Update test' });
    expect(item.bot_dispatch).toBe(0);

    const updated = updateWorkItem(item.id, { bot_dispatch: 1 });
    expect(updated).toBeDefined();
    expect(updated!.bot_dispatch).toBe(1);
    expect(updated!.requires_code).toBe(0); // unchanged
  });

  it('updateWorkItem can set requires_code without affecting bot_dispatch', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'RC test',
      bot_dispatch: true,
    });
    expect(item.bot_dispatch).toBe(1);

    const updated = updateWorkItem(item.id, { requires_code: 1 });
    expect(updated).toBeDefined();
    expect(updated!.requires_code).toBe(1);
    expect(updated!.bot_dispatch).toBe(1); // unchanged
  });

  it('getDispatchableItems only returns items with bot_dispatch=1', () => {
    // Item with bot_dispatch=1, requires_code=1 (should be dispatchable)
    const codeItem = createWorkItem({
      project_id: projectId,
      title: 'Dispatchable',
      requires_code: true,
      bot_dispatch: true,
      state: 'approved',
      created_by: 'dashboard',
    });

    // Item with requires_code=1 but bot_dispatch=0 (should NOT be dispatchable)
    const noDispatch = createWorkItem({
      project_id: projectId,
      title: 'Not dispatchable',
      requires_code: true,
      bot_dispatch: false,
      state: 'approved',
      created_by: 'dashboard',
    });

    // Item with bot_dispatch=1 but requires_code=0 (think-only, SHOULD be dispatchable)
    const thinkOnly = createWorkItem({
      project_id: projectId,
      title: 'Think only dispatch',
      requires_code: false,
      bot_dispatch: true,
      state: 'approved',
      created_by: 'dashboard',
    });

    const dispatchable = getDispatchableItems(10);
    const ids = dispatchable.map(i => i.id);
    expect(ids).toContain(codeItem.id);
    expect(ids).toContain(thinkOnly.id);
    expect(ids).not.toContain(noDispatch.id);
  });

  it('getDispatchableItems excludes items without bot_dispatch even with requires_code', () => {
    const item = createWorkItem({
      project_id: projectId,
      title: 'Old style code item',
      requires_code: true,
      bot_dispatch: false,
      state: 'approved',
      created_by: 'dashboard',
    });

    const dispatchable = getDispatchableItems(10);
    expect(dispatchable.map(i => i.id)).not.toContain(item.id);
  });

  it('getDispatchableItems allows comment-only items without human approval', () => {
    // Comment-only item (requires_code=0) approved by agent — SHOULD be dispatchable
    // because comment-only items don't present a security risk.
    // Simulate the real flow: create in brainstorming, then agent moves to approved.
    const commentOnly = createWorkItem({
      project_id: projectId,
      title: 'Comment only agent-approved',
      description: 'Discussion item',
      requires_code: false,
      bot_dispatch: true,
      created_by: 'dashboard',
    });
    // Agent approves it (allowed for comment-only items)
    changeWorkItemState(commentOnly.id, 'approved', 'Coder');

    // Code item (requires_code=1) — agent cannot approve, so create via human
    // then verify it's dispatchable only because of human approval
    const codeItemHuman = createWorkItem({
      project_id: projectId,
      title: 'Code human-approved',
      description: 'Code change',
      requires_code: true,
      bot_dispatch: true,
      state: 'approved',
      created_by: 'dashboard',
    });

    const dispatchable = getDispatchableItems(10);
    const ids = dispatchable.map(i => i.id);
    expect(ids).toContain(commentOnly.id);
    expect(ids).toContain(codeItemHuman.id);

    // Verify agent CANNOT approve a code item (requires_code=1)
    const codeItemForAgent = createWorkItem({
      project_id: projectId,
      title: 'Code agent tries to approve',
      description: 'Code change attempt',
      requires_code: true,
      bot_dispatch: true,
      created_by: 'dashboard',
    });
    expect(() => {
      changeWorkItemState(codeItemForAgent.id, 'approved', 'Coder');
    }).toThrow(/Only human actors can approve/);
  });
});

// ── VALID_STATES and VALID_PRIORITIES ─────────────────────────────────────────

describe('Constants', () => {
  it('VALID_STATES contains all expected states', () => {
    const expected = [
      'brainstorming', 'clarification', 'approved', 'in_development',
      'in_review', 'needs_input', 'testing', 'done', 'cancelled',
    ];
    for (const state of expected) {
      expect(VALID_STATES).toContain(state);
    }
  });

  it('VALID_PRIORITIES contains all expected priorities', () => {
    const expected = ['none', 'low', 'medium', 'high', 'urgent'];
    for (const priority of expected) {
      expect(VALID_PRIORITIES).toContain(priority);
    }
  });
});

// ── Project Orchestration Flag ────────────────────────────────────────────────

describe('Project Orchestration', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it('defaults orchestration to 1 (enabled) for new projects', () => {
    const p = createProject({ name: 'Test Project' });
    expect(p.orchestration).toBe(1);
  });

  it('allows creating a project with orchestration disabled', () => {
    const p = createProject({ name: 'No Orch', orchestration: false });
    expect(p.orchestration).toBe(0);
  });

  it('allows creating a project with orchestration explicitly enabled', () => {
    const p = createProject({ name: 'With Orch', orchestration: true });
    expect(p.orchestration).toBe(1);
  });

  it('updateProject can toggle orchestration', () => {
    const p = createProject({ name: 'Toggle Test' });
    expect(p.orchestration).toBe(1);

    const updated = updateProject(p.id, { orchestration: 0 });
    expect(updated).toBeDefined();
    expect(updated!.orchestration).toBe(0);

    const re_enabled = updateProject(p.id, { orchestration: 1 });
    expect(re_enabled).toBeDefined();
    expect(re_enabled!.orchestration).toBe(1);
  });

  it('getDispatchableItems excludes items from projects with orchestration=0', () => {
    // Project with orchestration enabled
    const orchProject = createProject({ name: 'Orch Enabled', short_name: 'OE', orchestration: true });
    const orchItem = createWorkItem({
      project_id: orchProject.id,
      title: 'Dispatchable',
      requires_code: true,
      bot_dispatch: true,
      state: 'approved',
      created_by: 'dashboard',
    });

    // Project with orchestration disabled
    const noOrchProject = createProject({ name: 'Orch Disabled', short_name: 'OD', orchestration: false });
    const noOrchItem = createWorkItem({
      project_id: noOrchProject.id,
      title: 'Not Dispatchable',
      requires_code: true,
      bot_dispatch: true,
      state: 'approved',
      created_by: 'dashboard',
    });

    const dispatchable = getDispatchableItems(10);
    const ids = dispatchable.map(i => i.id);
    expect(ids).toContain(orchItem.id);
    expect(ids).not.toContain(noOrchItem.id);
  });

  it('getClarifiableItems excludes items from projects with orchestration=0', () => {
    // Project with orchestration enabled
    const orchProject = createProject({ name: 'Orch Enabled', short_name: 'CE', orchestration: true });
    const orchItem = createWorkItem({
      project_id: orchProject.id,
      title: 'Clarifiable',
      state: 'brainstorming',
      created_by: 'dashboard',
    });
    // Move to clarification manually
    changeWorkItemState(orchItem.id, 'clarification', 'dashboard');

    // Project with orchestration disabled
    const noOrchProject = createProject({ name: 'Orch Disabled', short_name: 'CD', orchestration: false });
    const noOrchItem = createWorkItem({
      project_id: noOrchProject.id,
      title: 'Not Clarifiable',
      state: 'brainstorming',
      created_by: 'dashboard',
    });
    changeWorkItemState(noOrchItem.id, 'clarification', 'dashboard');

    const clarifiable = getClarifiableItems(10);
    const ids = clarifiable.map(i => i.id);
    expect(ids).toContain(orchItem.id);
    expect(ids).not.toContain(noOrchItem.id);
  });

  // ── date_due field ──

  it('creates work items with date_due = null by default', () => {
    const project = createProject({ name: 'Due Date Test', short_name: 'DDT' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'No due date',
      created_by: 'dashboard',
    });
    expect(item.date_due).toBeNull();
  });

  it('creates work items with a specific date_due', () => {
    const project = createProject({ name: 'Due Date Test 2', short_name: 'DD2' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Has due date',
      date_due: '2026-04-15',
      created_by: 'dashboard',
    });
    expect(item.date_due).toBe('2026-04-15');

    // Verify persistence
    const fetched = getWorkItem(item.id);
    expect(fetched).toBeDefined();
    expect(fetched!.date_due).toBe('2026-04-15');
  });

  it('updates date_due on a work item', () => {
    const project = createProject({ name: 'Due Date Update', short_name: 'DDU' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Update due date',
      created_by: 'dashboard',
    });
    expect(item.date_due).toBeNull();

    // Set a due date
    const updated = updateWorkItem(item.id, { date_due: '2026-06-01' });
    expect(updated).toBeDefined();
    expect(updated!.date_due).toBe('2026-06-01');

    // Clear the due date
    const cleared = updateWorkItem(item.id, { date_due: null });
    expect(cleared).toBeDefined();
    expect(cleared!.date_due).toBeNull();
  });

  it('preserves date_due when updating other fields', () => {
    const project = createProject({ name: 'Due Date Preserve', short_name: 'DDP' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Preserve due date',
      date_due: '2026-12-25',
      created_by: 'dashboard',
    });
    expect(item.date_due).toBe('2026-12-25');

    // Update title only
    const updated = updateWorkItem(item.id, { title: 'New title' });
    expect(updated).toBeDefined();
    expect(updated!.date_due).toBe('2026-12-25');
    expect(updated!.title).toBe('New title');
  });
});

// ── Project Context ────────────────────────────────────────────────────────────

describe('Project Context', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it('creates a project with default empty context', () => {
    const p = createProject({ name: 'No Context Project' });
    expect(p.context).toBe('');
  });

  it('creates a project with explicit context', () => {
    const p = createProject({
      name: 'With Context',
      context: 'Always run tests before marking done.',
    });
    expect(p.context).toBe('Always run tests before marking done.');
  });

  it('updates project context', () => {
    const p = createProject({ name: 'Update Context' });
    expect(p.context).toBe('');

    const updated = updateProject(p.id, {
      context: 'Don\'t refactor existing code unless the item specifically asks for it.',
    });
    expect(updated).toBeDefined();
    expect(updated!.context).toBe('Don\'t refactor existing code unless the item specifically asks for it.');
  });

  it('clears project context by setting to empty string', () => {
    const p = createProject({
      name: 'Clear Context',
      context: 'Some instructions',
    });
    expect(p.context).toBe('Some instructions');

    const updated = updateProject(p.id, { context: '' });
    expect(updated).toBeDefined();
    expect(updated!.context).toBe('');
  });

  it('preserves context when updating other fields', () => {
    const p = createProject({
      name: 'Preserve Context',
      context: 'This project is in a feature freeze.',
    });

    const updated = updateProject(p.id, { name: 'New Name' });
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('New Name');
    expect(updated!.context).toBe('This project is in a feature freeze.');
  });

  it('context is persisted and retrievable', () => {
    const p = createProject({
      name: 'Persist Context',
      context: 'Priority items for Q1: performance and stability.',
    });

    const fetched = getProject(p.id);
    expect(fetched).toBeDefined();
    expect(fetched!.context).toBe('Priority items for Q1: performance and stability.');
  });
});

// ── Description Versioning ──────────────────────────────────────────────────────

describe('Description Versioning', () => {
  beforeEach(() => {
    _initTestTrackerDatabase();
  });

  it('auto-creates a version when description changes via updateWorkItem', () => {
    const project = createProject({ name: 'Version Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Version 1 content',
    });

    // Update description — should auto-save old description as a version
    updateWorkItem(item.id, { description: 'Version 2 content' });

    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(1);
    expect(versions[0].description).toBe('Version 1 content');
    expect(versions[0].version).toBe(1);
  });

  it('does not create duplicate versions for same description', () => {
    const project = createProject({ name: 'Dup Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Original content',
    });

    // First update — creates version for "Original content"
    updateWorkItem(item.id, { description: 'Update 1' });
    // Update back to something else — creates version for "Update 1"
    updateWorkItem(item.id, { description: 'Update 2' });

    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(2);
    expect(versions[0].description).toBe('Original content');
    expect(versions[1].description).toBe('Update 1');
  });

  it('does not create a version when description is unchanged', () => {
    const project = createProject({ name: 'NoChange Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Same content',
    });

    // Update with same description — no version should be created
    updateWorkItem(item.id, { description: 'Same content' });

    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(0);
  });

  it('does not create a version when description is empty/null', () => {
    const project = createProject({ name: 'Empty Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: '',
    });

    // Update from empty — no version for empty string
    updateWorkItem(item.id, { description: 'Now has content' });

    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(0);
  });

  it('creates manual versions via createDescriptionVersion', () => {
    const project = createProject({ name: 'Manual Version' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Some lyrics',
    });

    const ver = createDescriptionVersion({
      work_item_id: item.id,
      description: 'Some lyrics',
      saved_by: 'Martin',
    });

    expect(ver.version).toBe(1);
    expect(ver.description).toBe('Some lyrics');
    expect(ver.saved_by).toBe('Martin');

    const fetched = getDescriptionVersion(ver.id);
    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe(ver.id);
  });

  it('reverts to a previous version', () => {
    const project = createProject({ name: 'Revert Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Version 1',
    });

    // Create some changes to build version history
    updateWorkItem(item.id, { description: 'Version 2' });
    updateWorkItem(item.id, { description: 'Version 3' });

    // We should have 2 auto-versions: "Version 1" and "Version 2"
    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(2);
    expect(versions[0].description).toBe('Version 1');
    expect(versions[1].description).toBe('Version 2');

    // Revert to version 1
    const result = revertToDescriptionVersion(item.id, versions[0].id, 'Martin');
    expect(result).toBeDefined();
    expect(result!.item.description).toBe('Version 1');
    expect(result!.version.version).toBe(1);

    // Current description should now be "Version 1"
    const updated = getWorkItem(item.id);
    expect(updated!.description).toBe('Version 1');

    // "Version 3" should have been auto-saved as a version before revert
    const versionsAfter = listDescriptionVersions(item.id);
    expect(versionsAfter.length).toBe(3);
    expect(versionsAfter[2].description).toBe('Version 3');
  });

  it('revert returns undefined for invalid version id', () => {
    const project = createProject({ name: 'Invalid Revert' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Content',
    });

    const result = revertToDescriptionVersion(item.id, 'nonexistent-id', 'Martin');
    expect(result).toBeUndefined();
  });

  it('revert returns undefined for version belonging to different item', () => {
    const project = createProject({ name: 'Cross Item Revert' });
    const item1 = createWorkItem({
      project_id: project.id,
      title: 'Item 1',
      description: 'Content 1',
    });
    const item2 = createWorkItem({
      project_id: project.id,
      title: 'Item 2',
      description: 'Content 2',
    });

    const ver = createDescriptionVersion({
      work_item_id: item1.id,
      description: 'Content 1',
    });

    // Try to revert item2 to item1's version — should fail
    const result = revertToDescriptionVersion(item2.id, ver.id, 'Martin');
    expect(result).toBeUndefined();
  });

  it('records actor in auto-versioned snapshots', () => {
    const project = createProject({ name: 'Actor Test' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Test Item',
      description: 'Original',
    });

    updateWorkItem(item.id, { description: 'Updated', actor: 'Martin' });

    const versions = listDescriptionVersions(item.id);
    expect(versions.length).toBe(1);
    expect(versions[0].saved_by).toBe('Martin');
  });
});

// ── moveWorkItem ──────────────────────────────────────────────────────────────

describe('moveWorkItem', () => {
  beforeEach(() => _initTestTrackerDatabase());

  it('moves an item to a different project with new seq_number', () => {
    const projectA = createProject({ name: 'Project A', short_name: 'PA' });
    const projectB = createProject({ name: 'Project B', short_name: 'PB' });
    // Create an existing item in projectB so its next_seq advances
    createWorkItem({ project_id: projectB.id, title: 'Existing in B' });
    const item = createWorkItem({ project_id: projectA.id, title: 'Movable Item' });

    expect(item.project_id).toBe(projectA.id);
    expect(item.seq_number).toBe(1); // first item in projectA

    const moved = moveWorkItem(item.id, projectB.id, 'Martin');
    expect(moved).toBeDefined();
    expect(moved!.project_id).toBe(projectB.id);
    expect(moved!.seq_number).toBe(2); // second item in projectB
    // New key should use projectB's short_name
    const key = getWorkItemKey(moved!);
    expect(key).toBe('PB-2');
  });

  it('returns existing item unchanged when moving to same project', () => {
    const project = createProject({ name: 'Same Proj' });
    const item = createWorkItem({ project_id: project.id, title: 'Static Item' });

    const result = moveWorkItem(item.id, project.id);
    expect(result).toBeDefined();
    expect(result!.project_id).toBe(project.id);
    expect(result!.seq_number).toBe(item.seq_number);
  });

  it('returns undefined for non-existent item', () => {
    const project = createProject({ name: 'Target' });
    const result = moveWorkItem('nonexistent', project.id);
    expect(result).toBeUndefined();
  });

  it('returns undefined for non-existent target project', () => {
    const project = createProject({ name: 'Source' });
    const item = createWorkItem({ project_id: project.id, title: 'Orphan' });
    const result = moveWorkItem(item.id, 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('resets space_type to standard if not active on target project', () => {
    const projectA = createProject({ name: 'Music Proj' });
    const projectB = createProject({ name: 'Plain Proj' });
    // Set projectA to have song space active
    updateProject(projectA.id, { active_spaces: JSON.stringify(['standard', 'song']) });
    // projectB only has standard (default)
    updateProject(projectB.id, { active_spaces: JSON.stringify(['standard']) });

    const item = createWorkItem({ project_id: projectA.id, title: 'Song Item', space_type: 'song' });
    expect(item.space_type).toBe('song');

    const moved = moveWorkItem(item.id, projectB.id);
    expect(moved).toBeDefined();
    expect(moved!.space_type).toBe('standard');
    expect(moved!.space_data).toBeNull();
  });

  it('preserves space_type if active on target project', () => {
    const projectA = createProject({ name: 'Music A' });
    const projectB = createProject({ name: 'Music B' });
    updateProject(projectA.id, { active_spaces: JSON.stringify(['standard', 'song']) });
    updateProject(projectB.id, { active_spaces: JSON.stringify(['standard', 'song']) });

    const item = createWorkItem({ project_id: projectA.id, title: 'Song Item', space_type: 'song' });
    const moved = moveWorkItem(item.id, projectB.id);
    expect(moved).toBeDefined();
    expect(moved!.space_type).toBe('song');
  });

  it('resets position to 0 on move', () => {
    const projectA = createProject({ name: 'From' });
    const projectB = createProject({ name: 'To' });
    const item = createWorkItem({ project_id: projectA.id, title: 'Positioned' });
    updateWorkItem(item.id, { position: 5 });

    const moved = moveWorkItem(item.id, projectB.id);
    expect(moved).toBeDefined();
    expect(moved!.position).toBe(0);
  });

  it('records a transition when moving between projects', () => {
    const projectA = createProject({ name: 'Project Alpha', short_name: 'PA' });
    const projectB = createProject({ name: 'Project Beta', short_name: 'PB' });
    const item = createWorkItem({ project_id: projectA.id, title: 'Track Move' });

    // Move the item to a different project
    const moved = moveWorkItem(item.id, projectB.id, 'Martin');
    expect(moved).toBeDefined();

    // Check that a transition was recorded
    const transitions = listTransitions(item.id);
    // Should have: 1 initial "Created" transition + 1 move transition
    expect(transitions.length).toBe(2);

    const moveTransition = transitions[1];
    expect(moveTransition.from_state).toBe('brainstorming');
    expect(moveTransition.to_state).toBe('brainstorming');
    expect(moveTransition.actor).toBe('Martin');
    expect(moveTransition.comment).toBe('Moved from Project Alpha (PA-1) to Project Beta (PB-1)');
  });

  it('does not record a transition when moving to same project', () => {
    const project = createProject({ name: 'Same Proj', short_name: 'SP' });
    const item = createWorkItem({ project_id: project.id, title: 'Static Item' });

    moveWorkItem(item.id, project.id);

    // Only the initial "Created" transition should exist
    const transitions = listTransitions(item.id);
    expect(transitions.length).toBe(1);
  });
});

// ── Scheduled Task space_data Management ──

describe('scheduled task space_data', () => {
  beforeEach(() => _initTestTrackerDatabase());

  it('creates a scheduled task with todo and ignore lists', () => {
    const project = createProject({ name: 'Scheduled Proj' });
    const spaceData = JSON.stringify({
      schedule: { frequency: 'daily', time: '09:00', timezone: 'Australia/Perth' },
      status: { next_run: null, last_run: null, run_count: 0 },
      todo: ['Check emails', 'Review calendar'],
      ignore: ['Skip weekends'],
    });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Daily Task',
      space_type: 'scheduled',
      space_data: spaceData,
    });
    expect(item.space_type).toBe('scheduled');
    expect(item.space_data).toBe(spaceData);
    const parsed = JSON.parse(item.space_data!);
    expect(parsed.todo).toEqual(['Check emails', 'Review calendar']);
    expect(parsed.ignore).toEqual(['Skip weekends']);
  });

  it('updates todo list via space_data update', () => {
    const project = createProject({ name: 'Scheduled Proj' });
    const initialData = {
      schedule: { frequency: 'daily', time: '09:00' },
      status: { run_count: 0 },
      todo: ['Task 1'],
      ignore: [],
    };
    const item = createWorkItem({
      project_id: project.id,
      title: 'Daily Task',
      space_type: 'scheduled',
      space_data: JSON.stringify(initialData),
    });

    // Add a todo item by updating space_data
    const newData = { ...initialData, todo: ['Task 1', 'Task 2', 'Task 3'] };
    const updated = updateWorkItem(item.id, { space_data: JSON.stringify(newData) });
    expect(updated).toBeDefined();
    const parsed = JSON.parse(updated!.space_data!);
    expect(parsed.todo).toEqual(['Task 1', 'Task 2', 'Task 3']);
  });

  it('removes todo items by index correctly', () => {
    const project = createProject({ name: 'Scheduled Proj' });
    const data = {
      schedule: { frequency: 'daily' },
      status: {},
      todo: ['A', 'B', 'C', 'D', 'E'],
      ignore: ['rule1'],
    };
    const item = createWorkItem({
      project_id: project.id,
      title: 'Task',
      space_type: 'scheduled',
      space_data: JSON.stringify(data),
    });

    // Remove indices 1 and 3 (B and D)
    const todo = [...data.todo];
    const sortedIndices = [3, 1]; // reverse order
    for (const idx of sortedIndices) {
      todo.splice(idx, 1);
    }
    expect(todo).toEqual(['A', 'C', 'E']);

    const newData = { ...data, todo };
    const updated = updateWorkItem(item.id, { space_data: JSON.stringify(newData) });
    const parsed = JSON.parse(updated!.space_data!);
    expect(parsed.todo).toEqual(['A', 'C', 'E']);
    // Ignore list should be unchanged
    expect(parsed.ignore).toEqual(['rule1']);
  });

  it('handles empty space_data gracefully', () => {
    const project = createProject({ name: 'Scheduled Proj' });
    const item = createWorkItem({
      project_id: project.id,
      title: 'Empty Task',
      space_type: 'scheduled',
    });
    expect(item.space_type).toBe('scheduled');
    expect(item.space_data).toBeNull();

    // Setting space_data with just todo should work
    const newData = {
      schedule: { frequency: 'daily', time: '09:00' },
      status: {},
      todo: ['First task'],
      ignore: [],
    };
    const updated = updateWorkItem(item.id, { space_data: JSON.stringify(newData) });
    expect(updated).toBeDefined();
    const parsed = JSON.parse(updated!.space_data!);
    expect(parsed.todo).toEqual(['First task']);
  });

  it('preserves schedule and status when modifying todo/ignore', () => {
    const project = createProject({ name: 'Scheduled Proj' });
    const data = {
      schedule: { frequency: 'weekly', time: '08:30', days_of_week: ['monday', 'friday'], timezone: 'Australia/Perth' },
      status: { next_run: '2026-03-14T00:30:00Z', last_run: '2026-03-13T00:30:00Z', run_count: 5 },
      todo: ['Original task'],
      ignore: ['Original rule'],
    };
    const item = createWorkItem({
      project_id: project.id,
      title: 'Weekly Task',
      space_type: 'scheduled',
      space_data: JSON.stringify(data),
    });

    // Modify only the todo list
    const newData = { ...data, todo: ['Updated task 1', 'Updated task 2'] };
    const updated = updateWorkItem(item.id, { space_data: JSON.stringify(newData) });
    const parsed = JSON.parse(updated!.space_data!);

    // Schedule and status should be preserved
    expect(parsed.schedule.frequency).toBe('weekly');
    expect(parsed.schedule.days_of_week).toEqual(['monday', 'friday']);
    expect(parsed.status.run_count).toBe(5);
    expect(parsed.status.next_run).toBe('2026-03-14T00:30:00Z');

    // Todo should be updated
    expect(parsed.todo).toEqual(['Updated task 1', 'Updated task 2']);
    // Ignore should be unchanged
    expect(parsed.ignore).toEqual(['Original rule']);
  });
});
