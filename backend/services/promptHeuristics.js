const normalizePrompt = (prompt = '') => String(prompt || '').trim().toLowerCase();

export const hasResolvedClarificationAnswers = (prompt = '') => {
  const raw = String(prompt || '');
  if (!raw) {
    return false;
  }

  if (!/\buser\s+answer\s*:/i.test(raw)) {
    return false;
  }

  if (/resolved\s+clarification\s+answers\s*:/i.test(raw)) {
    return true;
  }

  const userAnswerMatch = raw.match(/\bUser\s+answer\s*:([\s\S]*)$/i);
  if (!userAnswerMatch?.[1]) {
    return false;
  }

  const answerBlock = userAnswerMatch[1].trim();
  if (!answerBlock) {
    return false;
  }

  const multilineAnswer = answerBlock
    .split(/\r?\n/)
    .map((line) => String(line).trim())
    .find((line) => /^A\s*:\s*.+$/i.test(line));
  if (multilineAnswer) {
    return true;
  }

  return /\bA\s*:\s*[^\s].+/i.test(answerBlock);
};

export const extractSelectedProjectAssets = (prompt = '') => {
  const raw = String(prompt || '');
  if (!raw) {
    return [];
  }

  const lines = raw.split(/\r?\n/);
  let startIndex = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '').trim();
    if (/^selected\s+project\s+assets\s*:\s*$/i.test(line)) {
      startIndex = index + 1;
      break;
    }
  }

  if (startIndex < 0) {
    return [];
  }

  const collected = [];
  for (let index = startIndex; index < lines.length; index += 1) {
    const rawLine = String(lines[index] || '');
    const line = rawLine.trim();

    if (!line) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }

    if (/^[A-Za-z][A-Za-z0-9 _-]{0,40}:\s*$/.test(line)) {
      break;
    }

    const bulletMatch = line.match(/^(?:[-*•])\s+(.+)$/);
    const candidate = bulletMatch?.[1] ? bulletMatch[1].trim() : line;
    if (candidate) {
      collected.push(candidate);
    }
  }

  return Array.from(new Set(collected));
};

export const extractLatestRequest = (prompt = '') => {
  const raw = String(prompt || '');
  if (!raw) return raw;

  const SECTION_PREFIX_REGEX = /^(original request|current request|clarification questions|user answer|selected project assets|selected preview element path)\s*:/i;

  const looksLikeClarificationTranscript = (value = '') => {
    const text = String(value || '').trim();
    if (!text) {
      return false;
    }
    return /^q\s*:/i.test(text) || /^a\s*:/i.test(text) || /\n\s*q\s*:/i.test(text) || /\n\s*a\s*:/i.test(text);
  };

  const unwrapNestedLabel = (value, depth = 0) => {
    const trimmed = value.trim();
    if (!trimmed || depth >= 3) return trimmed;
    const nested = trimmed.match(/^(?:current request|user answer|original request)\s*:\s*([\s\S]+)$/i);
    if (!nested?.[1]) return trimmed;
    return unwrapNestedLabel(nested[1], depth + 1);
  };

  const lines = raw.split(/\r?\n/).map((line) => line.trim());
  const findSectionValueAfterPrefix = (prefix) => {
    const normalizedPrefix = String(prefix).toLowerCase();
    const isUserAnswerPrefix = normalizedPrefix === 'user answer:';

    for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
      const line = lines[idx];
      if (line.toLowerCase().startsWith(normalizedPrefix)) {
        const initial = line.slice(prefix.length).trim();
        const collected = [];
        if (initial) {
          collected.push(initial);
        }

        for (let follow = idx + 1; follow < lines.length; follow += 1) {
          const candidate = lines[follow];
          if (SECTION_PREFIX_REGEX.test(candidate)) {
            break;
          }
          if (isUserAnswerPrefix && (/^assistant\s*:/i.test(candidate) || /^user\s*:/i.test(candidate))) {
            break;
          }
          collected.push(candidate);
        }

        return collected.join('\n').trim();
      }
    }
    return '';
  };

  const extractClarificationAnswers = (value = '') => {
    const text = String(value || '').trim();
    if (!text) {
      return '';
    }

    const answerLines = text
      .split(/\r?\n/)
      .map((line) => {
        const match = String(line || '').trim().match(/^A\s*:\s*(.+)$/i);
        return match?.[1] ? match[1].trim() : '';
      })
      .filter(Boolean);

    if (answerLines.length > 0) {
      return answerLines.join('; ');
    }

    const inlineAnswers = [];
    const inlinePattern = /\bA\s*:\s*([\s\S]*?)(?=\s+Q\s*:|$)/gi;
    let match = inlinePattern.exec(text);
    while (match) {
      const candidate = String(match[1] || '').trim();
      inlineAnswers.push(candidate);
      match = inlinePattern.exec(text);
    }

    const normalizedInlineAnswers = inlineAnswers.filter(Boolean);

    if (normalizedInlineAnswers.length === 0) {
      return '';
    }

    return normalizedInlineAnswers.join('; ');
  };

  const current = findSectionValueAfterPrefix('Current request:');
  const answer = findSectionValueAfterPrefix('User answer:');
  const normalizedAnswer = answer ? unwrapNestedLabel(answer) : '';
  const answerLooksLikeClarification = looksLikeClarificationTranscript(normalizedAnswer);

  if (current) {
    const normalizedCurrent = unwrapNestedLabel(current);
    const resolvedAnswers = extractClarificationAnswers(normalizedAnswer);

    if (answerLooksLikeClarification && resolvedAnswers) {
      return `${normalizedCurrent}\n\nResolved clarification answers: ${resolvedAnswers}`;
    }
    return normalizedCurrent;
  }

  const original = findSectionValueAfterPrefix('Original request:');
  const normalizedOriginal = original ? unwrapNestedLabel(original) : '';
  if (normalizedOriginal) {
    return normalizedOriginal;
  }

  if (normalizedAnswer) {
    return normalizedAnswer;
  }

  const hasExplicitUserAnswerHeader = /(?:^|\n)\s*User\s+answer\s*:/i.test(raw);
  if (hasExplicitUserAnswerHeader) {
    return raw;
  }

  return unwrapNestedLabel(raw);
};

