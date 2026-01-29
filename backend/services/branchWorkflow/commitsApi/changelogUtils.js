import JSON5 from 'json5';

export const parseSemver = (value) => {
  let input = '';
  if (typeof value === 'string') {
    input = value.trim();
  } else {
    /* c8 ignore next */
    input = '';
  }
  const match = input.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
};

export const formatSemver = (parts) => `${parts.major}.${parts.minor}.${parts.patch}`;

export const incrementPatch = (version) => {
  const parsed = parseSemver(version);
  if (!parsed) {
    return null;
  }
  return formatSemver({ ...parsed, patch: parsed.patch + 1 });
};

export const extractUnreleasedEntries = (text) => {
  let input = '';
  if (typeof text === 'string') {
    input = text;
  } else {
    /* c8 ignore next */
    input = '';
  }
  const normalized = input.replace(/\r\n/g, '\n');
  const match = normalized.match(/^##\s+Unreleased\s*$/im);
  if (!match || match.index == null) {
    return { hasHeading: false, entries: [], body: '' };
  }

  const start = match.index + match[0].length;
  const rest = normalized.slice(start);
  const nextHeading = rest.search(/^##\s+/m);
  const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).replace(/^\n+/, '');
  const entries = body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => /^-\s+\S+/.test(line.trim()));

  return { hasHeading: true, entries, body };
};

export const rollChangelogToVersion = (text, newVersion) => {
  let input = '';
  if (typeof text === 'string') {
    input = text;
  } else {
    /* c8 ignore next */
    input = '';
  }
  const eol = input.includes('\r\n') ? '\r\n' : '\n';
  const normalized = input.replace(/\r\n/g, '\n');
  const match = normalized.match(/^##\s+Unreleased\s*$/im);
  if (!match || match.index == null) {
    return input;
  }

  const start = match.index + match[0].length;
  const rest = normalized.slice(start);
  const nextHeading = rest.search(/^##\s+/m);
  const tail = nextHeading === -1 ? '' : rest.slice(nextHeading);

  const extracted = extractUnreleasedEntries(normalized);
  if (!extracted.entries.length) {
    return input;
  }

  const date = new Date().toISOString().slice(0, 10);
  const injected = `\n\n## ${newVersion} (${date})\n\n${extracted.entries.join('\n')}\n`;
  const clearedUnreleased = '\n\n- (Add notes for your next merge here)\n';
  const rebuilt =
    normalized.slice(0, match.index) +
    match[0] +
    clearedUnreleased +
    injected +
    tail.replace(/^\n+/, '\n');

  return rebuilt.replace(/\n/g, eol);
};

export const extractFirstJsonObject = (text) => {
  const input = typeof text === 'string' ? text.trim() : '';
  if (!input) {
    return null;
  }

  // Fast path: whole response is JSON.
  if (input.startsWith('{') && input.endsWith('}')) {
    return input;
  }

  // Best-effort: grab the first {...} block.
  const match = input.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
};

export const parseChangelogEntryJson = (raw) => {
  const candidate = extractFirstJsonObject(raw);
  if (!candidate) {
    return null;
  }

  try {
    const parsed = JSON5.parse(candidate);
    const entry = parsed?.entry;
    if (typeof entry !== 'string') {
      return null;
    }
    const cleaned = entry
      .trim()
      .replace(/^[-*]\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!cleaned || cleaned.length < 6) {
      return null;
    }
    return cleaned.slice(0, 200);
  } catch {
    return null;
  }
};
