const normalizeJsonLikeText = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  return value
    .replace(/\u00a0/gi, ' ')
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'");
};

const stripCodeFences = (value) => {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  const normalized = normalizeJsonLikeText(trimmed);
  const fenced = normalized.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced && typeof fenced[1] === 'string') {
    return normalizeJsonLikeText(fenced[1].trim());
  }
  return normalized;
};

const extractFirstJsonObjectSubstring = (value) => {
  const text = value;
  let startIndex = -1;
  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (ch === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (ch === '{') {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
    }

    if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && startIndex !== -1) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
};

const extractJsonObject = (raw) => {
  if (raw == null) {
    return null;
  }

  const trimmed = stripCodeFences(raw);
  if (!trimmed || typeof trimmed !== 'string') {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Attempt to recover the first JSON object if the model wrapped it with prose.
    const recovered = extractFirstJsonObjectSubstring(trimmed);
    if (!recovered) {
      return null;
    }
    try {
      return JSON.parse(recovered);
    } catch {
      return null;
    }
  }
};

export {
  extractJsonObject,
  extractFirstJsonObjectSubstring,
  normalizeJsonLikeText,
  stripCodeFences
};
