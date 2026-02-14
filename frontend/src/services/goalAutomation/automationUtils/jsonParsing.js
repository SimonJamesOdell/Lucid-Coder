const escapeControlCharsInStrings = (text) => {
  let result = '';
  let inString = false;
  let stringChar = '';
  let escape = false;

  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];

    if (inString) {
      if (escape) {
        result += ch;
        escape = false;
        continue;
      }

      if (ch === '\\') {
        result += ch;
        escape = true;
        continue;
      }

      if (ch === stringChar) {
        inString = false;
        stringChar = '';
        result += ch;
        continue;
      }

      if (ch === '\n') {
        result += '\\n';
        continue;
      }

      if (ch === '\r') {
        result += '\\r';
        continue;
      }

      result += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      result += ch;
      continue;
    }

    result += ch;
  }

  return result;
};

export const normalizeJsonLikeText = (input) => {
  if (typeof input !== 'string') {
    return '';
  }

  const decoded = input.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  const unifiedQuotes = decoded
    .replace(/\u00a0/gi, ' ')
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'");

  return escapeControlCharsInStrings(unifiedQuotes);
};

export const extractJsonObjectFromIndex = (text, start) => {
  if (typeof text !== 'string' || start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let stringChar = '"';
  let escape = false;

  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '/' && text[index + 1] === '/') {
      const newlineIndex = text.indexOf('\n', index + 2);
      if (newlineIndex === -1) {
        return null;
      }
      index = newlineIndex;
      continue;
    }

    if (ch === '/' && text[index + 1] === '*') {
      const commentEnd = text.indexOf('*/', index + 2);
      if (commentEnd === -1) {
        return null;
      }
      index = commentEnd + 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
};

export const extractJsonArrayFromIndex = (text, start) => {
  if (typeof text !== 'string' || start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let stringChar = '"';
  let escape = false;

  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '/' && text[index + 1] === '/') {
      const newlineIndex = text.indexOf('\n', index + 2);
      if (newlineIndex === -1) {
        return null;
      }
      index = newlineIndex;
      continue;
    }

    if (ch === '/' && text[index + 1] === '*') {
      const commentEnd = text.indexOf('*/', index + 2);
      if (commentEnd === -1) {
        return null;
      }
      index = commentEnd + 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '[') {
      depth += 1;
      continue;
    }

    if (ch === ']') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }

  return null;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const extractJsonObjectWithKey = (value, keyName) => {
  if (typeof value !== 'string' || !keyName) {
    return null;
  }

  const text = normalizeJsonLikeText(value);
  const start = text.indexOf('{');
  if (start < 0) {
    return null;
  }

  const keyRegex = new RegExp(`["']?${escapeRegex(keyName)}["']?\\s*:`);

  for (let index = start; index >= 0; index = text.indexOf('{', index + 1)) {
    const candidate = extractJsonObjectFromIndex(text, index);
    if (candidate && keyRegex.test(candidate)) {
      return candidate;
    }
  }

  return null;
};

export const extractJsonObject = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const text = normalizeJsonLikeText(value);
  const start = text.indexOf('{');
  if (start < 0) {
    return null;
  }

  return extractJsonObjectFromIndex(text, start);
};

export const extractJsonArray = (value) => {
  if (typeof value !== 'string') {
    return null;
  }

  const text = normalizeJsonLikeText(value);
  const start = text.indexOf('[');
  if (start < 0) {
    return null;
  }

  return extractJsonArrayFromIndex(text, start);
};

export const tryParseLooseJson = (value) => {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    return value;
  }
  if (typeof value !== 'string') {
    return null;
  }

  let text = normalizeJsonLikeText(value).trim();

  while (/^\{\s*\{/.test(text) && /\}\s*\}$/.test(text)) {
    text = text.slice(1, -1).trim();
  }

  const removeCommentsOutsideStrings = (input) => {
    let output = '';
    let inString = false;
    let escape = false;
    let stringChar = '"';

    for (let index = 0; index < input.length; index += 1) {
      const ch = input[index];

      if (inString) {
        output += ch;
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === stringChar) {
          inString = false;
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        output += ch;
        continue;
      }

      if (ch === '/' && input[index + 1] === '/') {
        const newlineIndex = input.indexOf('\n', index + 2);
        if (newlineIndex === -1) {
          break;
        }
        index = newlineIndex;
        output += '\n';
        continue;
      }

      if (ch === '/' && input[index + 1] === '*') {
        const commentEnd = input.indexOf('*/', index + 2);
        if (commentEnd === -1) {
          break;
        }
        index = commentEnd + 1;
        continue;
      }

      output += ch;
    }

    return output;
  };

  text = removeCommentsOutsideStrings(text);
  text = text.replace(/'/g, '"');

  const quoteUnquotedKeysOutsideStrings = (input) => {
    let output = '';
    let inString = false;
    let escape = false;

    for (let index = 0; index < input.length; index += 1) {
      const ch = input[index];

      if (inString) {
        output += ch;
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        output += ch;
        continue;
      }

      if (ch === '{' || ch === ',') {
        output += ch;
        let lookahead = index + 1;

        while (lookahead < input.length && /\s/.test(input[lookahead])) {
          output += input[lookahead];
          lookahead += 1;
        }

        if (input[lookahead] === '"') {
          index = lookahead - 1;
          continue;
        }

        if (/[A-Za-z_]/.test(input[lookahead] || '')) {
          const start = lookahead;
          lookahead += 1;
          while (lookahead < input.length && /[A-Za-z0-9_]/.test(input[lookahead])) {
            lookahead += 1;
          }
          const key = input.slice(start, lookahead);

          let ws = lookahead;
          while (ws < input.length && /\s/.test(input[ws])) {
            ws += 1;
          }

          if (input[ws] === ':') {
            output += `"${key}"`;
            output += input.slice(lookahead, ws);
            output += ':';
            index = ws;
            continue;
          }
        }

        index = lookahead - 1;
        continue;
      }

      output += ch;
    }

    return output;
  };

  const removeTrailingCommasOutsideStrings = (input) => {
    let output = '';
    let inString = false;
    let escape = false;

    for (let index = 0; index < input.length; index += 1) {
      const ch = input[index];

      if (inString) {
        output += ch;
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        output += ch;
        continue;
      }

      if (ch === ',') {
        let lookahead = index + 1;
        while (lookahead < input.length && /\s/.test(input[lookahead])) {
          lookahead += 1;
        }
        const next = input[lookahead];
        if (next === '}' || next === ']') {
          continue;
        }
      }

      output += ch;
    }

    return output;
  };

  text = quoteUnquotedKeysOutsideStrings(text);
  text = removeTrailingCommasOutsideStrings(text);

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

