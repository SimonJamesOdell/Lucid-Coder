const TITLE_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'but',
  'for',
  'from',
  'in',
  'of',
  'on',
  'or',
  'the',
  'to',
  'with'
]);

const TITLE_PREFIX_PATTERN =
  /^(?:please|can you|could you|would you|let['\u2019]?s|lets|we need to|i need to|need to|make sure to|ensure)[\s,:-]*/i;
const MAX_TITLE_LENGTH = 96;

const deriveGoalTitle = (value, { fallback = 'Goal' } = {}) => {
  const raw = typeof value === 'string' ? value : '';
  const trimmed = raw.trim();
  if (!trimmed) {
    return fallback;
  }

  const [firstLine] = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .concat(trimmed);

  const sanitized = firstLine.replace(/^['"`]+/, '').replace(/['"`]+$/, '');

  const withoutPrefix = sanitized.replace(TITLE_PREFIX_PATTERN, '').trim();
  if (!withoutPrefix) {
    return fallback;
  }

  const collapsed = withoutPrefix.replace(/\s+/g, ' ');
  const limited =
    collapsed.length > MAX_TITLE_LENGTH
      ? collapsed.slice(0, MAX_TITLE_LENGTH).replace(/\s+\S*$/, '')
      : collapsed;

  const words = limited.split(' ');
  const titled = words
    .map((word, index) => {
      const lower = word.toLowerCase();
      const preserveUpper =
        word === word.toUpperCase() &&
        /[A-Z]/.test(word) &&
        word.length <= 5 &&
        !TITLE_STOPWORDS.has(lower);
      if (preserveUpper) {
        return word;
      }
      if (index > 0 && TITLE_STOPWORDS.has(lower)) {
        return lower;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');

  return titled;
};

export { deriveGoalTitle };
