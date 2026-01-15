import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';

const isWindows = process.platform === 'win32';
const DEFAULT_AUTHOR = {
  name: 'LucidCoder',
  email: 'dev@lucidcoder.local'
};

const execGit = (cwd, args, { allowFailure = false } = {}) => new Promise((resolve, reject) => {
  const child = spawn('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', (error) => {
    if (error.code === 'ENOENT') {
      const friendly = new Error('Git is not installed or not available on PATH.');
      friendly.code = 'GIT_MISSING';
      reject(friendly);
      return;
    }
    reject(error);
  });

  child.on('close', (code) => {
    if (code === 0 || allowFailure) {
      resolve({ stdout, stderr, code });
      return;
    }
    const message = (stderr || stdout || '').trim() || `git ${args.join(' ')} failed with code ${code}`;
    const error = new Error(message);
    error.code = code;
    error.stderr = stderr;
    reject(error);
  });
});

export const runGitCommand = async (projectPath, args, options = {}) => {
  if (!projectPath) {
    throw new Error('Cannot run git command without project path');
  }
  return execGit(projectPath, args, options);
};

export const ensureGitRepository = async (projectPath, { defaultBranch = 'main' } = {}) => {
  if (!projectPath) {
    throw new Error('Project path is required to ensure git repository');
  }

  try {
    await runGitCommand(projectPath, ['rev-parse', '--is-inside-work-tree']);
    return;
  } catch (error) {
    // Continue to initialization if repo missing
    if (error.code !== 128) {
      throw error;
    }
  }

  try {
    await runGitCommand(projectPath, ['init', '-b', defaultBranch]);
  } catch (initError) {
    // Older Git versions may not support -b flag during init
    if (initError.code === 129) {
      await runGitCommand(projectPath, ['init']);
      await runGitCommand(projectPath, ['checkout', '-B', defaultBranch]);
    } else {
      throw initError;
    }
  }
};

export const configureGitUser = async (projectPath, { name, email } = {}) => {
  const finalName = (name && name.trim()) || DEFAULT_AUTHOR.name;
  const finalEmail = (email && email.trim()) || DEFAULT_AUTHOR.email;

  await runGitCommand(projectPath, ['config', 'user.name', finalName]);
  await runGitCommand(projectPath, ['config', 'user.email', finalEmail]);
};

export const ensureInitialCommit = async (projectPath, message = 'Initial commit') => {
  await runGitCommand(projectPath, ['add', '--all']);
  try {
    await runGitCommand(projectPath, ['commit', '-m', message]);
  } catch (error) {
    if (/nothing to commit/i.test(error.message)) {
      return;
    }
    throw error;
  }
};

export const getCurrentBranch = async (projectPath) => {
  const { stdout } = await runGitCommand(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
};

export const hasWorkingTreeChanges = async (projectPath) => {
  const { stdout } = await runGitCommand(projectPath, ['status', '--porcelain']);
  return stdout.trim().length > 0;
};

const stashLabelFor = (branchName) => `lucidcoder-auto/${branchName}`;

export const stashWorkingTree = async (projectPath, branchName) => {
  if (!branchName) {
    return null;
  }
  const dirty = await hasWorkingTreeChanges(projectPath);
  if (!dirty) {
    return null;
  }
  const label = stashLabelFor(branchName);
  await runGitCommand(projectPath, ['stash', 'push', '--include-untracked', '-m', label]);
  return label;
};

export const popBranchStash = async (projectPath, branchName) => {
  if (!branchName) {
    return false;
  }
  const label = stashLabelFor(branchName);
  const { stdout } = await runGitCommand(projectPath, ['stash', 'list']);
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const targetLine = lines.find((line) => line.includes(label));
  if (!targetLine) {
    return false;
  }
  const match = targetLine.match(/(stash@\{\d+\})/);
  if (!match) {
    return false;
  }
  const ref = match[1];
  await runGitCommand(projectPath, ['stash', 'pop', ref]);
  return true;
};

export const commitAllChanges = async (projectPath, message) => {
  await runGitCommand(projectPath, ['add', '--all']);
  try {
    await runGitCommand(projectPath, ['commit', '-m', message]);
    return true;
  } catch (error) {
    if (/nothing to commit/i.test(error.message)) {
      return false;
    }
    throw error;
  }
};

export const ensureWorktreeClean = async (projectPath, branchName, message) => {
  const dirty = await hasWorkingTreeChanges(projectPath);
  if (!dirty) {
    return false;
  }
  const commitMessage = message || `chore(${branchName || 'workspace'}): auto-save`;
  return commitAllChanges(projectPath, commitMessage);
};

export const removeBranchStashes = async (projectPath, branchName) => {
  if (!branchName) {
    return;
  }
  const label = stashLabelFor(branchName);
  const { stdout } = await runGitCommand(projectPath, ['stash', 'list']);
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.includes(label)) {
      continue;
    }
    const match = line.match(/(stash@\{\d+\})/);
    if (!match) {
      continue;
    }
    await runGitCommand(projectPath, ['stash', 'drop', match[1]]);
  }
};

export const fileExistsInProject = async (projectPath, relativePath) => {
  if (!relativePath) {
    return false;
  }
  const absolute = path.join(projectPath, relativePath);
  try {
    const stats = await fs.stat(absolute);
    return stats.isFile();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};
