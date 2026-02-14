import { buildProgressSteps } from './progressUtils';

export function createPostCloneSetupHandlers({
  axios,
  setGitIgnoreStatus,
  setProgress,
  setProcesses,
  setGitIgnoreSuggestion,
  showMain
}) {
  const runPostCloneSetup = async (projectId) => {
    if (!projectId) {
      throw new Error('Missing project id for setup');
    }

    setGitIgnoreStatus({ state: 'working', error: '' });
    setProgress((prev) => {
      const existingSteps = Array.isArray(prev?.steps) && prev.steps.length > 0
        ? prev.steps
        : buildProgressSteps(false);

      const updatedSteps = existingSteps.map((step, index) => ({
        ...step,
        completed: index < 3
      }));

      return {
        ...prev,
        steps: updatedSteps,
        status: 'in-progress',
        statusMessage: 'Installing dependencies...'
      };
    });

    const response = await axios.post(`/api/projects/${projectId}/setup`);

    if (!response?.data?.success) {
      throw new Error(response?.data?.error || 'Failed to complete project setup');
    }

    if (response.data.processes) {
      setProcesses(response.data.processes);
    }

    setProgress((prev) => ({
      ...prev,
      steps: buildProgressSteps(true),
      completion: 100,
      status: 'completed',
      statusMessage: response.data.message || 'Project setup completed'
    }));

    setGitIgnoreStatus({ state: 'done', error: '' });
    setGitIgnoreSuggestion(null);
    setTimeout(() => {
      showMain();
    }, 2000);
  };

  const handleApplyGitIgnore = async (gitIgnoreSuggestion) => {
    if (!gitIgnoreSuggestion?.projectId) {
      return;
    }

    try {
      const response = await axios.post(
        `/api/projects/${gitIgnoreSuggestion.projectId}/git/ignore-fix`,
        {
          entries: gitIgnoreSuggestion.entries,
          commit: true
        }
      );

      if (!response?.data?.success) {
        throw new Error(response?.data?.error || 'Failed to update .gitignore');
      }

      await runPostCloneSetup(gitIgnoreSuggestion.projectId);
    } catch (error) {
      const message = error?.response?.data?.error || error?.message || 'Failed to update .gitignore';
      setGitIgnoreStatus({ state: 'error', error: message });
    }
  };

  const handleSkipGitIgnore = async (gitIgnoreSuggestion) => {
    if (!gitIgnoreSuggestion?.projectId) {
      return;
    }

    try {
      await runPostCloneSetup(gitIgnoreSuggestion.projectId);
    } catch (error) {
      const message = error?.response?.data?.error || error?.message || 'Failed to complete project setup';
      setGitIgnoreStatus({ state: 'error', error: message });
    }
  };

  const handleContinueAfterGitIgnore = () => {
    setGitIgnoreSuggestion(null);
    setGitIgnoreStatus({ state: 'idle', error: '' });
    showMain();
  };

  return {
    runPostCloneSetup,
    handleApplyGitIgnore,
    handleSkipGitIgnore,
    handleContinueAfterGitIgnore
  };
}
