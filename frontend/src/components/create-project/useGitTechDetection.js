import { useEffect } from 'react';

export function useGitTechDetection({
  setupStep,
  projectSource,
  gitRemoteUrl,
  gitConnectionMode,
  gitProvider,
  gitSettingsProvider,
  gitToken,
  gitTechKeyRef,
  setGitTechStatus,
  axios,
  onDetected
}) {
  useEffect(() => {
    if (setupStep !== 'details' || projectSource !== 'git') {
      return;
    }

    const url = gitRemoteUrl.trim();
    if (!url) {
      return;
    }

    const connectionMode = gitConnectionMode || 'local';
    const provider = (connectionMode === 'custom' ? gitProvider : (gitSettingsProvider || 'github')).toLowerCase();
    const token = connectionMode === 'custom' ? gitToken.trim() : '';
    const detectKey = `${url}|${connectionMode}|${provider}|${token}`;
    if (gitTechKeyRef.current === detectKey) {
      return;
    }
    gitTechKeyRef.current = detectKey;

    setGitTechStatus({ isLoading: true, error: '' });

    axios
      .post('/api/fs/detect-git-tech', {
        gitUrl: url,
        provider,
        token: token || undefined
      })
      .then((response) => {
        const data = response?.data;
        if (!data?.success) {
          throw new Error(data?.error || 'Failed to detect tech stack');
        }
        onDetected(data);
        setGitTechStatus({ isLoading: false, error: '' });
      })
      .catch((error) => {
        const message = error?.response?.data?.error || error?.message || 'Failed to detect tech stack';
        setGitTechStatus({ isLoading: false, error: message });
      });
  }, [
    setupStep,
    projectSource,
    gitRemoteUrl,
    gitConnectionMode,
    gitProvider,
    gitToken,
    gitSettingsProvider,
    gitTechKeyRef,
    setGitTechStatus,
    axios,
    onDetected
  ]);
}
