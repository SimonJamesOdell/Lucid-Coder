import axios from 'axios';

const SUPPORTED_PROVIDERS = new Set(['github', 'gitlab']);

export class GitConnectionError extends Error {
  constructor(message, { statusCode = 400, provider = 'github', details = null } = {}) {
    super(message);
    this.name = 'GitConnectionError';
    this.statusCode = statusCode;
    this.provider = provider;
    this.details = details;
  }
}

const normalizeProvider = (provider) => (provider || 'github').toLowerCase();

const mapAxiosError = (provider, error, fallback = 'Failed to test git connection') => {
  if (!error || typeof error !== 'object') {
    return { message: fallback, statusCode: 500, details: null };
  }

  if (error.response) {
    const details = error.response.data || null;
    const providerMessage = details && (details.message || details.error || details.error_description);
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

const testGithubConnection = async (token) => {
  if (!token?.trim()) {
    throw new GitConnectionError('Personal access token is required to test connection', {
      provider: 'github'
    });
  }

  try {
    const { data } = await axios.get('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token.trim()}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'LucidCoder'
      }
    });

    return {
      provider: 'github',
      account: {
        id: data.id,
        login: data.login,
        name: data.name || ''
      },
      message: 'Connected to GitHub'
    };
  } catch (error) {
    const { message, statusCode, details } = mapAxiosError('github', error, 'GitHub connection failed');
    throw new GitConnectionError(message, { statusCode, provider: 'github', details });
  }
};

const testGitlabConnection = async (token) => {
  if (!token?.trim()) {
    throw new GitConnectionError('Personal access token is required to test connection', {
      provider: 'gitlab'
    });
  }

  try {
    const { data } = await axios.get('https://gitlab.com/api/v4/user', {
      headers: {
        'Private-Token': token.trim()
      }
    });

    return {
      provider: 'gitlab',
      account: {
        id: data.id,
        login: data.username,
        name: data.name || ''
      },
      message: 'Connected to GitLab'
    };
  } catch (error) {
    const { message, statusCode, details } = mapAxiosError('gitlab', error, 'GitLab connection failed');
    throw new GitConnectionError(message, { statusCode, provider: 'gitlab', details });
  }
};

export const testGitConnection = async ({ provider, token } = {}) => {
  const normalized = normalizeProvider(provider);
  if (!SUPPORTED_PROVIDERS.has(normalized)) {
    throw new GitConnectionError('Unsupported git provider', { provider: normalized });
  }

  if (normalized === 'gitlab') {
    return testGitlabConnection(token);
  }

  return testGithubConnection(token);
};
