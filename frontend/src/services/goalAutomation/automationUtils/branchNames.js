export const extractBranchName = (raw, fallbackName) => {
  const fallback = String(fallbackName).trim();

  const isMeaningfulKebab = (value) => {
    const trimmed = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(trimmed)) {
      return false;
    }
    const parts = trimmed.split('-');
    if (parts.length < 2 || parts.length > 5) {
      return false;
    }
    return parts.every((part) => /[a-z]/.test(part));
  };

  const slugify = (value) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 40);

  const text = String(raw).trim();
  if (!text) {
    return fallback;
  }

  const quoted = text.match(/['"]([a-z0-9]+(?:-[a-z0-9]+)+)['"]/i);
  if (quoted?.[1]) {
    const candidate = slugify(quoted[1]);
    if (candidate && isMeaningfulKebab(candidate)) {
      return candidate;
    }
  }

  const tokens = text.match(/[a-z0-9]+(?:-[a-z0-9]+)+/gi) || [];
  const token = tokens
    .map((t) => slugify(t))
    .find((candidate) => isMeaningfulKebab(candidate));
  if (token) {
    return token;
  }

  const slugged = slugify(text);
  return isMeaningfulKebab(slugged) ? slugged : fallback;
};

export const parseBranchNameFromLLMText = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const candidate = parsed?.branch ?? parsed?.name;
      return typeof candidate === 'string' ? candidate.trim() : '';
    } catch {
      // Fall through to treat it as plain text.
    }
  }

  const quoted = trimmed.match(/["']([a-z0-9]+(?:-[a-z0-9]+)+)["']/i);
  if (quoted?.[1]) {
    return quoted[1].trim();
  }

  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(trimmed)) {
    return trimmed;
  }

  const isPlainPhrase = /^[a-z0-9 ]+$/i.test(trimmed) && /[a-z]/i.test(trimmed);
  if (isPlainPhrase) {
    return trimmed;
  }

  return '';
};

export const extractBranchPromptContext = (prompt) => {
  const raw = String(prompt || '').trim();
  if (!raw) {
    return '';
  }

  const extractMatch = (pattern) => {
    const match = raw.match(pattern);
    if (!match?.[1]) {
      return '';
    }
    return String(match[1]).trim();
  };

  const directCurrentRequest = extractMatch(/(?:^|\n)\s*Current request:\s*([\s\S]+)$/i);
  if (directCurrentRequest) {
    return directCurrentRequest.split('\n').map((line) => line.trim()).find(Boolean);
  }

  const directUserAnswer = extractMatch(/(?:^|\n)\s*User answer:\s*([\s\S]+)$/i);
  if (directUserAnswer) {
    return directUserAnswer.split('\n').map((line) => line.trim()).find(Boolean);
  }

  const originalRequest = extractMatch(
    /(?:^|\n)\s*Original request:\s*([\s\S]+?)(?:\n\s*Clarification questions:|$)/i
  );
  if (originalRequest) {
    if (/\b(Current request|User answer):/i.test(originalRequest)) {
      const nested = extractBranchPromptContext(originalRequest);
      if (nested && nested !== originalRequest) {
        return nested;
      }
    }
    return originalRequest.split('\n').map((line) => line.trim()).find(Boolean);
  }

  return raw.split('\n').map((line) => line.trim()).find(Boolean);
};

export const isValidBranchName = (name) => {
  const trimmed = String(name).trim();
  if (trimmed === 'kebab-case') return false;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(trimmed)) return false;
  const parts = trimmed.split('-');
  return parts.length >= 2 && parts.length <= 5 && parts.every((part) => /[a-z]/.test(part));
};

export const buildFallbackBranchNameFromPrompt = (prompt, fallbackName) => {
  const fallback = String(fallbackName || '').trim();
  const raw = String(prompt || '').toLowerCase();
  if (!raw.trim()) {
    return fallback;
  }

  const stopwords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by',
    'can', 'could', 'do', 'does', 'for', 'from', 'give', 'have', 'has', 'had',
    'how', 'i', 'if', 'in', 'into', 'is', 'it', "it's", 'its',
    'let', "let's", 'make', 'me', 'need', 'of', 'on', 'or', 'our', 'please',
    'should', 'so', 'some', 'that', 'the', 'their', 'then', 'there',
    'this', 'to', 'up', 'want', 'we', 'with', 'would', 'you', 'your'
  ]);

  const words = raw
    .replace(/[^a-z0-9\s-]+/g, ' ')
    .split(/[\s-]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !stopwords.has(w))
    .filter((w) => !/^\d+$/.test(w));

  const picked = [];
  for (const word of words) {
    picked.push(word);
    if (picked.length >= 4) {
      break;
    }
  }

  if (picked.length < 2) {
    return fallback;
  }

  const candidate = picked.join('-');
  return extractBranchName(candidate, fallback);
};

export const isBranchNameRelevantToPrompt = (branchName, prompt) => {
  const normalize = (value) => String(value || '')
    .toLowerCase()
    .replace(/\//g, ' ')
    .replace(/[^a-z0-9\s-]+/g, ' ');

  const stopwords = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by',
    'can', 'could', 'do', 'does', 'for', 'from', 'give', 'have', 'has', 'had',
    'how', 'i', 'if', 'in', 'into', 'is', 'it', "it's", 'its',
    'let', "let's", 'make', 'me', 'need', 'of', 'on', 'or', 'our', 'please',
    'should', 'so', 'some', 'that', 'the', 'their', 'then', 'there',
    'this', 'to', 'up', 'want', 'we', 'with', 'would', 'you', 'your'
  ]);

  const tokenize = (value) => normalize(value)
    .split(/[\s-]+/)
    .map((w) => w.trim())
    .filter(Boolean)
    .filter((w) => !stopwords.has(w))
    .filter((w) => !/^\d+$/.test(w));

  const promptTokens = new Set(tokenize(prompt));
  const branchTokens = new Set(tokenize(branchName));

  if (promptTokens.size === 0 || branchTokens.size === 0) {
    return true;
  }

  // If the prompt is too short (e.g. just "test" or "refactor"), we don't have
  // enough signal to reliably judge relevance.
  if (promptTokens.size < 2) {
    return true;
  }

  for (const token of branchTokens) {
    if (promptTokens.has(token)) {
      return true;
    }
  }
  return false;
};
