import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import './PackageTab.css';

const WORKSPACES = [
  { key: 'frontend', label: 'Frontend', manifestPath: 'frontend/package.json' },
  { key: 'backend', label: 'Backend', manifestPath: 'backend/package.json' }
];

// Test-only export: allows branch coverage of WORKSPACES[0]?.key fallbacks.
export const __testWorkspaces = WORKSPACES;

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

export const resolveActionProjectId = (projectId, override) => (
  override !== undefined ? override : projectId
);

const PackageTab = ({ project, forceProjectId }) => {
  const projectId = project?.id || null;
  const actionProjectId = resolveActionProjectId(projectId, forceProjectId);
  const {
    startAutomationJob,
    getJobsForProject
  } = useAppState();

  const [manifests, setManifests] = useState({ frontend: null, backend: null });
  const [loadingState, setLoadingState] = useState({ frontend: false, backend: false });
  const [errors, setErrors] = useState({ frontend: null, backend: null });
  const [drafts, setDrafts] = useState({
    frontend: { name: '', version: '', dev: false },
    backend: { name: '', version: '', dev: false }
  });
  const [globalError, setGlobalError] = useState('');
  const [activeWorkspaceKey, setActiveWorkspaceKey] = useState(WORKSPACES[0]?.key || 'frontend');
  const completedJobsRef = useRef(new Map());

  const jobs = useMemo(() => getJobsForProject(projectId), [getJobsForProject, projectId]);

  const packageJobs = useMemo(
    () => jobs.filter((job) => typeof job?.type === 'string' && /:(install|add-package|remove-package)/.test(job.type)),
    [jobs]
  );

  const workspaceBusy = useMemo(() => {
    return WORKSPACES.reduce((acc, workspace) => {
      acc[workspace.key] = packageJobs.some(
        (job) => job.type?.startsWith(`${workspace.key}:`) && job.status === 'running'
      );
      return acc;
    }, {});
  }, [packageJobs]);

  const updateManifestState = useCallback((workspaceKey, nextValue) => {
    setManifests((prev) => ({
      ...prev,
      [workspaceKey]: nextValue
    }));
  }, []);

  const fetchManifest = useCallback(async (workspaceKey) => {
    if (!projectId) {
      updateManifestState(workspaceKey, null);
      return;
    }

    const workspace = WORKSPACES.find((entry) => entry.key === workspaceKey);
    if (!workspace) {
      return;
    }

    setLoadingState((prev) => ({ ...prev, [workspaceKey]: true }));
    setErrors((prev) => ({ ...prev, [workspaceKey]: null }));

    try {
      const response = await fetch(`/api/projects/${projectId}/files/${workspace.manifestPath}`);
      const data = await response.json();

      if (!response.ok || !data.success || typeof data.content !== 'string') {
        throw new Error(data?.error || 'Failed to load package manifest');
      }

      const parsed = JSON.parse(data.content);
      if (!isObject(parsed)) {
        throw new Error('Manifest is not a valid JSON object');
      }
      updateManifestState(workspaceKey, parsed);
    } catch (error) {
      console.warn('Failed to load package manifest', error);
      setErrors((prev) => ({
        ...prev,
        [workspaceKey]: error.message || 'Failed to load manifest'
      }));
      updateManifestState(workspaceKey, null);
    } finally {
      setLoadingState((prev) => ({ ...prev, [workspaceKey]: false }));
    }
  }, [projectId, updateManifestState]);

  useEffect(() => {
    completedJobsRef.current.clear();
    setManifests({ frontend: null, backend: null });
    setErrors({ frontend: null, backend: null });
    setDrafts({ frontend: { name: '', version: '', dev: false }, backend: { name: '', version: '', dev: false } });
    setGlobalError('');
    setActiveWorkspaceKey(WORKSPACES[0]?.key || 'frontend');

    if (!projectId) {
      return;
    }

    WORKSPACES.forEach(({ key }) => {
      fetchManifest(key);
    });
  }, [projectId, fetchManifest]);

  useEffect(() => {
    if (!projectId) {
      return;
    }

    packageJobs.forEach((job) => {
      const previousStatus = completedJobsRef.current.get(job.id);
      if (job.status === 'succeeded' && previousStatus !== 'succeeded') {
        if (job.type.startsWith('frontend:')) {
          fetchManifest('frontend');
        } else if (job.type.startsWith('backend:')) {
          fetchManifest('backend');
        }
      }
      completedJobsRef.current.set(job.id, job.status);
    });
  }, [packageJobs, projectId, fetchManifest]);

  useEffect(() => {
    if (!PackageTab.__testHooks) {
      return;
    }
    const hooks = PackageTab.__testHooks;
    hooks.fetchManifest = fetchManifest;

    return () => {
      if (!PackageTab.__testHooks) {
        return;
      }
      PackageTab.__testHooks.fetchManifest = undefined;
    };
  }, [fetchManifest]);

  const handleDraftChange = (workspaceKey, field, value) => {
    setDrafts((prev) => ({
      ...prev,
      [workspaceKey]: {
        ...prev[workspaceKey],
        [field]: value
      }
    }));
  };

  const handleInstallDependencies = async (workspaceKey) => {
    if (!actionProjectId) {
      return;
    }
    setGlobalError('');
    try {
      await startAutomationJob(`${workspaceKey}:install`, { projectId: actionProjectId });
    } catch (error) {
      setGlobalError(error.message || 'Failed to start install job');
    }
  };

  const handleAddPackage = async (workspaceKey) => {
    if (!actionProjectId) {
      return;
    }
    const draft = drafts[workspaceKey];
    const packageName = draft.name.trim();
    if (!packageName) {
      setGlobalError('Enter a package name before adding it.');
      return;
    }
    setGlobalError('');
    try {
      await startAutomationJob(`${workspaceKey}:add-package`, {
        projectId: actionProjectId,
        payload: {
          packageName,
          version: draft.version.trim() || undefined,
          dev: draft.dev
        }
      });
      setDrafts((prev) => ({
        ...prev,
        [workspaceKey]: { ...prev[workspaceKey], name: '', version: '' }
      }));
    } catch (error) {
      setGlobalError(error.message || 'Failed to add package');
    }
  };

  const handleRemovePackage = async (workspaceKey, dependencyName, options = {}) => {
    if (!actionProjectId || !dependencyName) {
      return;
    }
    setGlobalError('');
    try {
      await startAutomationJob(`${workspaceKey}:remove-package`, {
        projectId: actionProjectId,
        payload: {
          packageName: dependencyName,
          dev: options.dev
        }
      });
    } catch (error) {
      setGlobalError(error.message || 'Failed to remove package');
    }
  };

  const handleRefreshManifest = (workspaceKey) => {
    if (loadingState[workspaceKey]) {
      return;
    }
    fetchManifest(workspaceKey);
  };

  const dependencyEntries = (manifest, key) => {
    if (!manifest || !isObject(manifest[key])) {
      return [];
    }
    return Object.entries(manifest[key]).sort(([a], [b]) => a.localeCompare(b));
  };

  const renderDependencyGroup = (workspaceKey, manifest, groupKey, label, isDevGroup = false) => {
    const entries = dependencyEntries(manifest, groupKey);
    if (!entries.length) {
      return (
        <div className="package-empty-group" data-testid={`package-empty-${workspaceKey}-${groupKey}`}>
          No {label.toLowerCase()} defined
        </div>
      );
    }

    return (
      <ul className="package-list" data-testid={`package-list-${workspaceKey}-${groupKey}`}>
        {entries.map(([name, version]) => (
          <li key={`${workspaceKey}-${groupKey}-${name}`} className="package-list-item" data-testid={`package-entry-${workspaceKey}-${groupKey}-${name}`}>
            <div className="package-list-entry">
              <span className="package-name">{name}</span>
              <span className="package-version">{version}</span>
            </div>
            <button
              type="button"
              className="package-remove-btn"
              onClick={() => handleRemovePackage(workspaceKey, name, { dev: isDevGroup })}
              disabled={workspaceBusy[workspaceKey]}
              title="Remove"
            >
              <svg
                className="package-remove-icon"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M3 6H21"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M8 6V4C8 3.44772 8.44772 3 9 3H15C15.5523 3 16 3.44772 16 4V6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M19 6L18.2 20.2C18.155 21.046 17.457 21.7 16.61 21.7H7.39C6.543 21.7 5.845 21.046 5.8 20.2L5 6"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M10 11V17"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M14 11V17"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              <span className="sr-only">Remove</span>
            </button>
          </li>
        ))}
      </ul>
    );
  };

  const renderWorkspace = (workspace) => {
    const manifest = manifests[workspace.key];
    const isBusy = workspaceBusy[workspace.key];
    const error = errors[workspace.key];
    const draft = drafts[workspace.key];
    const isLoading = loadingState[workspace.key];

    const tabId = `package-workspace-tab-${workspace.key}`;
    const panelId = `package-workspace-panel-${workspace.key}`;

    return (
      <section
        key={workspace.key}
        id={panelId}
        className="package-section"
        aria-live="polite"
        role="tabpanel"
        aria-labelledby={tabId}
      >
        <header className="package-section-header">
          <div>
            <h3>{workspace.label}</h3>
            {manifest && (
              <p className="package-manifest-meta">
                {manifest.name || 'Unnamed workspace'}{manifest.version ? ` · v${manifest.version}` : ''}
              </p>
            )}
            {!manifest && !error && !isLoading && (
              <p className="package-missing" data-testid={`package-missing-${workspace.key}`}>
                package.json not found for this workspace
              </p>
            )}
            {error && (
              <p className="package-error" data-testid={`package-error-${workspace.key}`}>
                {error}
              </p>
            )}
          </div>
          <div className="package-section-actions">
            <button
              type="button"
              onClick={() => handleRefreshManifest(workspace.key)}
              disabled={isLoading}
            >
              {isLoading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              onClick={() => handleInstallDependencies(workspace.key)}
              disabled={!manifest || isBusy}
            >
              {isBusy ? 'Job running…' : 'Install dependencies'}
            </button>
          </div>
        </header>

        {manifest && (
          <div className="package-panel">
            <div className="package-form" data-testid={`package-form-${workspace.key}`}>
              <label>
                <span>Package name</span>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(event) => handleDraftChange(workspace.key, 'name', event.target.value)}
                  placeholder="e.g. react"
                />
              </label>
              <label>
                <span>Version (optional)</span>
                <input
                  type="text"
                  value={draft.version}
                  onChange={(event) => handleDraftChange(workspace.key, 'version', event.target.value)}
                  placeholder="latest"
                />
              </label>
              <label className="package-checkbox">
                <input
                  type="checkbox"
                  checked={draft.dev}
                  onChange={(event) => handleDraftChange(workspace.key, 'dev', event.target.checked)}
                />
                <span>Dev dependency</span>
              </label>
              <button type="button" onClick={() => handleAddPackage(workspace.key)} disabled={isBusy}>
                Add package
              </button>
            </div>

            <div className="package-groups">
              <div>
                <h4>Dependencies</h4>
                {renderDependencyGroup(workspace.key, manifest, 'dependencies', 'Dependencies')}
              </div>
              <div>
                <h4>Dev Dependencies</h4>
                {renderDependencyGroup(workspace.key, manifest, 'devDependencies', 'Dev Dependencies', true)}
              </div>
            </div>
          </div>
        )}
      </section>
    );
  };

  const activeWorkspace = WORKSPACES.find((workspace) => workspace.key === activeWorkspaceKey) || WORKSPACES[0];

  return (
    <div className="package-tab" data-testid="package-tab">
      <div
        className="package-workspace-tabs"
        role="tablist"
        aria-label="Package workspaces"
      >
        {WORKSPACES.map((workspace) => {
          const tabId = `package-workspace-tab-${workspace.key}`;
          const panelId = `package-workspace-panel-${workspace.key}`;
          const isActive = workspace.key === activeWorkspace?.key;
          return (
            <button
              key={workspace.key}
              id={tabId}
              type="button"
              role="tab"
              className={`package-workspace-tab ${isActive ? 'is-active' : ''}`.trim()}
              aria-selected={isActive}
              aria-controls={panelId}
              data-testid={`package-workspace-tab-${workspace.key}`}
              onClick={() => setActiveWorkspaceKey(workspace.key)}
            >
              {workspace.label}
            </button>
          );
        })}
      </div>

      {globalError && (
        <div className="package-global-error" role="alert">
          {globalError}
        </div>
      )}
      <div className="package-sections">
        {activeWorkspace ? renderWorkspace(activeWorkspace) : null}
      </div>
    </div>
  );
};

export default PackageTab;

PackageTab.__testHooks = PackageTab.__testHooks || {};
