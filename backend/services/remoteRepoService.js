import axios from 'axios';

const SUPPORTED_PROVIDERS = new Set(['github', 'gitlab']);

export class RemoteRepoCreationError extends Error {
  constructor(message, { statusCode = 400, provider = 'github', details = null } = {}) {
    super(message);
    this.name = 'RemoteRepoCreationError';
    this.statusCode = statusCode;
    this.provider = provider;
    this.details = details;
  }
}

const normalizeVisibility = (value) => (value === 'public' ? 'public' : 'private');

const sanitizeName = (value) => {
  if (!value) {
    return 'lucidcoder-project';
  }
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9-_\. ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'lucidcoder-project';
};

const mapAxiosError = (provider, error, fallback = 'Failed to create remote repository') => {
  if (!error || typeof error !== 'object') {
    return { message: fallback, statusCode: 500 };
  }

  if (error.response) {
    /* c8 ignore next */
    const details = error.response.data || null;
    const providerMessage = details && (details.message || details.error);
    return {
      message: providerMessage || fallback,
      statusCode: error.response.status || 400,
      details
    };
  }

  if (error.request) {
    return {
      message: 'No response from provider API',
      statusCode: 504,
      details: null
    };
  }

  return {
    message: error.message || fallback,
    statusCode: 500,
    details: null
  };
};

const createGithubRepository = async ({ token, name, description, visibility, owner }) => {
  if (!token?.trim()) {
    throw new RemoteRepoCreationError('Authentication token is required to create a GitHub repository');
  }

  const normalizedName = sanitizeName(name);
  const headers = {
    Authorization: `Bearer ${token.trim()}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'LucidCoder'
  };

  const payload = {
    name: normalizedName,
    description: description?.trim() || undefined,
    private: visibility !== 'public'
  };

  const targetOwner = owner?.trim();
  const endpoint = targetOwner
    ? `https://api.github.com/orgs/${encodeURIComponent(targetOwner)}/repos`
    : 'https://api.github.com/user/repos';

  try {
    const { data } = await axios.post(endpoint, payload, { headers });
    return {
      provider: 'github',
      id: data.id,
      name: data.name,
      owner: data.owner?.login || targetOwner || null,
      remoteUrl: data.clone_url,
      sshUrl: data.ssh_url,
      htmlUrl: data.html_url,
      visibility: data.private ? 'private' : 'public',
      defaultBranch: data.default_branch || 'main'
    };
  } catch (error) {
    const { message, statusCode, details } = mapAxiosError('github', error);
    throw new RemoteRepoCreationError(message, { statusCode, provider: 'github', details });
  }
};

const fetchGitlabNamespaceId = async (token, namespacePath) => {
  if (!namespacePath) {
    return null;
  }

  const headers = {
    'Private-Token': token.trim()
  };
  try {
    const { data } = await axios.get('https://gitlab.com/api/v4/namespaces', {
      headers,
      params: {
        search: namespacePath,
        per_page: 20
      }
    });
    if (!Array.isArray(data)) {
      return null;
    }
    const match = data.find((entry) => {
      if (!entry) {
        return false;
      }
      const normalized = namespacePath.toLowerCase();
      return (
        entry.path?.toLowerCase() === normalized ||
        entry.full_path?.toLowerCase() === normalized ||
        entry.name?.toLowerCase() === normalized
      );
    });
    return match ? match.id : null;
  } catch (error) {
    const { message, statusCode, details } = mapAxiosError('gitlab', error, 'Failed to resolve GitLab namespace');
    throw new RemoteRepoCreationError(message, { statusCode, provider: 'gitlab', details });
  }
};

const createGitlabRepository = async ({ token, name, description, visibility, owner }) => {
  if (!token?.trim()) {
    throw new RemoteRepoCreationError('Authentication token is required to create a GitLab repository', { provider: 'gitlab' });
  }

  const normalizedName = sanitizeName(name);
  const headers = {
    'Private-Token': token.trim()
  };

  const payload = {
    name: normalizedName,
    path: normalizedName.toLowerCase(),
    description: description?.trim() || undefined,
    visibility: normalizeVisibility(visibility)
  };

  const namespacePath = owner?.trim();
  if (namespacePath) {
    const namespaceId = await fetchGitlabNamespaceId(token, namespacePath);
    if (!namespaceId) {
      throw new RemoteRepoCreationError(`GitLab namespace "${namespacePath}" was not found or is not accessible`, { provider: 'gitlab', statusCode: 404 });
    }
    payload.namespace_id = namespaceId;
  }

  try {
    const { data } = await axios.post('https://gitlab.com/api/v4/projects', payload, { headers });
    return {
      provider: 'gitlab',
      id: data.id,
      name: data.name,
      owner: data.namespace?.full_path || namespacePath || null,
      remoteUrl: data.http_url_to_repo,
      sshUrl: data.ssh_url,
      htmlUrl: data.web_url,
      visibility: data.visibility || payload.visibility,
      defaultBranch: data.default_branch || 'main'
    };
  } catch (error) {
    const { message, statusCode, details } = mapAxiosError('gitlab', error);
    throw new RemoteRepoCreationError(message, { statusCode, provider: 'gitlab', details });
  }
};

export const createRemoteRepository = async (options = {}) => {
  const requestedProvider = options.provider || 'github';
  const provider = requestedProvider.toLowerCase();
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    throw new RemoteRepoCreationError(`Unsupported git provider: ${requestedProvider}`, { statusCode: 400, provider });
  }

  const visibility = normalizeVisibility(options.visibility);
  const normalizedOptions = {
    token: options.token,
    name: options.name || options.projectName || 'lucidcoder-project',
    description: options.description,
    visibility,
    owner: options.owner
  };

  if (provider === 'gitlab') {
    return createGitlabRepository(normalizedOptions);
  }
  return createGithubRepository(normalizedOptions);
};

export const __testUtils = {
  normalizeVisibility,
  sanitizeName,
  mapAxiosError,
  fetchGitlabNamespaceId
};

export default {
  createRemoteRepository,
  RemoteRepoCreationError
};
