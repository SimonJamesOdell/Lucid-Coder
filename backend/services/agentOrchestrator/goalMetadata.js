const DONE_QUESTION = 'What should "done" look like? Please provide acceptance criteria.';
const EXPECTED_ACTUAL_QUESTION = 'What is the expected behavior, and what is currently happening?';

const extractAcceptanceCriteria = (prompt = '') => {
  const lines = prompt.split(/\r?\n/);
  let sectionStart = -1;
  const criteria = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || '';
    const match = line.match(/^\s*(acceptance\s*criteria|ac)\s*:\s*(.*)$/i);
    if (match) {
      const inline = (match[2] || '').trim();
      if (inline) {
        criteria.push(inline);
      }
      sectionStart = i + 1;
      break;
    }
  }

  if (sectionStart === -1) return [];

  for (let i = sectionStart; i < lines.length; i += 1) {
    const raw = lines[i] || '';
    const trimmed = raw.trim();

    if (!trimmed) {
      if (criteria.length > 0) break;
      continue;
    }

    // Stop when a new section header begins.
    if (/^[A-Za-z][A-Za-z0-9 _-]{0,40}:\s*$/.test(trimmed)) {
      break;
    }

    const bulletMatch = trimmed.match(/^(?:[-*•]|\d+[.)])\s+(.+?)\s*$/);
    if (bulletMatch) {
      criteria.push(bulletMatch[1].trim());
    }
  }

  return Array.from(new Set(criteria)).filter(Boolean);
};

const normalizeClarifyingQuestions = (questions = []) => {
  if (!Array.isArray(questions)) return [];
  const cleaned = questions
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  return Array.from(new Set(cleaned));
};

const looksUnderspecified = (prompt) => {
  const normalized = prompt.trim().toLowerCase();
  if (!normalized) return true;

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 2) return true;

  if (/^(build|make|create)\b/.test(normalized) && /\b(something|anything|stuff|thing)\b/.test(normalized)) {
    return true;
  }

  return false;
};

const looksLikeBugFix = (prompt) => /\b(fix|bug|broken|error|issue|crash)\b/i.test(prompt);

const hasExpectedActualContext = (prompt) =>
  /\b(expected|actual|currently|steps to reproduce|repro)\b/i.test(prompt);

const extractClarifyingQuestions = ({ prompt, acceptanceCriteria = [] }) => {
  if (acceptanceCriteria.length > 0) return [];

  const questions = [];
  if (looksUnderspecified(prompt) || looksLikeBugFix(prompt)) {
    questions.push(DONE_QUESTION);
  }

  if (looksLikeBugFix(prompt) && !hasExpectedActualContext(prompt)) {
    questions.push(EXPECTED_ACTUAL_QUESTION);
  }

  return Array.from(new Set(questions)).filter(Boolean);
};

const createRequestClarificationQuestions = ({ llmClient, extractJsonObject }) => async (prompt, projectContext) => {
  const systemMessage = {
    role: 'system',
    content:
      'You are a senior product engineer. Given a user request and project context, ' +
      'return ONLY JSON in the shape { "needsClarification": boolean, "questions": [string] }. ' +
      'Ask short, specific questions only if required to implement the request correctly. ' +
      'If the request is sufficiently specified, return {"needsClarification": false, "questions": []}. '
  };

  const userMessage = {
    role: 'user',
    content: ['Project context:', projectContext || 'Unavailable', '', `User request: "${prompt}"`].join('\n')
  };

  const raw = await llmClient.generateResponse([systemMessage, userMessage], {
    max_tokens: 300,
    temperature: 0.2,
    __lucidcoderPhase: 'meta_goal_clarification',
    __lucidcoderRequestType: 'clarification_questions'
  });

  const parsed = extractJsonObject(raw) || {};
  const needsClarification = Boolean(parsed.needsClarification);
  const questions = normalizeClarifyingQuestions(parsed.questions || []);
  return needsClarification ? questions : [];
};

const createBuildGoalMetadataFromPrompt = ({ isStyleOnlyPrompt }) =>
  ({ prompt, extraClarifyingQuestions = [] } = {}) => {
    const rawPrompt = typeof prompt === 'string' ? prompt : '';
    const acceptanceCriteria = extractAcceptanceCriteria(rawPrompt);
    const autoQuestions = extractClarifyingQuestions({ prompt: rawPrompt, acceptanceCriteria });
    const clarifyingQuestions = normalizeClarifyingQuestions([
      ...autoQuestions,
      ...extraClarifyingQuestions
    ]);
    const styleOnly = isStyleOnlyPrompt(rawPrompt);

    const metadata = {
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
      ...(clarifyingQuestions.length > 0 ? { clarifyingQuestions } : {}),
      ...(styleOnly ? { styleOnly: true } : {})
    };

    return {
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      acceptanceCriteria,
      clarifyingQuestions,
      styleOnly
    };
  };

export {
  createBuildGoalMetadataFromPrompt,
  createRequestClarificationQuestions,
  extractAcceptanceCriteria,
  normalizeClarifyingQuestions
};
