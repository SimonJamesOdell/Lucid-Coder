import React from 'react';

const GitSetupSection = ({
  projectSource,
  createLoading,
  localPath,
  setLocalPath,
  createError,
  setCreateError,
  handleFolderSelect,
  localImportMode,
  setLocalImportMode,
  gitConnectionMode,
  setGitConnectionMode,
  gitConnectionRemoteUrl,
  setGitConnectionRemoteUrl,
  gitRemoteUrl,
  setGitRemoteUrl,
  cloneCreateRemote,
  setCloneCreateRemote,
  gitWorkflowMode,
  setGitWorkflowMode,
  setGitCloudMode,
  gitProvider,
  setGitProvider,
  gitToken,
  setGitToken,
  gitCloudMode,
  gitRepoName,
  setGitRepoName,
  newProjectName,
  gitRepoOwner,
  setGitRepoOwner,
  gitRepoVisibility,
  setGitRepoVisibility,
  shouldShowGitSummary,
  gitSummaryItems
}) => {
  return (
    <div className={`form-section${projectSource === 'local' ? ' form-section--full' : ''}`}>
      <h3>
        {projectSource === 'local'
          ? 'Import setup'
          : (projectSource === 'git' ? 'Clone setup' : 'Git setup')}
      </h3>

      {projectSource === 'local' && (
        <>
          <div className="form-row">
            <div className="form-group form-group--inline" style={{ width: '100%' }}>
              <label htmlFor="project-path">Project Folder Path *</label>
              <div className="path-input-group">
                <input
                  id="project-path"
                  type="text"
                  placeholder="Enter the path to your project folder"
                  value={localPath}
                  onChange={(event) => {
                    setLocalPath(event.target.value);
                    if (createError) {
                      setCreateError('');
                    }
                  }}
                  className="form-input"
                  disabled={createLoading}
                />
                <button
                  type="button"
                  onClick={handleFolderSelect}
                  className="browse-btn"
                  disabled={createLoading}
                >
                  Browse
                </button>
              </div>
              <div className="radio-group">
                <label className={`radio-card ${localImportMode === 'copy' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="localImportMode"
                    value="copy"
                    checked={localImportMode === 'copy'}
                    onChange={() => setLocalImportMode('copy')}
                    disabled={createLoading}
                  />
                  <div>
                    <div className="radio-title">Copy into managed folder</div>
                    <div className="radio-subtitle">LucidCoder will copy the project into its workspace.</div>
                  </div>
                </label>
                <label className={`radio-card ${localImportMode === 'link' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="localImportMode"
                    value="link"
                    checked={localImportMode === 'link'}
                    onChange={() => setLocalImportMode('link')}
                    disabled={createLoading}
                  />
                  <div>
                    <div className="radio-title">Link to existing folder</div>
                    <div className="radio-subtitle">Keep the project in place (must be inside the managed folder).</div>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group form-group--inline">
              <label htmlFor="git-connection-select">Git Workflow *</label>
              <select
                id="git-connection-select"
                value={gitConnectionMode}
                onChange={(e) => {
                  setGitConnectionMode(e.target.value);
                  if (createError) {
                    setCreateError('');
                  }
                }}
                className="form-select"
                disabled={createLoading}
              >
                <option value="local">Local only</option>
                <option value="global">Cloud (use global git settings)</option>
                <option value="custom">Cloud (custom connection)</option>
              </select>
            </div>
          </div>

          {gitConnectionMode !== 'local' && (
            <div className="form-row">
              <div className="form-group" style={{ width: '100%' }}>
                <label htmlFor="git-connection-remote-url">Repository URL *</label>
                <input
                  id="git-connection-remote-url"
                  type="text"
                  placeholder="https://github.com/org/repo.git"
                  value={gitConnectionRemoteUrl}
                  onChange={(e) => {
                    setGitConnectionRemoteUrl(e.target.value);
                    if (createError) {
                      setCreateError('');
                    }
                  }}
                  className="form-input"
                  disabled={createLoading}
                />
              </div>
            </div>
          )}
        </>
      )}

      {projectSource === 'git' && (
        <>
          <div className="form-row form-row--inline" style={{ gridTemplateColumns: '30% 70%' }}>
            <label className="form-label" htmlFor="git-clone-url">Repository URL *</label>
            <input
              id="git-clone-url"
              type="text"
              placeholder="https://github.com/org/repo.git"
              value={gitRemoteUrl}
              onChange={(e) => {
                setGitRemoteUrl(e.target.value);
                if (createError) {
                  setCreateError('');
                }
              }}
              className="form-input"
              disabled={createLoading}
            />
          </div>

          <div className="form-row form-row--inline" style={{ gridTemplateColumns: '30% 70%' }}>
            <label className="form-label" htmlFor="git-connection-select">Git Workflow *</label>
            <select
              id="git-connection-select"
              value={gitConnectionMode}
              onChange={(e) => {
                setGitConnectionMode(e.target.value);
                if (createError) {
                  setCreateError('');
                }
              }}
              className="form-select"
              disabled={createLoading}
            >
              <option value="local">Local only</option>
              <option value="global">Cloud (use global git settings)</option>
              <option value="custom">Cloud (custom connection)</option>
            </select>
          </div>

          {gitConnectionMode !== 'local' && (
            <div className="radio-group radio-group--spaced radio-group--clone">
              <label className={`radio-card ${cloneCreateRemote ? 'selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={cloneCreateRemote}
                  onChange={(event) => setCloneCreateRemote(event.target.checked)}
                  disabled={createLoading}
                />
                <div>
                  <div className="radio-title">Create a new repo after cloning (create fork)</div>
                  <div className="radio-subtitle">Push the cloned project into a new repository you own.</div>
                </div>
              </label>
            </div>
          )}
        </>
      )}

      {projectSource === 'new' && (
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="git-workflow-select">Git Workflow *</label>
            <select
              id="git-workflow-select"
              value={gitWorkflowMode}
              onChange={(e) => {
                const next = e.target.value;
                setGitWorkflowMode(next);
                setGitCloudMode('');
                if (createError) {
                  setCreateError('');
                }
              }}
              className="form-select"
              disabled={createLoading}
              autoFocus
            >
              <option value="">Select a workflow</option>
              <option value="local">Local only</option>
              <option value="global">Cloud (use global git settings)</option>
              <option value="custom">Cloud (custom connection)</option>
            </select>
          </div>

        </div>
      )}

      {(projectSource === 'new' ? gitWorkflowMode === 'custom' : gitConnectionMode === 'custom') && (
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="git-provider-select">Git Provider *</label>
            <select
              id="git-provider-select"
              value={gitProvider}
              onChange={(e) => {
                setGitProvider(e.target.value);
                if (createError) {
                  setCreateError('');
                }
              }}
              className="form-select"
              disabled={createLoading}
            >
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="git-token-input">Personal Access Token *</label>
            <input
              id="git-token-input"
              type="password"
              placeholder="Enter PAT"
              value={gitToken}
              onChange={(e) => {
                setGitToken(e.target.value);
                if (createError) {
                  setCreateError('');
                }
              }}
              className="form-input"
              disabled={createLoading}
              autoComplete="off"
            />
          </div>
        </div>
      )}

      {projectSource === 'new' && (gitWorkflowMode === 'global' || gitWorkflowMode === 'custom') && gitCloudMode === 'connect' && (
        <div className="form-row">
          <div className="form-group" style={{ width: '100%' }}>
            <label htmlFor="git-remote-url-input">Repository URL *</label>
            <input
              id="git-remote-url-input"
              type="text"
              placeholder="https://github.com/org/repo.git"
              value={gitRemoteUrl}
              onChange={(e) => {
                setGitRemoteUrl(e.target.value);
                if (createError) {
                  setCreateError('');
                }
              }}
              className="form-input"
              disabled={createLoading}
            />
          </div>
        </div>
      )}

      {(projectSource === 'new' && (gitWorkflowMode === 'global' || gitWorkflowMode === 'custom') && gitCloudMode === 'create')
        || (projectSource === 'git' && cloneCreateRemote) ? (
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="git-repo-name">Repository Name</label>
            <input
              id="git-repo-name"
              type="text"
              placeholder={newProjectName.trim() ? `Default: ${newProjectName.trim()}` : 'Repository name'}
              value={gitRepoName}
              onChange={(e) => {
                setGitRepoName(e.target.value);
                if (createError) {
                  setCreateError('');
                }
              }}
              className="form-input"
              disabled={createLoading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="git-repo-owner">Owner / Org</label>
            <input
              id="git-repo-owner"
              type="text"
              placeholder="Optional"
              value={gitRepoOwner}
              onChange={(e) => {
                setGitRepoOwner(e.target.value);
                if (createError) {
                  setCreateError('');
                }
              }}
              className="form-input"
              disabled={createLoading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="git-repo-visibility">Visibility</label>
            <select
              id="git-repo-visibility"
              value={gitRepoVisibility}
              onChange={(e) => setGitRepoVisibility(e.target.value)}
              className="form-select"
              disabled={createLoading}
            >
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
          </div>
        </div>
      ) : null}

      {projectSource === 'new' && shouldShowGitSummary && gitSummaryItems.length > 0 && (
        <div className="git-summary-card">
          <h4>Derived from repo</h4>
          {gitSummaryItems.map((item) => (
            <div className="git-summary-row" key={item.label}>
              <span className="git-summary-label">{item.label}</span>
              <span className="git-summary-value">{item.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default GitSetupSection;
