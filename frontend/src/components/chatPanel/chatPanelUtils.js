export const formatAgentStepMessage = (step) => {
  if (!step || typeof step !== 'object') {
    return null;
  }

  if (step.type === 'action') {
    if (step.action === 'read_file') {
      const target = step.target || 'a file';
      if (step.reason) {
        return `Agent is reading ${target} (${step.reason}).`;
      }
      return `Agent is reading ${target}.`;
    }
    return `Agent is performing action: ${step.action}.`;
  }

  if (step.type === 'observation') {
    if (step.action === 'read_file') {
      if (step.error) {
        return `Agent could not read ${step.target || 'file'}: ${step.error}`;
      }
      return null;
    }
    if (step.error) {
      return `Agent observation error: ${step.error}`;
    }
    return `Agent observation: ${step.summary || 'No details provided.'}`;
  }

  return null;
};

export const parseClarificationOptions = (question) => {
  if (typeof question !== 'string') {
    return [];
  }

  const lines = question.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

  const bulletOnly = lines
    .filter((line) => /^[-*•]\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, '').trim())
    .filter(Boolean);

  let options = bulletOnly.length > 0 ? bulletOnly : [];

  if (options.length === 0) {
    const inlineMatch = question.match(/\(([^)]+)\)/);
    if (inlineMatch && inlineMatch[1]) {
      options = inlineMatch[1]
        .split(/\s*[|/]\s*/)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  if (options.length === 0) {
    const optionLine = lines.find((line) => /^(options|choices|choose|pick)\b/i.test(line));
    if (optionLine) {
      const parts = optionLine.split(/[:,-]\s*/).slice(1).join(' ');
      options = parts
        .split(/\s*(?:,|\/|\bor\b)\s*/i)
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  const unique = Array.from(new Set(options.filter(Boolean)));
  return unique.length >= 2 && unique.length <= 5 ? unique : [];
};

export const readStoredChatMessages = (projectId) => {
  if (typeof window === 'undefined' || !projectId) {
    return [];
  }
  try {
    const raw = window.localStorage?.getItem?.(`lucidcoder.chat.${projectId}`);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map((item) => ({
      ...item,
      timestamp: item?.timestamp ? new Date(item.timestamp) : new Date()
    }));
  } catch {
    return [];
  }
};

export const persistChatMessages = (projectId, nextMessages) => {
  if (typeof window === 'undefined' || !projectId) {
    return;
  }
  try {
    const trimmed = Array.isArray(nextMessages) ? nextMessages.slice(-200) : [];
    const payload = trimmed.map((item) => ({
      id: item.id,
      text: item.text,
      sender: item.sender,
      variant: item.variant || null,
      timestamp: item.timestamp ? new Date(item.timestamp).toISOString() : new Date().toISOString()
    }));
    window.localStorage?.setItem?.(`lucidcoder.chat.${projectId}`, JSON.stringify(payload));
  } catch {
    // Ignore storage failures
  }
};