export const isStyleOnlyPrompt = (prompt = '') => {
  const text = normalizePrompt(extractLatestRequest(prompt));
  if (!text) return false;

  const targetedStyleSignals = [
    /\b(navbar|navigation\s+bar|nav\s+bar)\b/,
    /\b(header|footer|sidebar|hero|card|modal|toolbar)\b/,
    /\b(button|input|form|menu|dropdown|link|tab)\b/,
    /\b(for|on|in)\s+the\s+[a-z0-9_-]+\b/,
    /[.#][a-z0-9_-]+/
  ];
  if (targetedStyleSignals.some((re) => re.test(text))) {
    return false;
  }

  // Positive signals for style-only changes.
  // Require a "core" styling keyword (css/color/background/etc) so generic UI nouns
  // like "button" or "header" don't get misclassified as style-only.
  const coreStyleSignals = [
    /\bcss\b/, /\bstyle\b/, /\bstyling\b/, /\btheme\b/, /\bcolor\b/, /\bbackground\b/, /\bfont\b/, /\btypography\b/,
    /\bspacing\b/, /\bmargin\b/, /\bpadding\b/, /\bborder\b/, /\bradius\b/, /\bshadow\b/, /\blayout\b/
  ];
  const hasCoreStyleSignal = coreStyleSignals.some((re) => re.test(text));
  if (!hasCoreStyleSignal) return false;

  // Negative signals that suggest more than styling.
  const nonStyleSignals = [
    /\bapi\b/, /\bendpoint\b/, /\bdatabase\b/, /\bsql\b/, /\bschema\b/, /\bauth\b/, /\blogin\b/, /\btoken\b/,
    /\bserver\b/, /\bbackend\b/, /\bexpress\b/, /\broute\b/, /\bcontroller\b/, /\bservice\b/, /\bworkflow\b/,
    /\brefactor\b/, /\bperformance\b/, /\boptimi[sz]e\b/, /\bfix\b/, /\bbug\b/, /\bcrash\b/, /\berror\b/,
    /\bunit test\b/, /\bintegration test\b/, /\bcoverage\b/, /\bvitest\b/, /\bj(e)?st\b/
  ];
  if (nonStyleSignals.some((re) => re.test(text))) {
    return false;
  }

  return true;
};

const COLOR_NAMES = [
  'black',
  'white',
  'gray',
  'grey',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'violet',
  'indigo',
  'pink',
  'magenta',
  'maroon',
  'navy',
  'teal',
  'cyan',
  'aqua',
  'turquoise',
  'gold',
  'silver',
  'beige',
  'brown',
  'lavender',
  'mint',
  'olive'
];

const COLOR_ADJECTIVES = ['light', 'dark', 'bright', 'deep', 'soft', 'muted', 'vibrant', 'pale', 'rich', 'warm', 'cool'];

const COLOR_NAME_PATTERN = COLOR_NAMES.join('|');
const COLOR_ADJECTIVE_PATTERN = COLOR_ADJECTIVES.join('|');
const COLOR_PHRASE_REGEX = new RegExp(
  `\\b(?:(${COLOR_ADJECTIVE_PATTERN})\\s+)?(${COLOR_NAME_PATTERN})\\b`,
  'i'
);

export const extractStyleColor = (prompt = '') => {
  const raw = extractLatestRequest(prompt);
  const text = normalizePrompt(raw);
  if (!text) {
    return null;
  }

  const hexMatch = text.match(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i);
  if (hexMatch) {
    return hexMatch[0].toLowerCase();
  }

  const rgbMatch = raw.match(/rgb[a]?\([^)]*\)/i);
  if (rgbMatch) {
    return rgbMatch[0];
  }

  const colorMatch = raw.match(COLOR_PHRASE_REGEX);
  if (colorMatch) {
    const [, rawAdjective = '', rawColor = ''] = colorMatch;
    const adjective = rawAdjective.trim().toLowerCase();
    const color = rawColor.trim().toLowerCase();
    return `${adjective ? `${adjective} ` : ''}${color}`.trim();
  }

  return null;
};

export default {
  isStyleOnlyPrompt,
  extractStyleColor,
  extractLatestRequest,
  extractSelectedProjectAssets,
  hasResolvedClarificationAnswers
};
