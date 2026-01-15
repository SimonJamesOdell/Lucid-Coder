import { promisify } from 'util';
import crypto from 'crypto';
import db from '../database.js';

const runWithMeta = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function callback(err) {
    if (err) {
      reject(err);
      return;
    }
    resolve({ lastID: this.lastID, changes: this.changes });
  });
});

const get = promisify(db.get.bind(db));
const all = promisify(db.all.bind(db));

const toCamel = (row = {}) => ({
  id: row.id,
  projectId: row.project_id,
  goalId: row.goal_id,
  parentGoalId: row.parent_goal_id ?? null,
  prompt: row.prompt,
  status: row.status,
  lifecycleState: row.lifecycle_state ?? 'draft',
  branchName: row.branch_name,
  type: row.type,
  title: row.title,
  payload: row.payload ? JSON.parse(row.payload) : null,
  metadata: row.metadata ? JSON.parse(row.metadata) : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const buildBranchName = (prompt = '') => {
  const raw = String(prompt || '').toLowerCase();

  // Reduce filler words so branch names read like concise feature labels.
  // Example: "let's have a navigation bar at the top" -> "navigation-bar-top".
  const stopwords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'could',
    'do', 'does', 'for', 'from', 'have', 'has', 'had', 'how', 'i', 'if',
    'in', 'into', 'is', 'it', "it's", 'its', 'let', "let's", 'make',
    'of', 'on', 'or', 'our', 'please', 'should', 'so', 'some', 'that',
    'the', 'their', 'then', 'there', 'this', 'to', 'up', 'we',
    'with', 'would', 'you', 'your'
  ]);

  const tokens = raw
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => token.length > 1)
    .filter((token) => !stopwords.has(token));

  const meaningful = tokens.length > 0 ? tokens : raw.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const slug = meaningful.join('-').replace(/(^-|-$)/g, '').slice(0, 32);
  const suffix = crypto.randomUUID().split('-')[0];
  return `agent/${slug || 'goal'}-${suffix}`;
};

const assertId = (value, label = 'id') => {
  if (!value || Number.isNaN(Number(value))) {
    throw new Error(`${label} is required`);
  }
};

export const createGoal = async ({
  projectId,
  prompt,
  title = null,
  branchName = null,
  parentGoalId = null,
  lifecycleState = 'draft',
  metadata = null
}) => {
  assertId(projectId, 'projectId');
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('prompt is required');
  }
  const normalizedBranch = branchName || buildBranchName(prompt);
  const normalizedTitle = typeof title === 'string' ? title.trim().slice(0, 200) : null;
  const metadataJson =
    metadata && typeof metadata === 'object' ? JSON.stringify(metadata) : JSON.stringify(null);

  const result = await runWithMeta(
    `INSERT INTO agent_goals (project_id, prompt, title, status, lifecycle_state, branch_name, parent_goal_id, metadata)
     VALUES (?, ?, ?, 'planning', ?, ?, ?, ?)`,
    [projectId, prompt.trim(), normalizedTitle, lifecycleState, normalizedBranch, parentGoalId, metadataJson]
  );

  return getGoal(result.lastID);
};

export const getGoal = async (goalId) => {
  assertId(goalId, 'goalId');
  const row = await get('SELECT * FROM agent_goals WHERE id = ?', [goalId]);
  return row ? toCamel(row) : null;
};

export const listGoals = async (projectId, { includeArchived = true } = {}) => {
  assertId(projectId, 'projectId');

  const where = ['project_id = ?'];
  const params = [projectId];

  if (!includeArchived) {
    where.push("lifecycle_state NOT IN ('ready-to-merge','merged','cancelled')");
    where.push("status <> 'ready'");
  }

  const rows = await all(
    `SELECT * FROM agent_goals
     WHERE ${where.join(' AND ')}
     ORDER BY created_at DESC, id DESC`,
    params
  );
  return rows.map((row) => toCamel(row));
};

