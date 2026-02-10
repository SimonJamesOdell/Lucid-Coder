const safeTrim = (value) => (typeof value === 'string' ? value.trim() : '');

export const stripGitCredentials = (value) => {
  const raw = safeTrim(value);
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return raw;
  }
};

export const buildCloneUrl = ({ url, authMethod, token, username, provider }) => {
  const rawUrl = safeTrim(url);
  const trimmedToken = safeTrim(token);
  const normalizedAuth = authMethod === 'ssh' ? 'ssh' : 'pat';
  const normalizedProvider = safeTrim(provider).toLowerCase();

  if (normalizedAuth !== 'pat' || !trimmedToken) {
    return {
      cloneUrl: rawUrl,
      safeUrl: stripGitCredentials(rawUrl)
    };
  }

  try {
    const parsed = new URL(rawUrl);
    const fallbackUser = normalizedProvider === 'gitlab' ? 'oauth2' : 'x-access-token';
    const authUser = safeTrim(username) || fallbackUser;
    parsed.username = authUser;
    parsed.password = trimmedToken;
    return {
      cloneUrl: parsed.toString(),
      safeUrl: stripGitCredentials(parsed.toString())
    };
  } catch {
    return {
      cloneUrl: rawUrl,
      safeUrl: stripGitCredentials(rawUrl)
    };
  }
};
