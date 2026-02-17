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

const createRequestClarificationQuestions = ({ llmClient, extractJsonObject }) => async (prompt, projectContext) => {
  const rawPrompt = typeof prompt === 'string' ? prompt : '';

  const systemMessage = {
    role: 'system',
    content:
      'You are a senior product engineer. Given a user request and project context, ' +
      'return ONLY JSON in the shape { "needsClarification": boolean, "questions": [string] }. ' +
      'Ask short, specific questions only if a missing detail blocks implementation. ' +
      'Do not ask for acceptance criteria or vague confirmations. ' +
      'If reasonable defaults can be assumed (colors, spacing, generic labels), do so and return no questions. ' +
      'If the user request includes a "Selected project assets:" list and references an image/file/asset, treat those listed assets as available context. ' +
      'Do not ask for filename/path unless no suitable asset is listed or multiple listed assets require a deliberate choice. ' +
      'If the request is sufficiently specified, return {"needsClarification": false, "questions": []}. ' +
      'Examples: ' +
      '"Add a navigation bar along the top with Home, About, Contact and Products; Products has a dropdown with 3 generic categories." => {"needsClarification": false, "questions": []}. ' +
      '"Change the background color to red" => {"needsClarification": false, "questions": []}. ' +
      '"Fix the crash" with no repro steps => needsClarification true with a question about steps and expected vs actual.'
  };

  const userMessage = {
    role: 'user',
    content: ['Project context:', projectContext || 'Unavailable', '', `User request: "${rawPrompt}"`].join('\n')
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
    const clarifyingQuestions = normalizeClarifyingQuestions(extraClarifyingQuestions);
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