export const updateGoalStatus = async (goalId, status, metadata = null) => {
  assertId(goalId, 'goalId');
  if (!status) {
    throw new Error('status is required');
  }
  await runWithMeta(
    `UPDATE agent_goals
     SET status = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status, metadata ? JSON.stringify(metadata) : JSON.stringify(null), goalId]
  );
  return getGoal(goalId);
};

export const updateGoalLifecycleState = async (goalId, lifecycleState, metadata = null) => {
  assertId(goalId, 'goalId');
  if (!lifecycleState) {
    throw new Error('lifecycleState is required');
  }

  await runWithMeta(
    `UPDATE agent_goals
     SET lifecycle_state = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [lifecycleState, metadata ? JSON.stringify(metadata) : JSON.stringify(null), goalId]
  );

  return getGoal(goalId);
};

export const createGoalTask = async (goalId, { type, title, payload = null }) => {
  assertId(goalId, 'goalId');
  if (!type) {
    throw new Error('type is required');
  }
  if (!title) {
    throw new Error('title is required');
  }

  const result = await runWithMeta(
    `INSERT INTO agent_tasks (goal_id, type, title, status, payload, metadata)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    [goalId, type, title, payload ? JSON.stringify(payload) : JSON.stringify(null), JSON.stringify(null)]
  );

  return getGoalTask(result.lastID);
};

export const getGoalTask = async (taskId) => {
  assertId(taskId, 'taskId');
  const row = await get('SELECT * FROM agent_tasks WHERE id = ?', [taskId]);
  return row ? toCamel(row) : null;
};

export const listGoalTasks = async (goalId) => {
  assertId(goalId, 'goalId');
  const rows = await all(
    'SELECT * FROM agent_tasks WHERE goal_id = ? ORDER BY created_at ASC',
    [goalId]
  );
  return rows.map((row) => toCamel(row));
};

export const updateGoalTaskStatus = async (taskId, status, metadata = null) => {
  assertId(taskId, 'taskId');
  if (!status) {
    throw new Error('status is required');
  }
  await runWithMeta(
    `UPDATE agent_tasks
     SET status = ?, metadata = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status, metadata ? JSON.stringify(metadata) : JSON.stringify(null), taskId]
  );
  return getGoalTask(taskId);
};

const listChildGoalIds = async (goalIds = []) => {
  if (!Array.isArray(goalIds) || goalIds.length === 0) {
    return [];
  }

  const placeholders = goalIds.map(() => '?').join(',');
  const rows = await all(
    `SELECT id FROM agent_goals WHERE parent_goal_id IN (${placeholders})`,
    goalIds
  );
  return rows.map((row) => row.id).filter(Boolean);
};

export const deleteGoal = async (goalId, { includeChildren = true } = {}) => {
  assertId(goalId, 'goalId');

  const existing = await get('SELECT id FROM agent_goals WHERE id = ?', [goalId]);
  if (!existing) {
    return { deleted: false, deletedGoalIds: [] };
  }

  const toDelete = [Number(goalId)];

  if (includeChildren) {
    const queue = [Number(goalId)];
    const seen = new Set(queue);

    while (queue.length > 0) {
      const batch = queue.splice(0, 50);
      const children = await listChildGoalIds(batch);
      for (const childId of children) {
        const numeric = Number(childId);
        if (!numeric || seen.has(numeric)) continue;
        seen.add(numeric);
        toDelete.push(numeric);
        queue.push(numeric);
      }
    }
  }

  const placeholders = toDelete.map(() => '?').join(',');

  // Be defensive: SQLite foreign keys may not be enforced unless explicitly enabled.
  await runWithMeta(`DELETE FROM agent_tasks WHERE goal_id IN (${placeholders})`, toDelete);
  const result = await runWithMeta(`DELETE FROM agent_goals WHERE id IN (${placeholders})`, toDelete);

  return { deleted: result.changes > 0, deletedGoalIds: toDelete };
};

export const __testing = {
  listChildGoalIds,
  buildBranchName
};

export default {
  createGoal,
  getGoal,
  listGoals,
  updateGoalStatus,
  updateGoalLifecycleState,
  createGoalTask,
  getGoalTask,
  listGoalTasks,
  updateGoalTaskStatus,
  deleteGoal
};
