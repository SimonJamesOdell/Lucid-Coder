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

const trackedFields = ['workflow', 'provider', 'remoteUrl', 'defaultBranch'];

const GitTab = () => {
  const {
    currentProject,
    getEffectiveGitSettings,
    getProjectGitSettingsSnapshot,
    clearProjectGitSettings,
    updateProjectGitSettings,
    createProjectRemoteRepository
  } = useAppState();
  const settings = currentProject ? getEffectiveGitSettings(currentProject.id) : null;
  const gitSnapshot = currentProject ? getProjectGitSettingsSnapshot(currentProject.id) : null;
  const hasOverrides = Boolean(gitSnapshot && !gitSnapshot.inheritsFromGlobal);

  const [formState, setFormState] = useState(buildFormState(settings));
  const [isResettingOverrides, setIsResettingOverrides] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showRemoteCreator, setShowRemoteCreator] = useState(false);
  const [remoteCreatorState, setRemoteCreatorState] = useState(buildRemoteCreatorState(currentProject?.name));
  const [remoteCreatorStatus, setRemoteCreatorStatus] = useState({ isSubmitting: false, error: null, success: null });

  useEffect(() => {
    setFormState(buildFormState(settings));
  }, [settings?.workflow, settings?.provider, settings?.remoteUrl, settings?.defaultBranch]);

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

  const handleFieldChange = (field) => (event) => {
    const { value } = event.target;
    setFormState((prev) => ({
      ...prev,
      [field]: value
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

  const handleCreateRemoteRepository = async (event) => {
    event.preventDefault();
    const trimmedToken = formState.token.trim();
    if (!trimmedToken) {
      setRemoteCreatorStatus({ isSubmitting: false, error: 'Enter a personal access token to create the repository.', success: null });
      return;
    }

    setRemoteCreatorStatus({ isSubmitting: true, error: null, success: null });
    try {
      const response = await createProjectRemoteRepository(currentProject.id, {
        provider: formState.provider,
        name: remoteCreatorState.name,
        owner: remoteCreatorState.owner || undefined,
        visibility: remoteCreatorState.visibility,
        description: remoteCreatorState.description,
        token: trimmedToken,
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

      setRemoteCreatorStatus({ isSubmitting: false, error: null, success: 'Repository created and linked.' });
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
        provider: formState.provider,
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

  const handleResetOverrides = async () => {
    setIsResettingOverrides(true);
    setSaveError(null);
    try {
      await clearProjectGitSettings(currentProject.id);
      const nextSettings = getEffectiveGitSettings(currentProject.id);
      setFormState(buildFormState(nextSettings));
    } catch (error) {
      setSaveError(error?.message || 'Failed to reset project git settings');
    } finally {
      setIsResettingOverrides(false);
    }
  };

  const workflowLabel = formatWorkflow(settings?.workflow);
  const providerLabel = settings?.workflow === 'cloud' ? formatProvider(settings?.provider) : 'Local workspace';

  const statusItems = settings?.workflow === 'cloud'
    ? [
        { label: 'Provider', value: providerLabel },
        { label: 'Remote URL', value: settings?.remoteUrl || 'Missing remote URL', warn: !settings?.remoteUrl },
        { label: 'Default branch', value: settings?.defaultBranch || 'main' }
      ]
    : [
        { label: 'Mode', value: 'Local workspace' },
        { label: 'Remote', value: 'Not connected' }
      ];

  const statusNote = settings?.workflow === 'cloud'
    ? (settings?.remoteUrl
        ? 'Remote host is ready to use when you push from the Branches tab.'
        : 'Add a remote URL to complete the connection for this project.')
    : 'Work stays on your machine until you hook up a remote host.';

  return (
    <div className="git-tab" data-testid="git-tab-panel">
      <div className="git-overview">
        <section className="git-card">
          <div className="git-card-header">
            <div>
              <h4>Remote Preference</h4>
              <p>Defaults from the global settings are applied automatically.</p>
            </div>
            <div className="git-pill-row">
              <span className={`git-pill ${hasOverrides ? 'pill-override' : 'pill-inherit'}`} data-testid="git-inheritance-indicator">
                {hasOverrides ? 'Project override' : 'Using global defaults'}
              </span>
              <span className="git-pill subtle">{workflowLabel}</span>
            </div>
          </div>

          <form className="git-form" onSubmit={handleSave} data-testid="git-settings-form">
            <fieldset className="git-radio-group">
              <legend>Workflow</legend>
              <label>
                <input
                  type="radio"
                  name="workflow"
                  value="local"
                  checked={formState.workflow === 'local'}
                  onChange={handleFieldChange('workflow')}
                  data-testid="project-workflow-local"
                />
                Local only
              </label>
              <label>
                <input
                  type="radio"
                  name="workflow"
                  value="cloud"
                  checked={formState.workflow === 'cloud'}
                  onChange={handleFieldChange('workflow')}
                  data-testid="project-workflow-cloud"
                />
                Remote host
              </label>
            </fieldset>

            <label className="git-field">
              Provider
              <select
                value={formState.provider}
                onChange={handleFieldChange('provider')}
                disabled={!requiresRemoteDetails}
                data-testid="project-provider-select"
              >
                {providerOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="git-field">
              Remote URL
              <input
                type="url"
                placeholder="https://github.com/user/repo.git"
                value={formState.remoteUrl}
                onChange={handleFieldChange('remoteUrl')}
                disabled={!requiresRemoteDetails}
                data-testid="project-remote-url"
              />
            </label>

            {requiresRemoteDetails && (
              <div className={`git-remote-helper${showRemoteCreator ? ' expanded' : ''}`}>
                <button
                  type="button"
                  className="git-remote-helper-toggle"
                  onClick={handleToggleRemoteCreator}
                  data-testid="git-show-remote-creator"
                >
                  {showRemoteCreator ? 'Hide remote creation' : 'Create repository for this project'}
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
                        disabled={remoteCreatorStatus.isSubmitting || !remoteCreatorState.name.trim()}
                        data-testid="git-create-remote-button"
                      >
                        {remoteCreatorStatus.isSubmitting ? 'Creating…' : 'Create & link repository'}
                      </button>
                      <p className="git-remote-helper-hint">
                        Uses the token above to call {formState.provider === 'gitlab' ? 'GitLab' : 'GitHub'} APIs securely.
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

            <label className="git-field">
              Personal access token (optional)
              <input
                type="password"
                placeholder="ghp_..."
                value={formState.token}
                onChange={handleFieldChange('token')}
                disabled={!requiresRemoteDetails}
                data-testid="project-token"
              />
            </label>

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
              {hasOverrides && (
                <button
                  type="button"
                  className="ghost"
                  onClick={handleResetOverrides}
                  disabled={isResettingOverrides}
                  data-testid="git-reset-overrides"
                >
                  {isResettingOverrides ? 'Restoring…' : 'Use global defaults'}
                </button>
              )}
            </div>
          </form>
        </section>

        <section className="git-card git-card-secondary">
          <div className="git-card-header">
            <div>
              <h4>Connection Status</h4>
              <p>Quick health check for this project’s remote setup.</p>
            </div>
          </div>
          <ul className="git-status-list">
            {statusItems.map((item) => (
              <li key={item.label} className={`git-status-item${item.warn ? ' warn' : ''}`}>
                <span className="label">{item.label}</span>
                <strong>{item.value}</strong>
              </li>
            ))}
          </ul>
          <p className="git-status-note">{statusNote}</p>
        </section>
      </div>
    </div>
  );
};

export default GitTab;
