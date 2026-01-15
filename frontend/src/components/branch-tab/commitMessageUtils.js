export const COMMIT_INSTRUCTION_PREFIXES = [
  'we need',
  'we should',
  'we must',
  'must be',
  'count',
  'respond with',
  'write a',
  'please write',
  'ensure the commit',
  'probably',
  'return a',
  'output'
];

export const COMMIT_INSTRUCTION_KEYWORDS = [
  'subject line',
  'body optional',
  'provide subject',
  'ensure lines',
  'no placeholders',
  'respond with instructions',
  'count characters',
  'follow these rules',
  'mention file',
  'mention files',
  'provide body',
  'include body',
  'brief explanation'
];

const containsInstructionalLanguage = (text = '') => {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return COMMIT_INSTRUCTION_KEYWORDS.some((keyword) => lower.includes(keyword));
};

export const PLACEHOLDER_COMMIT_PATTERNS = [
  /^test\s*\d*$/i,
  /^tests?$/i,
  /^wip(?:\b|\s)/i,
  /^todo(?:\b|\s)/i,
  /^tmp(?:\b|\s)/i,
  /^temp(?:\b|\s)/i,
  /^update$/i,
  /^changes?$/i,
  /^commit message$/i
];

export const COMMIT_SYSTEM_PROMPT = 'You are an experienced engineer reviewing git diffs. Explain what changed and why in clear, natural language. Reference files or behaviors when it helps, and never repeat the instructions or talk about formatting.';

export const looksLikeCommitMessage = (text = '') => {
  if (!text) {
    return false;
  }
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  const lines = normalized.split(/\r?\n/);
  const subject = lines[0]?.trim();
  if (!subject || !isDescriptiveCommitMessage(subject)) {
    return false;
  }
  const lowerSubject = subject.toLowerCase();
  if (
    COMMIT_INSTRUCTION_PREFIXES.some((prefix) => lowerSubject.startsWith(prefix))
    || COMMIT_INSTRUCTION_KEYWORDS.some((keyword) => lowerSubject.includes(keyword))
  ) {
    return false;
  }
  if (subject.length > 120) {
    return false;
  }

  if (lines.length === 1) {
    return true;
  }

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      continue;
    }
    if (line.length > 120) return false;
    const lowerLine = line.toLowerCase();
    if (COMMIT_INSTRUCTION_KEYWORDS.some((keyword) => lowerLine.includes(keyword))) {
      return false;
    }
  }

  return true;
};

export const isLikelyPlaceholderCommitMessage = (text = '') => {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return PLACEHOLDER_COMMIT_PATTERNS.some((pattern) => pattern.test(normalized));
};

export const hasMeaningfulWordSignal = (text = '') => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 3) {
    return true;
  }
  const alphaChars = (text.match(/[a-z]/gi) || []).length;
  return alphaChars >= 15;
};

export const isDescriptiveCommitMessage = (text = '') => {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (trimmed.length < 10) {
    return false;
  }
  if (containsInstructionalLanguage(trimmed)) {
    return false;
  }
  if (isLikelyPlaceholderCommitMessage(trimmed)) {
    return false;
  }
  return hasMeaningfulWordSignal(trimmed);
};

export const coerceMessageString = (message) => {
  if (!message) {
    return '';
  }
  if (typeof message === 'string') {
    return message;
  }
  if (typeof message.content === 'string' && message.content.trim()) {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    const flattened = message.content
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (entry && typeof entry.text === 'string') {
          return entry.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
    if (flattened) {
      return flattened;
    }
  }
  if (typeof message.reasoning === 'string' && message.reasoning.trim()) {
    return message.reasoning.trim();
  }
  if (message.reasoning && typeof message.reasoning === 'object') {
    if (typeof message.reasoning.output_text === 'string' && message.reasoning.output_text.trim()) {
      return message.reasoning.output_text.trim();
    }
    if (Array.isArray(message.reasoning.steps)) {
      const joined = message.reasoning.steps
        .map((step) => (typeof step?.text === 'string' ? step.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (joined) {
        return joined;
      }
    }
  }
  return '';
};

export const extractLLMText = (payload) => {
  if (!payload) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  if (Array.isArray(payload?.choices) && payload.choices.length > 0) {
    const choice = payload.choices[0];
    const messageText = coerceMessageString(choice?.message);
    if (messageText) {
      return messageText;
    }
    if (typeof choice?.text === 'string' && choice.text.trim()) {
      return choice.text.trim();
    }
  }
  if (typeof payload?.content === 'string') {
    return payload.content;
  }
  if (payload?.message) {
    const fallback = coerceMessageString(payload.message);
    if (fallback) {
      return fallback;
    }
  }
  return '';
};

export const stripListPrefix = (line = '') => line.replace(/^[-*•\s]+/, '').trim();

export const extractCommitCandidateFromText = (text = '') => {
  if (!text) {
    return '';
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return '';
  }

  const looksQuoted = /^['"“”]/.test(trimmed) && /['"“”]$/.test(trimmed);
  const unquoted = trimmed.replace(/^['"“”\s]+/, '').replace(/['"“”\s]+$/, '');
  if (looksQuoted && unquoted && looksLikeCommitMessage(unquoted)) {
    return unquoted;
  }

  if (looksLikeCommitMessage(trimmed)) {
    return trimmed;
  }

  const quotedMatch = trimmed.match(/["“”']([^"“”']{5,120})["“”']/);
  if (quotedMatch) {
    const quotedCandidate = quotedMatch[1].trim();
    if (isDescriptiveCommitMessage(quotedCandidate)) {
      return quotedCandidate;
    }
  }

  const colonMatch = trimmed.match(/commit message[^:]*:\s*([^\n]+)/i);
  if (colonMatch && colonMatch[1]) {
    const colonCandidate = colonMatch[1].trim();
    if (isDescriptiveCommitMessage(colonCandidate)) {
      return colonCandidate;
    }
  }

  const segments = trimmed
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=\.)\s+/))
    .map(stripListPrefix)
    .filter(Boolean);

  const viableSegments = [];
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (COMMIT_INSTRUCTION_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
      continue;
    }
    if (COMMIT_INSTRUCTION_KEYWORDS.some((keyword) => lower.includes(keyword))) {
      continue;
    }
    if (segment.length < 5) {
      continue;
    }
    viableSegments.push(segment);
  }

  const descriptiveSegment = viableSegments.find((segment) => isDescriptiveCommitMessage(segment));
  if (descriptiveSegment) {
    return descriptiveSegment;
  }

  return viableSegments[0] || '';
};

export const __testHooks = {
  containsInstructionalLanguage
};
