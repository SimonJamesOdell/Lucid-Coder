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

export const agentAutopilotMessage = async ({ projectId, sessionId, message } = {}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!sessionId) throw new Error('sessionId is required');
  if (!message) throw new Error('message is required');
  const res = await axios.post(`/api/agent/autopilot/sessions/${encodeURIComponent(String(sessionId))}/messages`, {
    projectId,
    message
  });
  return res.data;
};

export const agentAutopilotCancel = async ({ projectId, sessionId } = {}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!sessionId) throw new Error('sessionId is required');
  const res = await axios.post(`/api/agent/autopilot/sessions/${encodeURIComponent(String(sessionId))}/cancel`, {
    projectId
  });
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
  agentAutopilot,
  agentAutopilotStatus,
  agentAutopilotMessage,
  agentAutopilotCancel
};
