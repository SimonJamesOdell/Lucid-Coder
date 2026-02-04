import { promisify } from 'node:util';

// IMPORTANT:
// - This script targets the *real* local LucidCoder DB by default (same logic as backend/database.js).
// - It removes only projects created by Playwright E2E (name prefix "E2E ", description contains "Playwright E2E",
//   or known temp import path prefixes).
// - Dry-run by default. Use --apply to actually delete.

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SILENT = args.includes('--silent');

const log = (...values) => {
  if (!SILENT) {
    // eslint-disable-next-line no-console
    console.log(...values);
  }
};

const matchesAny = (value, patterns) => {
  if (!value) return false;
  const text = String(value).toLowerCase();
  return patterns.some((pattern) => text.includes(pattern));
};

const main = async () => {
  const { default: db } = await import('../database.js');

  // Promisified helpers over sqlite3.Database.
  const dbAll = promisify(db.all.bind(db));
  const dbRun = (...runArgs) =>
    new Promise((resolve, reject) => {
      db.run(...runArgs, function onRun(err) {
        if (err) reject(err);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });

  // These are intentionally conservative.
  const namePrefixes = ['e2e '];
  const descriptionNeedles = ['playwright e2e'];
  const pathNeedles = ['lucidcoder-e2e-import-', 'lucidcoder-e2e-projects-'];

  // Pull a wider set, then filter in JS so we can keep the SQL simple + avoid false positives.
  const projects = await dbAll(
    'SELECT id, name, description, path, created_at AS createdAt FROM projects ORDER BY created_at DESC'
  );

  const candidates = (projects || []).filter((row) => {
    const name = String(row?.name || '');
    const lowerName = name.toLowerCase();
    const nameHit = namePrefixes.some((prefix) => lowerName.startsWith(prefix));

    const descHit = matchesAny(row?.description, descriptionNeedles);
    const pathHit = matchesAny(row?.path, pathNeedles);

    // Additional safety: many E2E names include a timestamp.
    const timestampLike = /\b\d{12,}\b/.test(name);

    return nameHit || descHit || pathHit || (nameHit && timestampLike);
  });

  if (candidates.length === 0) {
    log('No E2E projects found to purge.');
    db.close();
    return;
  }

  log(`Found ${candidates.length} E2E project(s) in the local DB.`);
  for (const project of candidates) {
    log(`- [${project.id}] ${project.name}${project.description ? ` — ${project.description}` : ''}`);
  }

  if (!APPLY) {
    log('\nDry run only. Re-run with --apply to delete these projects.');
    db.close();
    return;
  }

  log('\nDeleting E2E projects (and related rows)…');

  // Best-effort cleanup of related tables (SQLite foreign_keys may not be enabled).
  // Keep deletes ordered to avoid leaving large orphan sets.
  let deletedProjects = 0;
  for (const project of candidates) {
    const projectId = project.id;

    await dbRun('BEGIN TRANSACTION');
    try {
      await dbRun(
        'DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE project_id = ?)',
        [projectId]
      );
      await dbRun('DELETE FROM runs WHERE project_id = ?', [projectId]);

      await dbRun(
        'DELETE FROM agent_tasks WHERE goal_id IN (SELECT id FROM agent_goals WHERE project_id = ?)',
        [projectId]
      );
      await dbRun('DELETE FROM agent_goals WHERE project_id = ?', [projectId]);

      await dbRun('DELETE FROM test_runs WHERE project_id = ?', [projectId]);
      await dbRun('DELETE FROM branches WHERE project_id = ?', [projectId]);
      await dbRun('DELETE FROM project_git_settings WHERE project_id = ?', [projectId]);
      await dbRun('DELETE FROM audit_logs WHERE project_id = ?', [projectId]);

      const result = await dbRun('DELETE FROM projects WHERE id = ?', [projectId]);
      if (result?.changes) {
        deletedProjects += 1;
      }

      await dbRun('COMMIT');
    } catch (error) {
      await dbRun('ROLLBACK');
      throw error;
    }
  }

  log(`Done. Deleted ${deletedProjects} project(s).`);
  db.close();
};

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('purge-e2e-projects failed:', error);
  process.exitCode = 1;
});
