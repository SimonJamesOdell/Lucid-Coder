import React, { useLayoutEffect, useState } from 'react';
import './GitSettingsModal.css';

const emptySettings = {
  workflow: 'local',
  provider: 'github',
  remoteUrl: '',
  username: '',
  token: '',
  defaultBranch: 'main',
  autoPush: false,
  useCommitTemplate: false,
  commitTemplate: ''
};

const providerOptions = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' }
];

const GitSettingsModal = ({
  isOpen,
  onClose,
  settings = emptySettings,
  onSave,
  scope = 'global',
  projectName = ''
}) => {
  const [formState, setFormState] = useState({ ...emptySettings, ...settings });
  const scopeLabel = scope === 'project'
    ? `Project · ${projectName || 'Current Project'}`
    : 'Global Default';
  const scopeDescription = scope === 'project'
    ? `Overrides just for ${projectName || 'this project'}.`
    : 'Control how Lucid Coder manages commits, remotes, and cloud publishing.';

  useLayoutEffect(() => {
    if (isOpen) {
      setFormState({ ...emptySettings, ...settings });
    }
  }, [isOpen, settings]);

  if (!isOpen) {
    return null;
  }

  const handleFieldChange = (field) => (event) => {
    const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
    setFormState((prev) => ({
      ...prev,
      [field]: value
    }));
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
    onSave(formState);
  };

  const handleBackdropClick = (event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

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

          {formState.workflow === 'cloud' && (
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

              <label className="git-settings-label">
                Username or Org
                <input
                  type="text"
                  placeholder="octocat"
                  value={formState.username}
                  onChange={handleFieldChange('username')}
                  data-testid="git-username"
                />
              </label>

              <label className="git-settings-label">
                Personal access token (optional)
                <input
                  type="password"
                  placeholder="ghp_..."
                  value={formState.token}
                  onChange={handleFieldChange('token')}
                  data-testid="git-token"
                />
              </label>
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

            <label className="git-settings-toggle">
              <input
                type="checkbox"
                checked={formState.autoPush}
                onChange={handleFieldChange('autoPush')}
                data-testid="git-auto-push"
              />
              Auto push after Lucid stages commits
            </label>

            <label className="git-settings-toggle">
              <input
                type="checkbox"
                checked={formState.useCommitTemplate}
                onChange={handleFieldChange('useCommitTemplate')}
                data-testid="git-commit-template-toggle"
              />
              Use commit message template
            </label>
          </div>

          {formState.useCommitTemplate && (
            <label className="git-settings-label">
              Commit template
              <textarea
                rows="3"
                placeholder="feat: describe the change"
                value={formState.commitTemplate}
                onChange={handleFieldChange('commitTemplate')}
                data-testid="git-commit-template"
              />
            </label>
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
    </div>
  );
};

export default GitSettingsModal;
