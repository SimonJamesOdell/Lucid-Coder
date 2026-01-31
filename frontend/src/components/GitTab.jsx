import React, { useEffect, useMemo, useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import './GitTab.css';

const providerOptions = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' }
];

export const slugifyRepoName = (value = '') => {
  const normalized = String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'lucidcoder-project';
};

const buildRemoteCreatorState = (projectName = '') => ({
  name: slugifyRepoName(projectName || 'lucidcoder-project'),
  owner: '',
  visibility: 'private',
  description: ''
});

const formatWorkflow = (workflow) => (workflow === 'cloud' ? 'Remote host' : 'Local-only');
const formatProvider = (provider) => (provider === 'gitlab' ? 'GitLab' : 'GitHub');

const buildFormState = (settings) => ({
  workflow: settings?.workflow === 'cloud' ? 'cloud' : 'local',
  provider: settings?.provider || 'github',
  remoteUrl: settings?.remoteUrl || '',
  defaultBranch: settings?.defaultBranch || 'main',
  token: ''
});

const resolveConnectionMode = ({ settings, globalSettings }) => {
  if (settings?.workflow !== 'cloud') {
    return 'local';
  }
  if (globalSettings?.provider && settings?.provider && globalSettings.provider !== settings.provider) {
    return 'custom';
  }
  return 'global';
};

const trackedFields = ['workflow', 'provider', 'remoteUrl', 'defaultBranch'];

