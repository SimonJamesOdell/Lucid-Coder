import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const fail = (message) => {
  console.error(`release:prep failed: ${message}`);
  process.exit(1);
};

const run = (cmd, args, { cwd } = {}) => {
  const resolvedCwd = cwd || process.cwd();

  // On Windows, executables like npm/yarn are commonly shimmed as .cmd files.
  // Spawning them directly can throw EINVAL in some environments.
  // Route those through cmd.exe for robustness.
  if (process.platform === 'win32' && typeof cmd === 'string' && cmd.toLowerCase().endsWith('.cmd')) {
    const commandLine = [cmd, ...(args || [])]
      .map((token) => {
        const value = String(token);
        return /[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
      })
      .join(' ');

    execFileSync('cmd.exe', ['/d', '/s', '/c', commandLine], {
      cwd: resolvedCwd,
      stdio: 'inherit'
    });
    return;
  }

  execFileSync(cmd, args, {
    cwd: resolvedCwd,
    stdio: 'inherit'
  });
};

const runCapture = (cmd, args, { cwd } = {}) => execFileSync(cmd, args, {
  cwd: cwd || process.cwd(),
  encoding: 'utf8'
});

const ensureChangelogEntry = async ({ repoRoot, version }) => {
  const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
  const raw = await fs.readFile(changelogPath, 'utf8');

  if (raw.includes(`## ${version} (`)) {
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const header = `## ${version} (${today})\n- (Fill in release notes)\n\n`;

  if (raw.startsWith('# Changelog')) {
    const insertAt = raw.indexOf('\n\n') + 2;
    const updated = `${raw.slice(0, insertAt)}${header}${raw.slice(insertAt)}`;
    await fs.writeFile(changelogPath, updated, 'utf8');
    return;
  }

  await fs.writeFile(changelogPath, `${header}${raw}`, 'utf8');
};

const mainAsync = async () => {
  const version = process.argv[2];
  if (!version || typeof version !== 'string') {
    fail('missing version. Usage: npm run release:prep -- <semver>');
  }

  const repoRoot = process.cwd();

  const status = runCapture('git', ['status', '--porcelain=v1'], { cwd: repoRoot }).trim();
  if (status.length > 0) {
    fail('git working tree is not clean (commit or stash changes before prepping a release)');
  }

  const bumpScript = path.join(repoRoot, 'tools', 'bump-version.mjs');
  run(process.execPath, [bumpScript, version], { cwd: repoRoot });

  await ensureChangelogEntry({ repoRoot, version });

  // 3) Commit the bump + changelog stub so release:check can enforce a clean tree.
  run('git', ['add', '-A'], { cwd: repoRoot });
  run('git', ['commit', '-m', `chore: prep ${version}`], { cwd: repoRoot });

  // 4) Run the local release gates.
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  run(npmCmd, ['run', 'release:gate'], { cwd: repoRoot });
};

try {
  await mainAsync();
} catch (error) {
  fail(error?.message || 'unknown error');
}
