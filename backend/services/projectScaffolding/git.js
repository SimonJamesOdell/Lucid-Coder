import {
  runGitCommand,
  ensureGitRepository,
  configureGitUser,
  ensureInitialCommit
} from '../../utils/git.js';

export const initializeGitRepository = async (projectPath, gitOptions = {}) => {
  if (!projectPath) {
    throw new Error('Project path is required to initialize git.');
  }

  const defaultBranch = (gitOptions.defaultBranch || 'main').trim() || 'main';
  console.log('🔧 Initializing git repository...');

  await ensureGitRepository(projectPath, { defaultBranch });

  const remoteUrl = typeof gitOptions.remoteUrl === 'string' ? gitOptions.remoteUrl.trim() : '';
  if (remoteUrl) {
    try {
      await runGitCommand(projectPath, ['remote', 'add', 'origin', remoteUrl]);
    } catch (remoteError) {
      if (!/already exists/i.test(remoteError.message || '')) {
        console.error('❌ Failed to configure git remote:', remoteError.message);
        throw new Error(remoteError.message || 'Failed to configure git remote');
      }
    }
  }

  await configureGitUser(projectPath, {
    name: gitOptions.username,
    email: gitOptions.email || (gitOptions.username ? `${gitOptions.username}@users.noreply.github.com` : undefined)
  });

  await ensureInitialCommit(projectPath, 'Initial commit');

  return { initialized: true, branch: defaultBranch, remote: remoteUrl || null };
};

export const initializeAndPushRepository = async (projectPath, gitOptions = {}) => {
  if (!projectPath) {
    throw new Error('Project path is required to initialize git.');
  }

  const defaultBranch = (gitOptions.defaultBranch || 'main').trim() || 'main';
  const remoteUrl = typeof gitOptions.remoteUrl === 'string' ? gitOptions.remoteUrl.trim() : '';
  if (!remoteUrl) {
    throw new Error('Remote URL is required to push the repository.');
  }

  await ensureGitRepository(projectPath, { defaultBranch });

  const { stdout, code } = await runGitCommand(projectPath, ['remote', 'get-url', 'origin'], { allowFailure: true });
  const existingRemote = typeof stdout === 'string' ? stdout.trim() : '';
  if (code === 0 && existingRemote) {
    if (existingRemote !== remoteUrl) {
      await runGitCommand(projectPath, ['remote', 'set-url', 'origin', remoteUrl]);
    }
  } else {
    await runGitCommand(projectPath, ['remote', 'add', 'origin', remoteUrl]);
  }

  await configureGitUser(projectPath, {
    name: gitOptions.username,
    email: gitOptions.email || (gitOptions.username ? `${gitOptions.username}@users.noreply.github.com` : undefined)
  });

  await runGitCommand(projectPath, ['checkout', '-B', defaultBranch]);
  await ensureInitialCommit(projectPath, 'Initial commit');

  const headCheck = await runGitCommand(projectPath, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
  if (headCheck.code !== 0) {
    return {
      initialized: true,
      pushed: false,
      branch: defaultBranch,
      remote: remoteUrl,
      message: 'No commits found to push.'
    };
  }

  await runGitCommand(projectPath, ['push', '-u', 'origin', defaultBranch]);

  return { initialized: true, pushed: true, branch: defaultBranch, remote: remoteUrl };
};
