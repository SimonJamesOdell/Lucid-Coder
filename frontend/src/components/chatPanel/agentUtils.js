export const createChatMessage = (sender, text, options = {}) => ({
  id: `${sender}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  text,
  sender,
  timestamp: new Date(),
  variant: options.variant || null
});

export const callAgentWithTimeout = async ({
  projectId,
  prompt,
  timeoutMs,
  agentRequestFn
}) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('Agent request timed out'));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      agentRequestFn({ projectId, prompt }),
      timeoutPromise
    ]);
    return result;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

export const resolveAgentErrorMessage = (error) => {
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message && /timed out/i.test(message)) {
    return 'The AI assistant took too long to respond. Please try again.';
  }

  if (message && /did not provide an answer/i.test(message)) {
    return 'The AI assistant could not generate an answer for that question. Please try rephrasing or be more specific.';
  }

  const backendPayload = error?.response?.data;
  const backendError = typeof backendPayload?.error === 'string' ? backendPayload.error : '';
  const backendReason = typeof backendPayload?.reason === 'string' ? backendPayload.reason : '';

  if (backendError && /LLM is not configured/i.test(backendError)) {
    const reasonSuffix = backendReason ? ` (${backendReason})` : '';
    return `AI assistant is not configured${reasonSuffix}. Configure it in Settings → LLM and try again.`;
  }

  if (backendError) {
    const reasonSuffix = backendReason && !backendError.includes(backendReason) ? ` (${backendReason})` : '';
    return `${backendError}${reasonSuffix}`;
  }

  return 'Sorry, the AI assistant is unavailable right now. Please try again.';
};

export const buildAgentDiagnostics = (meta) => {
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  const entries = [];
  if (meta.classificationError) {
    entries.push(`classification: ${meta.classificationError}`);
  }
  if (meta.questionError) {
    entries.push(`question: ${meta.questionError}`);
  }
  if (meta.planningError) {
    entries.push(`planning: ${meta.planningError}`);
  }
  if (meta.fallbackPlanningError) {
    entries.push(`fallback planning: ${meta.fallbackPlanningError}`);
  }
  if (!entries.length) {
    return null;
  }
  return `Diagnostics: ${entries.join(' | ')}`;
};
