import axios from 'axios';
import { automationLog, requestBranchNameFromLLM } from './automationUtils';

export async function ensureBranch(projectId, prompt, setPreviewPanelTab, createMessage, setMessages, options = {}) {
  try {
    automationLog('ensureBranch:start', { projectId, prompt: String(prompt || '').slice(0, 200) });
    const branchesResponse = await axios.get(`/api/projects/${projectId}/branches`);
    const overview = branchesResponse.data;
    const workingBranches = Array.isArray(overview.workingBranches) ? overview.workingBranches : [];
    const existingBranch = workingBranches[0] || null;

    if (!existingBranch) {
      const fallbackName = `feature-${Date.now()}`;
      const generatedName = await requestBranchNameFromLLM({ prompt, fallbackName });

      automationLog('ensureBranch:generatedName', { generatedName });

      const createResponse = await axios.post(`/api/projects/${projectId}/branches`, {
        name: generatedName
      });

      const branchName = createResponse.data?.branch?.name || generatedName;

      automationLog('ensureBranch:created', { branchName });

      setPreviewPanelTab?.('branches', { source: 'automation' });

      if (typeof options?.syncBranchOverview === 'function') {
        try {
          const refreshed = await axios.get(`/api/projects/${projectId}/branches`);
          if (refreshed?.data) {
            options.syncBranchOverview(projectId, refreshed.data);
          }
        } catch {
          // Best-effort refresh only.
        }
      }

      setMessages((prev) => [
        ...prev,
        createMessage('assistant', `Branch ${branchName} created`, { variant: 'status' })
      ]);

      return { name: branchName };
    }

    return { name: existingBranch.name };
  } catch (error) {
    console.error('Failed to create branch:', error);
    automationLog('ensureBranch:error', { message: error?.message, status: error?.response?.status });
    return null;
  }
}
