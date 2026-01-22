import axios from 'axios';

const getUiSessionId = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const value = window.sessionStorage?.getItem?.('lucidcoder.uiSessionId');
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
};

export const readUiSessionId = () => getUiSessionId();

export const fetchGoals = async (projectId, { includeArchived = false } = {}) => {
  if (!projectId) throw new Error('projectId is required');

  const params = { projectId };
  if (includeArchived) {
    params.includeArchived = 1;
  }

  const res = await axios.get('/api/goals', { params });
  return res.data.goals || [];
};

export const fetchGoalWithTasks = async (goalId) => {
  if (!goalId) throw new Error('goalId is required');
  const res = await axios.get(`/api/goals/${goalId}`);
  return res.data;
};

export const createGoal = async (projectId, prompt) => {
  if (!projectId) throw new Error('projectId is required');
  if (!prompt) throw new Error('prompt is required');
  const res = await axios.post('/api/goals', { projectId, prompt });
  return res.data;
};

export const createMetaGoalWithChildren = async ({ projectId, prompt, childPrompts }) => {
  if (!projectId) throw new Error('projectId is required');
  if (!prompt) throw new Error('prompt is required');
  if (!Array.isArray(childPrompts)) throw new Error('childPrompts must be an array');
  const res = await axios.post('/api/goals/plan', { projectId, prompt, childPrompts });
  return res.data;
};

export const deleteGoal = async (goalId) => {
  if (!goalId) throw new Error('goalId is required');
  const res = await axios.delete(`/api/goals/${goalId}`);
  return res.data;
};

export const advanceGoalPhase = async (goalId, phase, metadata) => {
  if (!goalId) throw new Error('goalId is required');
  if (!phase) throw new Error('phase is required');
  const res = await axios.post(`/api/goals/${goalId}/phase`, { phase, metadata });
  return res.data;
};

export const recordGoalTestRun = async (goalId, payload) => {
  if (!goalId) throw new Error('goalId is required');
  const res = await axios.post(`/api/goals/${goalId}/tests`, payload || {});
  return res.data;
};

export const runGoalTests = async (goalId, payload) => {
  if (!goalId) throw new Error('goalId is required');
  const res = await axios.post(`/api/goals/${goalId}/run-tests`, payload || {});
  return res.data;
};

export const planMetaGoal = async ({ projectId, prompt, childPrompts }) => {
  if (!projectId) throw new Error('projectId is required');
  if (!prompt) throw new Error('prompt is required');
  const res = await axios.post('/api/goals/plan-from-prompt', {
    projectId,
    prompt
  });
  return res.data;
};

export const agentRequest = async ({ projectId, prompt }) => {
  if (!projectId) throw new Error('projectId is required');
  if (!prompt) throw new Error('prompt is required');
  const res = await axios.post('/api/agent/request', { projectId, prompt });
  return res.data;
};

export const agentRequestStream = async ({ projectId, prompt, onChunk, onComplete, onError, signal } = {}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!prompt) throw new Error('prompt is required');

  const response = await fetch('/api/agent/request/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId, prompt }),
    signal
  });

  if (!response.ok || !response.body) {
    const message = `Streaming request failed (${response.status})`;
    throw new Error(message);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const emitEvent = (eventName, payload) => {
    if (eventName === 'chunk' && typeof onChunk === 'function') {
      /* c8 ignore next */
      onChunk(payload?.text || '');
      return;
    }
    if (eventName === 'done' && typeof onComplete === 'function') {
      /* c8 ignore next */
      onComplete(payload?.result || null);
      return;
    }
    if (eventName === 'error' && typeof onError === 'function') {
      onError(payload?.message || 'Agent request failed');
    }
  };

  const parseEventBlock = (block) => {
    const lines = block.split(/\r?\n/);
    let eventName = 'message';
    let data = '';

    lines.forEach((line) => {
      if (line.startsWith('event:')) {
        /* c8 ignore next */
        eventName = line.slice(6).trim() || 'message';
        return;
      }
      if (line.startsWith('data:')) {
        data += line.slice(5).trim();
      }
    });

    if (!data) {
      return;
    }

    try {
      const payload = JSON.parse(data);
      emitEvent(eventName, payload);
    } catch {
      emitEvent(eventName, { text: data });
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    let delimiterIndex = buffer.indexOf('\n\n');
    while (delimiterIndex !== -1) {
      const chunk = buffer.slice(0, delimiterIndex);
      buffer = buffer.slice(delimiterIndex + 2);
      parseEventBlock(chunk);
      delimiterIndex = buffer.indexOf('\n\n');
    }
  }
};

export const agentAutopilot = async ({ projectId, prompt, options } = {}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!prompt) throw new Error('prompt is required');

  const uiSessionId = getUiSessionId();
  const payload = { projectId, prompt, options: options || {} };
  if (uiSessionId) {
    payload.uiSessionId = uiSessionId;
  }

  const res = await axios.post('/api/agent/autopilot', payload);
  return res.data;
};

export const agentAutopilotStatus = async ({ projectId, sessionId } = {}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!sessionId) throw new Error('sessionId is required');
  const res = await axios.get(`/api/agent/autopilot/sessions/${encodeURIComponent(String(sessionId))}`, {
    params: { projectId }
  });
  return res.data;
};

export const agentAutopilotMessage = async ({ projectId, sessionId, message, kind, metadata } = {}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!sessionId) throw new Error('sessionId is required');
  if (!message) throw new Error('message is required');

  const payload = { projectId, message };
  if (kind) {
    payload.kind = kind;
  }
  if (metadata && typeof metadata === 'object') {
    payload.metadata = metadata;
  }

  const res = await axios.post(`/api/agent/autopilot/sessions/${encodeURIComponent(String(sessionId))}/messages`, payload);
  return res.data;
};

export const agentAutopilotCancel = async ({ projectId, sessionId, reason } = {}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!sessionId) throw new Error('sessionId is required');
  const body = reason ? { projectId, reason } : { projectId };
  const res = await axios.post(`/api/agent/autopilot/sessions/${encodeURIComponent(String(sessionId))}/cancel`, body);
  return res.data;
};

export const agentAutopilotResume = async ({ projectId, uiSessionId, limit = 5 } = {}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!uiSessionId) throw new Error('uiSessionId is required');
  const payload = {
    projectId,
    uiSessionId,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5
  };
  const res = await axios.post('/api/agent/autopilot/resume', payload);
  return res.data;
};

export default {
  fetchGoals,
  createGoal,
  createMetaGoalWithChildren,
  deleteGoal,
  advanceGoalPhase,
  recordGoalTestRun,
  runGoalTests,
  planMetaGoal,
  agentRequest,
  agentRequestStream,
  agentAutopilot,
  agentAutopilotStatus,
  agentAutopilotMessage,
  agentAutopilotCancel,
  agentAutopilotResume,
  readUiSessionId
};
