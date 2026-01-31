import React, { useLayoutEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import './GitSettingsModal.css';

const emptySettings = {
  workflow: 'local',
  provider: 'github',
  remoteUrl: '',
  username: '',
  token: '',
  tokenExpiresAt: '',
  defaultBranch: 'main'
};

const providerOptions = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' }
];

const stripDeprecatedGitFields = (settings = {}) => {
  const { autoPush, useCommitTemplate, commitTemplate, ...rest } = settings || {};
  return rest;
};

const GitSettingsModal = ({
  isOpen,
  onClose,
  settings = emptySettings,
  onSave,
  onTestConnection,
  connectionStatus = null,
  scope = 'global',
  projectName = ''
}) => {
  const [formState, setFormState] = useState({ ...emptySettings, ...stripDeprecatedGitFields(settings) });
  const [testStatus, setTestStatus] = useState({ state: 'idle', message: '' });
  const [isPatHelpOpen, setPatHelpOpen] = useState(false);
  const [showConnectionForm, setShowConnectionForm] = useState(true);
  const scopeLabel = scope === 'project'
    ? `Project · ${projectName || 'Current Project'}`
    : 'Global Default';
  const scopeDescription = scope === 'project'
    ? `Overrides just for ${projectName || 'this project'}.`
    : 'Configure cloud provider access. Commits stay manual after testing completes.';
  const handleFieldChange = (field) => (event) => {
    let value = event.target.value;
    /* c8 ignore start -- checkbox inputs are not rendered in this modal */
    if (event.target.type === 'checkbox') {
      value = event.target.checked;
    }
    /* c8 ignore stop */
    setFormState((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const buildSavePayload = () => {
    const payload = { ...stripDeprecatedGitFields(formState) };
    if (scope === 'global') {
      delete payload.remoteUrl;
    }
    if (!payload.token) {
      delete payload.token;
    }
    return payload;
  };

  const handleWorkflowChange = (event) => {
    const nextWorkflow = event.target.value === 'cloud' ? 'cloud' : 'local';
    setFormState((prev) => ({
      ...prev,
      workflow: nextWorkflow,
      provider: nextWorkflow === 'cloud' ? prev.provider || 'github' : prev.provider,
      remoteUrl: nextWorkflow === 'cloud' ? prev.remoteUrl : prev.remoteUrl,
      username: nextWorkflow === 'cloud' ? prev.username : prev.username,
      token: nextWorkflow === 'cloud' ? prev.token : prev.token
    }));
  };

  const workflowRadioProps = (value, testId) => ({
    type: 'radio',
    name: 'workflow',
    value,
    checked: formState.workflow === value,
    onChange: handleWorkflowChange,
    'data-testid': testId
  });

  const handleSubmit = (event) => {
    event.preventDefault();
    onSave(buildSavePayload());
  };

  const handleTestConnection = async () => {
    /* c8 ignore start -- test connection button is hidden when handler is absent */
    if (typeof onTestConnection !== 'function') {
      return;
    }
    /* c8 ignore stop */
    setTestStatus({ state: 'testing', message: 'Testing connection…' });
    try {
      const result = await onTestConnection({
        provider: formState.provider,
        token: formState.token
      });
      const accountName = result?.account?.login || result?.account?.name || '';
      const message = accountName
        ? `${result?.message || 'Connected'} as ${accountName}`
        : result?.message || 'Connection successful';
      setTestStatus({ state: 'success', message });
      if (scope === 'global' && formState.token.trim() && typeof onSave === 'function') {
        await onSave(buildSavePayload(), { keepOpen: true });
      }
    } catch (error) {
      setTestStatus({ state: 'error', message: error?.message || 'Connection failed' });
    }
  };

  const handleBackdropClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  const patHelpContent = useMemo(() => {
    const providerLabel = formState.provider === 'gitlab' ? 'GitLab' : 'GitHub';
    const guideUrl = formState.provider === 'gitlab'
      ? 'https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html'
      : 'https://docs.github.com/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token';
    const scopes = formState.provider === 'gitlab'
      ? 'api'
      : 'repo (or public_repo for public-only)';

    return (
      <div className="git-settings-help-body">
        <p><strong>{providerLabel} personal access token</strong></p>
        <ol>
          <li>Open the {providerLabel} token settings page.</li>
          <li>Create a new token and select scopes: <strong>{scopes}</strong>.</li>
          <li>Paste the token here and save.</li>
        </ol>
        <p>
          Docs: <a href={guideUrl} target="_blank" rel="noreferrer">{guideUrl}</a>
        </p>
        <p>
          Tokens are typically time-limited. Add an expiry date so we can warn you before it expires.
        </p>
      </div>
    );
  }, [formState.provider]);

  const expiryWarning = useMemo(() => {
    if (!formState.tokenExpiresAt) {
      return null;
    }
    const parsed = new Date(formState.tokenExpiresAt);
    if (Number.isNaN(parsed.getTime())) {
      return 'Token expiry date is invalid.';
    }
    const now = new Date();
    const diffMs = parsed.getTime() - now.getTime();
    const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays < 0) {
      return 'This token appears to be expired. Update it to avoid sync failures.';
    }
    if (diffDays <= 14) {
      return `This token expires in ${diffDays} day${diffDays === 1 ? '' : 's'}.`;
    }
    return null;
  }, [formState.tokenExpiresAt]);

  useLayoutEffect(() => {
    if (isOpen) {
      setFormState({ ...emptySettings, ...stripDeprecatedGitFields(settings) });
      setPatHelpOpen(false);

      if (connectionStatus?.message && connectionStatus?.provider) {
        const accountName = connectionStatus?.account?.login || connectionStatus?.account?.name || '';
        const message = accountName
          ? `${connectionStatus.message} as ${accountName}`
          : connectionStatus.message;
        setTestStatus({ state: 'success', message });
        setShowConnectionForm(false);
      } else {
        setTestStatus({ state: 'idle', message: '' });
        setShowConnectionForm(true);
      }
    }
  }, [isOpen, settings, connectionStatus]);

  if (!isOpen) {
    return null;
  }

  return (
    <div
      className="git-settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="git-settings-title"
      onClick={handleBackdropClick}
      data-testid="git-settings-modal"
    >
      <div className="git-settings-panel">
        <div className="git-settings-header">
          <div>
            <h2 id="git-settings-title">Git Settings</h2>
            <div className="git-settings-scope-row">
              <p className="git-settings-subtitle">{scopeDescription}</p>
              <span className="git-settings-scope" data-testid="git-scope-badge">{scopeLabel}</span>
            </div>
          </div>
          <button
            type="button"
            className="git-settings-close"
            onClick={onClose}
            aria-label="Close git settings"
            data-testid="git-close-button"
          >
            &times;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="git-settings-form" data-testid="git-settings-form">
          <fieldset className="git-settings-fieldset">
            <legend>Workflow Preference</legend>
            <label className="git-settings-radio">
              <input {...workflowRadioProps('local', 'git-workflow-local')} />
              Keep work local only
            </label>
            <label className="git-settings-radio">
              <input {...workflowRadioProps('cloud', 'git-workflow-cloud')} />
              Cloud sync (GitHub/GitLab)
            </label>
          </fieldset>

          {formState.workflow === 'cloud' && !showConnectionForm && connectionStatus?.provider && (
            <div className="git-settings-connection">
              <div className="git-settings-connection-title">Connection</div>
              <div className="git-settings-connection-status success" data-testid="git-connection-summary">
                {/* c8 ignore next -- summary fallback not reachable when message is set */}
                {testStatus.message || `Connected to ${connectionStatus.provider}`}
              </div>
              {connectionStatus?.testedAt && (
                <div className="git-settings-connection-meta">
                  Last checked {new Date(connectionStatus.testedAt).toLocaleString()}
                </div>
              )}
              <button
                type="button"
                className="git-settings-button secondary"
                onClick={() => {
                  setShowConnectionForm(true);
                  setTestStatus({ state: 'idle', message: '' });
                }}
                data-testid="git-connection-edit"
              >
                Change connection
              </button>
            </div>
          )}

          {formState.workflow === 'cloud' && showConnectionForm && (
            <div className="git-settings-grid">
              <label className="git-settings-label">
                Provider
                <select
                  value={formState.provider}
                  onChange={handleFieldChange('provider')}
                  data-testid="git-provider-select"
                >
                  {providerOptions.map((provider) => (
                    <option key={provider.value} value={provider.value}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>

              {scope === 'project' && (
                <label className="git-settings-label">
                  Remote URL
                  <input
                    type="url"
                    placeholder="https://github.com/user/repo.git"
                    value={formState.remoteUrl}
                    onChange={handleFieldChange('remoteUrl')}
                    data-testid="git-remote-url"
                  />
                </label>
              )}

              {scope === 'global' && (
                <div className="git-settings-hint" data-testid="git-global-remote-hint">
                  Remote URLs are configured per project.
                </div>
              )}


              <label className="git-settings-label">
                Personal access token
                <input
                  type="password"
                  placeholder="ghp_..."
                  value={formState.token}
                  onChange={handleFieldChange('token')}
                  data-testid="git-token"
                />
                <span className="git-settings-help">
                  Required for cloud sync unless this machine already has Git credentials configured.
                </span>
                {scope === 'global' && (
                  <div className="git-settings-pat-actions">
                    <button
                      type="button"
                      className="git-settings-link"
                      onClick={() => setPatHelpOpen(true)}
                      data-testid="git-pat-help"
                    >
                      PAT help
                    </button>
                  </div>
                )}
              </label>

              {scope === 'global' && (
                <label className="git-settings-label">
                  Token expiry date (optional)
                  <input
                    type="date"
                    value={formState.tokenExpiresAt || ''}
                    onChange={handleFieldChange('tokenExpiresAt')}
                    data-testid="git-token-expiry"
                  />
                  <span className="git-settings-help">
                    Used to remind you before the token expires.
                  </span>
                </label>
              )}

              {scope === 'global' && typeof onTestConnection === 'function' && (
                <div className="git-settings-test">
                  <button
                    type="button"
                    className="git-settings-button secondary"
                    onClick={handleTestConnection}
                    disabled={testStatus.state === 'testing'}
                    data-testid="git-test-connection"
                  >
                    {testStatus.state === 'testing' ? 'Testing…' : 'Test connection'}
                  </button>
                  {connectionStatus?.testedAt && testStatus.state === 'success' && (
                    <span className="git-settings-test-meta" data-testid="git-test-connection-meta">
                      Last checked {new Date(connectionStatus.testedAt).toLocaleString()}
                    </span>
                  )}
                  {testStatus.state !== 'idle' && (
                    <span
                      className={`git-settings-test-status ${testStatus.state}`}
                      role={testStatus.state === 'error' ? 'alert' : 'status'}
                      data-testid="git-test-connection-status"
                    >
                      {testStatus.message}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="git-settings-grid">
            <label className="git-settings-label">
              Default branch name
              <input
                type="text"
                value={formState.defaultBranch}
                onChange={handleFieldChange('defaultBranch')}
                data-testid="git-default-branch"
              />
            </label>

          </div>

          {scope === 'global' && expiryWarning && (
            <div className="git-settings-warning" role="status" data-testid="git-token-expiry-warning">
              {expiryWarning}
            </div>
          )}

          <div className="git-settings-footer">
            <button
              type="button"
              className="git-settings-button secondary"
              onClick={onClose}
              data-testid="git-cancel-button"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="git-settings-button primary"
              data-testid="git-save-button"
            >
              Save preferences
            </button>
          </div>
        </form>
      </div>
      <Modal
        isOpen={isPatHelpOpen}
        onClose={() => setPatHelpOpen(false)}
        title="Personal access tokens"
        message={patHelpContent}
        confirmText=""
        cancelText="Close"
      />
    </div>
  );
};

export default GitSettingsModal;