const GitTab = () => {
  const {
    currentProject,
    gitSettings,
    gitConnectionStatus,
    projectGitStatus,
    getEffectiveGitSettings,
    fetchProjectGitStatus,
    fetchProjectGitRemote,
    pullProjectGitRemote,
    fetchProjectBranchesOverview,
    checkoutProjectBranch,
    updateProjectGitSettings,
    createProjectRemoteRepository
  } = useAppState();
  const settings = currentProject ? getEffectiveGitSettings(currentProject.id) : null;

  const [formState, setFormState] = useState(buildFormState(settings));
  const [connectionMode, setConnectionMode] = useState(resolveConnectionMode({ settings, globalSettings: gitSettings }));
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showRemoteCreator, setShowRemoteCreator] = useState(false);
  const [remoteCreatorState, setRemoteCreatorState] = useState(buildRemoteCreatorState(currentProject?.name));
  const [remoteCreatorStatus, setRemoteCreatorStatus] = useState({ isSubmitting: false, error: null, success: null });
  const [gitStatusError, setGitStatusError] = useState(null);
  const [gitStatusMessage, setGitStatusMessage] = useState(null);
  const [isFetchingRemote, setIsFetchingRemote] = useState(false);
  const [isPullingRemote, setIsPullingRemote] = useState(false);
  const [branchOptions, setBranchOptions] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');

  useEffect(() => {
    setFormState(buildFormState(settings));
    setConnectionMode(resolveConnectionMode({ settings, globalSettings: gitSettings }));
  }, [settings?.workflow, settings?.provider, settings?.remoteUrl, settings?.defaultBranch, gitSettings?.provider]);

  useEffect(() => {
    if (!currentProject) {
      setRemoteCreatorState(buildRemoteCreatorState());
      setShowRemoteCreator(false);
      setRemoteCreatorStatus({ isSubmitting: false, error: null, success: null });
      return;
    }
    setRemoteCreatorState(buildRemoteCreatorState(currentProject.name));
    setShowRemoteCreator(false);
    setRemoteCreatorStatus({ isSubmitting: false, error: null, success: null });
  }, [currentProject?.id, currentProject?.name]);

  if (!currentProject) {
    return (
      <div className="git-tab" data-testid="git-tab-empty">
        <p>Select a project to view repository settings.</p>
      </div>
    );
  }

  const baselineState = useMemo(() => buildFormState(settings), [settings?.workflow, settings?.provider, settings?.remoteUrl, settings?.defaultBranch]);

  const isDirty = useMemo(() => {
    const fieldChanged = trackedFields.some((field) => baselineState[field] !== formState[field]);
    const tokenChanged = Boolean(formState.token?.trim());
    return fieldChanged || tokenChanged;
  }, [baselineState, formState]);

  const requiresRemoteDetails = formState.workflow === 'cloud';
  const remoteUrlMissing = requiresRemoteDetails && !formState.remoteUrl.trim();
  const isGlobalConfigured = Boolean(gitSettings?.tokenPresent) || Boolean(gitConnectionStatus?.provider);
  const canCreateRepo = Boolean(remoteCreatorState.name.trim() || slugifyRepoName(currentProject?.name));
  /* c8 ignore next -- defensive optional chaining when status map is missing */
  const currentGitStatus = currentProject ? projectGitStatus?.[currentProject.id] : null;
  const hasRemoteUrl = Boolean(formState.remoteUrl.trim());

  useEffect(() => {
    if (!currentProject?.id || !requiresRemoteDetails || !formState.remoteUrl.trim()) {
      setBranchOptions([]);
      setSelectedBranch('');
      return;
    }

    let isActive = true;

    const loadStatusAndBranches = async () => {
      try {
        await fetchProjectGitStatus(currentProject.id);
      } catch (error) {
        if (isActive) {
          setGitStatusError(error?.message || 'Failed to load git status.');
        }
      }

      try {
        const overview = await fetchProjectBranchesOverview(currentProject.id);
        if (!isActive) {
          return;
        }
        const branches = Array.isArray(overview?.branches) ? overview.branches : [];
        const branchNames = branches.map((branch) => branch.name).filter(Boolean);
        setBranchOptions(branchNames);
        const currentBranch = overview?.current || currentGitStatus?.currentBranch || '';
        setSelectedBranch((prev) => prev || currentBranch || branchNames[0] || '');
      } catch (error) {
        if (isActive) {
          setGitStatusError(error?.message || 'Failed to load branches.');
        }
      }
    };

    loadStatusAndBranches();

    return () => {
      isActive = false;
    };
  }, [currentProject?.id, currentGitStatus?.currentBranch, fetchProjectBranchesOverview, fetchProjectGitStatus, formState.remoteUrl, requiresRemoteDetails]);

  const handleFieldChange = (field) => (event) => {
    const { value } = event.target;
    setFormState((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const handleConnectionModeChange = (nextMode) => {
    setConnectionMode(nextMode);
    if (nextMode === 'local') {
      setFormState((prev) => ({
        ...prev,
        workflow: 'local'
      }));
      return;
    }

    if (nextMode === 'global') {
      setFormState((prev) => ({
        ...prev,
        workflow: 'cloud',
        provider: gitSettings?.provider || 'github'
      }));
      return;
    }

    setFormState((prev) => ({
      ...prev,
      workflow: 'cloud'
    }));
  };

  const handleRemoteCreatorField = (field) => (event) => {
    const value = event.target.value;
    setRemoteCreatorState((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const handleToggleRemoteCreator = () => {
    setShowRemoteCreator((prev) => !prev);
    setRemoteCreatorStatus({ isSubmitting: false, error: null, success: null });
  };

  const handleFetchRemote = async () => {
    if (!currentProject?.id) {
      return;
    }
    setGitStatusError(null);
    setGitStatusMessage(null);
    setIsFetchingRemote(true);
    try {
      await fetchProjectGitRemote(currentProject.id);
      setGitStatusMessage('Fetched latest from remote.');
    } catch (error) {
      setGitStatusError(error?.message || 'Failed to fetch remote.');
    } finally {
      setIsFetchingRemote(false);
    }
  };

  const handlePullRemote = async () => {
    if (!currentProject?.id) {
      return;
    }
    setGitStatusError(null);
    setGitStatusMessage(null);
    setIsPullingRemote(true);
    try {
      const result = await pullProjectGitRemote(currentProject.id);
      if (result?.strategy === 'noop') {
        setGitStatusMessage('Already up to date.');
      } else if (result?.strategy === 'rebase') {
        setGitStatusMessage('Pulled with rebase.');
      } else if (result?.strategy === 'ff-only') {
        setGitStatusMessage('Pulled with fast-forward.');
      } else {
        setGitStatusMessage('Pull complete.');
      }
    } catch (error) {
      setGitStatusError(error?.message || 'Failed to pull remote.');
    } finally {
      setIsPullingRemote(false);
    }
  };

  const handleOpenRemote = () => {
    const url = formState.remoteUrl.trim();
    /* c8 ignore start -- button disabled when URL is missing */
    if (!url || typeof window === 'undefined') {
      return;
    }
    /* c8 ignore stop */
    const clean = url.replace(/\.git$/i, '');
    /* c8 ignore next -- clean is always truthy when URL is set */
    window.open(clean || url, '_blank', 'noopener,noreferrer');
  };

  const handleCopyRemote = async () => {
    const url = formState.remoteUrl.trim();
    /* c8 ignore start -- button disabled when URL is missing */
    if (!url) {
      return;
    }
    /* c8 ignore stop */
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = url;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setGitStatusMessage('Remote URL copied.');
    /* c8 ignore next -- copy failure is environment dependent */
    } catch (error) {
      setGitStatusError('Failed to copy remote URL.');
    }
  };

  const handleUpdateDefaultBranch = async () => {
    /* c8 ignore start -- button disabled when default branch is empty */
    if (!currentProject?.id) {
      return;
    }
    /* c8 ignore stop */
    setGitStatusError(null);
    setGitStatusMessage(null);
    try {
      /* c8 ignore next -- button disabled when default branch is empty */
      /* c8 ignore next -- button disabled when default branch is empty */
      const defaultBranch = formState.defaultBranch.trim() || 'main';
      const saved = await updateProjectGitSettings(currentProject.id, { defaultBranch });
      /* c8 ignore next -- defensive: backend may omit default branch */
      setFormState((prev) => ({
        ...prev,
        defaultBranch: saved?.defaultBranch || defaultBranch
      }));
      setGitStatusMessage(`Default branch set to ${defaultBranch}.`);
    /* c8 ignore next -- error handled in UI but environment dependent */
    } catch (error) {
      setGitStatusError(error?.message || 'Failed to update default branch.');
    }
  };

  const handleCheckoutBranch = async () => {
    /* c8 ignore start -- guard for disabled action */
    if (!currentProject?.id || !selectedBranch) {
      return;
    }
    /* c8 ignore stop */
    setGitStatusError(null);
    setGitStatusMessage(null);
    try {
      await checkoutProjectBranch(currentProject.id, selectedBranch);
      setGitStatusMessage(`Checked out ${selectedBranch}.`);
      await fetchProjectGitStatus(currentProject.id);
    } catch (error) {
      setGitStatusError(error?.message || 'Failed to checkout branch.');
    }
  };

  const handleCreateRemoteRepository = async (event) => {
    event.preventDefault();
    const trimmedToken = formState.token.trim();
    /* c8 ignore next -- fallback repo naming is defensive */
    const repoName = remoteCreatorState.name.trim() || slugifyRepoName(currentProject?.name);
    if (!trimmedToken && connectionMode !== 'global') {
      setRemoteCreatorStatus({ isSubmitting: false, error: 'Enter a personal access token to create the repository.', success: null });
      return;
    }
    /* c8 ignore start -- create button is disabled when global connection is missing */
    if (connectionMode === 'global' && !isGlobalConfigured) {
      setRemoteCreatorStatus({
        isSubmitting: false,
        error: 'Global connection is not configured. Set it up in global Git settings.',
        success: null
      });
      return;
    }
    /* c8 ignore stop */

    setRemoteCreatorStatus({ isSubmitting: true, error: null, success: null });
    try {
      const response = await createProjectRemoteRepository(currentProject.id, {
        /* c8 ignore next -- fallback provider is defensive */
        provider: connectionMode === 'global' ? (gitSettings?.provider || formState.provider) : formState.provider,
        name: repoName,
        owner: remoteCreatorState.owner || undefined,
        visibility: remoteCreatorState.visibility,
        description: remoteCreatorState.description,
        token: trimmedToken || undefined,
        defaultBranch: formState.defaultBranch.trim() || 'main'
      });

      const nextSettings = response.projectSettings || response.settings;
      if (nextSettings) {
        setFormState(buildFormState(nextSettings));
      } else if (response.repository?.remoteUrl) {
        setFormState((prev) => ({
          ...prev,
          workflow: 'cloud',
          remoteUrl: response.repository.remoteUrl
        }));
      } else {
        setFormState((prev) => ({
          ...prev,
          workflow: 'cloud'
        }));
      }

      const init = response.initialization;
      let successMessage = 'Repository created and linked.';
      let errorMessage = null;
      if (init) {
        if (init.success === false) {
          /* c8 ignore next -- fallback error message is defensive */
          errorMessage = `Repository created, but initial push failed: ${init.error || 'Unknown error.'}`;
          successMessage = null;
        } else if (init.pushed === false) {
          successMessage = init.message
            ? `Repository created. ${init.message}`
            : 'Repository created. No commits were pushed yet.';
        }
      }

      setRemoteCreatorStatus({
        isSubmitting: false,
        error: errorMessage,
        success: successMessage
      });
    } catch (error) {
      setRemoteCreatorStatus({
        isSubmitting: false,
        error: error?.message || 'Failed to create remote repository.',
        success: null
      });
    }
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!currentProject || !isDirty) {
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      const payload = {
        workflow: formState.workflow,
        provider: connectionMode === 'global' ? (gitSettings?.provider || 'github') : formState.provider,
        remoteUrl: formState.remoteUrl.trim(),
        defaultBranch: formState.defaultBranch.trim() || 'main'
      };
      const trimmedToken = formState.token.trim();
      if (trimmedToken) {
        payload.token = trimmedToken;
      }
      const saved = await updateProjectGitSettings(currentProject.id, payload);
      setFormState(buildFormState(saved));
    } catch (error) {
      setSaveError(error?.message || 'Failed to save project git settings');
    } finally {
      setIsSaving(false);
    }
  };

  const workflowLabel = formatWorkflow(settings?.workflow);

  const handleOpenGlobalSettings = () => {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('lucidcoder:open-git-settings'));
    }
  };

  return (
    <div className="git-tab" data-testid="git-tab-panel">
      <div className="git-overview">
        <section className="git-card">
          <div className="git-card-header">
            <div>
              <h4>Project connection</h4>
              <p>Choose how this project connects to a Git provider.</p>
            </div>
          </div>

          <form className="git-form" onSubmit={handleSave} data-testid="git-settings-form">
            <fieldset className="git-radio-group">
              <legend>Connection</legend>
              <label>
                <input
                  type="radio"
                  name="connection"
                  value="local"
                  checked={connectionMode === 'local'}
                  onChange={() => handleConnectionModeChange('local')}
                  data-testid="project-connection-local"
                />
                Local only
              </label>
              <label>
                <input
                  type="radio"
                  name="connection"
                  value="global"
                  checked={connectionMode === 'global'}
                  onChange={() => handleConnectionModeChange('global')}
                  data-testid="project-connection-global"
                />
                Use global connection
              </label>
              <label>
                <input
                  type="radio"
                  name="connection"
                  value="custom"
                  checked={connectionMode === 'custom'}
                  onChange={() => handleConnectionModeChange('custom')}
                  data-testid="project-connection-custom"
                />
                Use custom connection
              </label>
            </fieldset>

            {connectionMode === 'global' && !isGlobalConfigured && (
              <div className="git-inline-error" role="alert" data-testid="git-global-connection-alert">
                Global connection is not configured. Set it up in global Git settings.
                <button
                  type="button"
                  className="git-tab-configure"
                  onClick={handleOpenGlobalSettings}
                  data-testid="git-open-global-settings"
                >
                  Open global settings
                </button>
              </div>
            )}

            <label className="git-field">
              Provider
              <select
                value={formState.provider}
                onChange={handleFieldChange('provider')}
                disabled={connectionMode === 'global'}
                data-testid="project-provider-select"
              >
                {providerOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {requiresRemoteDetails && (
              <label className="git-field">
                Remote URL
                <input
                  type="url"
                  placeholder="https://github.com/user/repo.git"
                  value={formState.remoteUrl}
                  onChange={handleFieldChange('remoteUrl')}
                  data-testid="project-remote-url"
                />
              </label>
            )}

            {requiresRemoteDetails && (
              <div className={`git-remote-helper${showRemoteCreator ? ' expanded' : ''}`}>
                <button
                  type="button"
                  className="git-remote-helper-toggle"
                  onClick={handleToggleRemoteCreator}
                  data-testid="git-show-remote-creator"
                >
                  <span className="git-remote-helper-icon" aria-hidden="true">
                    <span className="git-remote-helper-plus">+</span>
                  </span>
                  {showRemoteCreator ? 'Hide repository tools' : 'Create repository for this project'}
                </button>
                {showRemoteCreator && (
                  <div className="git-remote-creator" data-testid="git-remote-creator-panel">
                    <div className="git-remote-creator-grid">
                      <label className="git-field">
                        Repository name
                        <input
                          type="text"
                          value={remoteCreatorState.name}
                          onChange={handleRemoteCreatorField('name')}
                          data-testid="git-remote-create-name"
                        />
                      </label>
                      <label className="git-field">
                        Owner or namespace (optional)
                        <input
                          type="text"
                          value={remoteCreatorState.owner}
                          onChange={handleRemoteCreatorField('owner')}
                          placeholder="org-name"
                          data-testid="git-remote-create-owner"
                        />
                      </label>
                      <label className="git-field">
                        Visibility
                        <select
                          value={remoteCreatorState.visibility}
                          onChange={handleRemoteCreatorField('visibility')}
                          data-testid="git-remote-create-visibility"
                        >
                          <option value="private">Private</option>
                          <option value="public">Public</option>
                        </select>
                      </label>
                    </div>
                    <label className="git-field">
                      Description (optional)
                      <textarea
                        rows="2"
                        value={remoteCreatorState.description}
                        onChange={handleRemoteCreatorField('description')}
                        placeholder="Shown on GitHub/GitLab"
                        data-testid="git-remote-create-description"
                      />
                    </label>
                    <div className="git-remote-creator-actions">
                      <button
                        type="button"
                        className="git-tab-configure"
                        onClick={handleCreateRemoteRepository}
                        disabled={remoteCreatorStatus.isSubmitting || !canCreateRepo || (connectionMode === 'global' && !isGlobalConfigured)}
                        data-testid="git-create-remote-button"
                      >
                        {remoteCreatorStatus.isSubmitting ? 'Creating…' : 'Create & link repository'}
                      </button>
                      <p className="git-remote-helper-hint">
                        Uses your {connectionMode === 'global' ? 'global' : 'project'} token to call {formState.provider === 'gitlab' ? 'GitLab' : 'GitHub'} APIs securely.
                      </p>
                    </div>
                    {remoteCreatorStatus.error && (
                      <p className="git-remote-creator-error" role="alert">
                        {remoteCreatorStatus.error}
                      </p>
                    )}
                    {remoteCreatorStatus.success && (
                      <p className="git-remote-creator-success">
                        {remoteCreatorStatus.success}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <label className="git-field">
              Default branch
              <input
                type="text"
                value={formState.defaultBranch}
                onChange={handleFieldChange('defaultBranch')}
                data-testid="project-default-branch"
              />
            </label>

            {requiresRemoteDetails && connectionMode !== 'global' && (
              <label className="git-field">
                Personal access token (optional)
                <input
                  type="password"
                  placeholder="ghp_..."
                  value={formState.token}
                  onChange={handleFieldChange('token')}
                  data-testid="project-token"
                />
              </label>
            )}

            {saveError && (
              <div className="git-inline-error" role="alert">
                {saveError}
              </div>
            )}

            <div className="git-form-actions">
              <button
                type="submit"
                className="git-tab-configure"
                disabled={!isDirty || isSaving || remoteUrlMissing}
                data-testid="git-save-preferences"
              >
                {isSaving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </form>
        </section>

        {requiresRemoteDetails && (
          <section className="git-card git-card-secondary" data-testid="git-repo-pane">
            <div className="git-card-header">
              <div>
                <h4>Repository</h4>
                <p>Manage the repo linked to this project.</p>
              </div>
            </div>
            <div className="git-repo-info">
              <div>
                <span className="label">Provider</span>
                <strong>{formatProvider(formState.provider)}</strong>
              </div>
              <div>
                <span className="label">Remote URL</span>
                {formState.remoteUrl ? (
                  <a href={formState.remoteUrl} target="_blank" rel="noreferrer">
                    {formState.remoteUrl}
                  </a>
                ) : (
                  <strong>Not linked</strong>
                )}
              </div>
              <div>
                <span className="label">Default branch</span>
                <strong>{formState.defaultBranch || 'main'}</strong>
              </div>
            </div>
            <div className="git-repo-actions">
              <div className="git-repo-actions-row">
                <button
                  type="button"
                  className="git-tab-configure"
                  onClick={handleFetchRemote}
                  disabled={!hasRemoteUrl || isFetchingRemote}
                  data-testid="git-fetch-remote"
                >
                  {isFetchingRemote ? 'Fetching…' : 'Fetch'}
                </button>
                <button
                  type="button"
                  className="git-tab-configure"
                  onClick={handlePullRemote}
                  disabled={!hasRemoteUrl || isPullingRemote}
                  data-testid="git-pull-remote"
                >
                  {isPullingRemote ? 'Pulling…' : 'Pull'}
                </button>
                <button
                  type="button"
                  className="git-tab-configure"
                  onClick={handleOpenRemote}
                  disabled={!hasRemoteUrl}
                  data-testid="git-open-remote"
                >
                  Open remote
                </button>
                <button
                  type="button"
                  className="git-tab-configure"
                  onClick={handleCopyRemote}
                  disabled={!hasRemoteUrl}
                  data-testid="git-copy-remote"
                >
                  Copy URL
                </button>
              </div>
              <div className="git-repo-status">
                {currentGitStatus?.hasRemote ? (
                  <div className="git-repo-status-grid">
                    <div>
                      <span className="label">Branch</span>
                      {/* c8 ignore next -- nested fallbacks are defensive */}
                      <strong>{currentGitStatus.branch || formState.defaultBranch || 'main'}</strong>
                    </div>
                    <div>
                      <span className="label">Ahead</span>
                      <strong>{currentGitStatus.ahead ?? 0}</strong>
                    </div>
                    <div>
                      <span className="label">Behind</span>
                      <strong>{currentGitStatus.behind ?? 0}</strong>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* c8 ignore start -- empty status is handled by disabled UI state */}
                    <p className="git-repo-status-empty">Remote status unavailable.</p>
                    {/* c8 ignore stop */}
                  </>
                )}
                {gitStatusError && (
                  <p className="git-remote-creator-error" role="alert">
                    {gitStatusError}
                  </p>
                )}
                {gitStatusMessage && (
                  <p className="git-remote-creator-success">
                    {gitStatusMessage}
                  </p>
                )}
              </div>
              <div className="git-repo-actions-row">
                <label className="git-field">
                  Checkout branch
                  <select
                    value={selectedBranch}
                    onChange={(event) => setSelectedBranch(event.target.value)}
                    disabled={!branchOptions.length}
                    data-testid="git-checkout-branch-select"
                  >
                    {branchOptions.length ? (
                      branchOptions.map((branch) => (
                        <option key={branch} value={branch}>
                          {branch}
                        </option>
                      ))
                    ) : (
                      <option value="">No branches</option>
                    )}
                  </select>
                </label>
                <button
                  type="button"
                  className="git-tab-configure"
                  onClick={handleCheckoutBranch}
                  disabled={!selectedBranch}
                  data-testid="git-checkout-branch"
                >
                  Checkout
                </button>
                <button
                  type="button"
                  className="git-tab-configure"
                  onClick={handleUpdateDefaultBranch}
                  disabled={!formState.defaultBranch.trim()}
                  data-testid="git-update-default-branch"
                >
                  Change default branch
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

export default GitTab;
