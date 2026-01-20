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
