export function buildBaseProjectData({ name, description, frontend, backend }) {
  return {
    name: name.trim(),
    description: description.trim(),
    frontend: {
      language: frontend.language,
      framework: frontend.framework
    },
    backend: {
      language: backend.language,
      framework: backend.framework
    }
  };
}

export function resolveNormalizedGitConfig({ mode, gitProvider, gitSettings }) {
  const providerFromGlobal = (gitSettings?.provider || 'github').toLowerCase();
  const normalizedProvider = (mode === 'custom' ? gitProvider : providerFromGlobal) || 'github';
  const defaultBranch = (gitSettings?.defaultBranch || 'main').trim() || 'main';
  const username = typeof gitSettings?.username === 'string' ? gitSettings.username.trim() : '';

  return {
    normalizedProvider,
    defaultBranch,
    username
  };
}

export function attachGitConnectionDetails(projectData, {
  mode,
  normalizedProvider,
  remoteUrl,
  token
}) {
  if (mode === 'local') {
    return projectData;
  }

  const nextData = {
    ...projectData,
    gitRemoteUrl: remoteUrl.trim(),
    gitConnectionProvider: normalizedProvider
  };

  if (mode === 'custom') {
    nextData.gitToken = token.trim();
  }

  return nextData;
}

export function buildConnectExistingProjectGitDetails({
  normalizedProvider,
  defaultBranch,
  username,
  remoteUrl,
  mode,
  token
}) {
  const details = {
    gitCloudMode: 'connect',
    gitRemoteUrl: remoteUrl.trim(),
    gitProvider: normalizedProvider,
    gitDefaultBranch: defaultBranch
  };

  if (username) {
    details.gitUsername = username;
  }

  if (mode === 'custom') {
    details.gitToken = token.trim();
  }

  return details;
}
