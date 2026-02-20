import React, { useRef, useState, useCallback, useEffect } from 'react';
import { useAppState } from '../context/AppStateContext';
import { startAgentUiBridge } from '../utils/agentUiBridge';
import PreviewTab from './PreviewTab';
import GoalsTab from './GoalsTab';
import FilesTab from './FilesTab';
import TestTab from './TestTab';
import BranchTab from './BranchTab';
import CommitsTab from './CommitsTab';
import GitTab from './GitTab';
import ProcessesTab from './ProcessesTab';
import PackageTab from './PackageTab';
import LLMUsageTab from './LLMUsageTab';
import AssetsTab from './AssetsTab';
import './PreviewPanel.css';

export const isLoopbackHostname = (hostname) => {
  if (typeof hostname !== 'string') {
    return false;
  }

  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
};

const PreviewPanel = () => {
  const [localActiveTab, setLocalActiveTab] = useState('preview');
  const [localFollowAutomation, setLocalFollowAutomation] = useState(true);
  const [commitsAutofillRequestId, setCommitsAutofillRequestId] = useState(null);
  const {
    currentProject,
    hasBranchNotification,
    hasGitNotification,
    workspaceChanges,
    previewPanelState,
    setPreviewPanelTab,
    requestEditorFocus,
    projectProcesses,
    refreshProcessStatus,
    restartProject,
    stopProjectProcess,
    createBackend,
    editorFocusRequest,
    reportBackendConnectivity,
    stoppedProjects
  } = useAppState();
  const previewRef = useRef(null);
  const pendingPreviewReloadRef = useRef(false);
  const [filesSaveControl, setFilesSaveControl] = useState({ handleSave: null, isDisabled: true });
  const [testActions, setTestActions] = useState(null);
  const [branchActions, setBranchActions] = useState(null);
  const [commitsActions, setCommitsActions] = useState(null);
  const pendingTestRunRef = useRef(null);
  const activeTab = previewPanelState?.activeTab || localActiveTab;
  const validTabsRef = useRef(new Set([
    'preview',
    'goals',
    'files',
    'assets',
    'test',
    'branch',
    'commits',
    'git',
    'processes',
    'packages',
    'llm-usage'
  ]));
  const safeActiveTab = validTabsRef.current.has(activeTab) ? activeTab : 'preview';
  const followAutomation =
    typeof previewPanelState?.followAutomation === 'boolean'
      ? previewPanelState.followAutomation
      : localFollowAutomation;
  const commitsAutofillContextRef = useRef({ tab: safeActiveTab, projectId: currentProject?.id ?? null });
  const followAutomationRef = useRef(Boolean(followAutomation));
  const activeTabRef = useRef(safeActiveTab);
  const branchActionsRef = useRef(branchActions);
  const testActionsRef = useRef(testActions);
  const projectIdRef = useRef(currentProject?.id ?? null);
  const lastAutomationFocusedPathRef = useRef('');

  const getLatestStagedFilePath = useCallback(() => {
    const stagedFiles = workspaceChanges?.[currentProject?.id]?.stagedFiles;
    if (!Array.isArray(stagedFiles) || stagedFiles.length === 0) {
      return '';
    }

    const lastEntry = stagedFiles[stagedFiles.length - 1];
    const path = typeof lastEntry?.path === 'string' ? lastEntry.path.trim() : '';
    return path;
  }, [currentProject?.id, workspaceChanges]);

  const focusLatestStagedFile = useCallback(({ source = 'agent' } = {}) => {
    const projectId = currentProject?.id;
    if (!projectId || typeof requestEditorFocus !== 'function') {
      return;
    }

    const latestPath = getLatestStagedFilePath();
    if (!latestPath || latestPath === lastAutomationFocusedPathRef.current) {
      return;
    }

    lastAutomationFocusedPathRef.current = latestPath;
    const highlight = source === 'branches' || source === 'commits' ? 'diff' : 'editor';
    requestEditorFocus(projectId, latestPath, { source, highlight });
  }, [currentProject?.id, requestEditorFocus, getLatestStagedFilePath]);

  const setActiveTab = useCallback(
    (tab, options = {}) => {
      const source = typeof options.source === 'string' ? options.source : 'unknown';

      if (typeof setPreviewPanelTab === 'function') {
        setPreviewPanelTab(tab, options);
        return;
      }

      if (source === 'user' && tab === 'goals') {
        setLocalFollowAutomation(false);
      }
      if (source === 'automation' || source === 'agent') {
        setLocalFollowAutomation(true);
      }

      setLocalActiveTab(tab);
    },
    [setPreviewPanelTab]
  );

  useEffect(() => {
    followAutomationRef.current = Boolean(followAutomation);
  }, [followAutomation]);

  useEffect(() => {
    if (!validTabsRef.current.has(activeTab)) {
      setActiveTab('preview', { source: 'system' });
      return;
    }
    activeTabRef.current = activeTab;
  }, [activeTab, setActiveTab]);

  useEffect(() => {
    branchActionsRef.current = branchActions;
  }, [branchActions]);

  useEffect(() => {
    testActionsRef.current = testActions;
  }, [testActions]);

  useEffect(() => {
    projectIdRef.current = currentProject?.id ?? null;
  }, [currentProject?.id]);

  useEffect(() => {
    const projectId = currentProject?.id ?? null;
    const previousContext = commitsAutofillContextRef.current;
    const shouldRequestAutofill = safeActiveTab === 'commits'
      && (previousContext.tab !== 'commits' || previousContext.projectId !== projectId);

    commitsAutofillContextRef.current = { tab: safeActiveTab, projectId };

    if (shouldRequestAutofill) {
      setCommitsAutofillRequestId((current) => (typeof current === 'number' ? current + 1 : 1));
    }
  }, [safeActiveTab, currentProject?.id]);

  useEffect(() => {
    if (PreviewPanel.__testHooks) {
      PreviewPanel.__testHooks.setActiveTab = (nextTab, nextOptions) => {
        if (nextOptions && typeof nextOptions === 'object') {
          setActiveTab(nextTab, nextOptions);
          return;
        }

        setActiveTab(nextTab, { source: 'automation' });
      };

      PreviewPanel.__testHooks.focusLatestStagedFile = (options) => {
        focusLatestStagedFile(options);
      };
    }
    return () => {
      if (PreviewPanel.__testHooks) {
        PreviewPanel.__testHooks.setActiveTab = undefined;
        PreviewPanel.__testHooks.focusLatestStagedFile = undefined;
      }
    };
  }, [setActiveTab, focusLatestStagedFile]);

  const isPreviewActive = safeActiveTab === 'preview';
  const isGoalsActive = safeActiveTab === 'goals';
  const isFilesActive = safeActiveTab === 'files';
  const isAssetsActive = safeActiveTab === 'assets';
  const isTestActive = safeActiveTab === 'test';
  const isBranchActive = safeActiveTab === 'branch';
  const isCommitsActive = safeActiveTab === 'commits';
  const isPackagesActive = safeActiveTab === 'packages';

  const handleRegisterFilesSave = useCallback((payload) => {
    if (payload) {
      setFilesSaveControl(payload);
    } else {
      setFilesSaveControl({ handleSave: null, isDisabled: true });
    }

    return () => setFilesSaveControl({ handleSave: null, isDisabled: true });
  }, []);

  const handleRegisterTestActions = useCallback((payload) => {
    if (payload) {
      setTestActions(payload);
    } else {
      setTestActions(null);
    }

    return () => setTestActions(null);
  }, []);

  const handleRegisterBranchActions = useCallback((payload) => {
    if (payload) {
      setBranchActions(payload);
    } else {
      setBranchActions(null);
    }

    return () => setBranchActions(null);
  }, []);

  const handleRegisterCommitsActions = useCallback((payload) => {
    if (payload) {
      setCommitsActions(payload);
    } else {
      setCommitsActions(null);
    }

    return () => setCommitsActions(null);
  }, []);

  useEffect(() => {
    if (isPreviewActive && pendingPreviewReloadRef.current && previewRef.current?.reloadPreview) {
      pendingPreviewReloadRef.current = false;
      previewRef.current.reloadPreview();
    }
  }, [isPreviewActive]);

  useEffect(() => {
    if (!editorFocusRequest || editorFocusRequest.projectId !== currentProject?.id) {
      return;
    }
    if (activeTab !== 'files') {
      setActiveTab('files', { source: 'automation' });
    }
  }, [editorFocusRequest, currentProject?.id, activeTab, setActiveTab]);

  const handleFileSaved = useCallback(() => {
    if (previewRef.current?.reloadPreview) {
      previewRef.current.reloadPreview();
      pendingPreviewReloadRef.current = false;
    } else {
      pendingPreviewReloadRef.current = true;
    }
  }, []);
  const handleReload = useCallback(() => {
    if (!isPreviewActive || !previewRef.current) {
      return;
    }
    previewRef.current.reloadPreview();
  }, [isPreviewActive]);

  useEffect(() => {
    const projectId = currentProject?.id;
    if (!projectId || typeof window === 'undefined') {
      return;
    }

    const stop = startAgentUiBridge({
      projectId,
      onBackendStatusChange: (status, error) => {
        if (typeof reportBackendConnectivity !== 'function') {
          return;
        }
        if (status === 'online') {
          reportBackendConnectivity('online');
          return;
        }
        if (status === 'offline') {
          reportBackendConnectivity('offline', error);
        }
      },
      getSnapshot: () => {
        const availableBranchActions = branchActionsRef.current
          ? Object.keys(branchActionsRef.current)
          : [];
        const availableTestActions = testActionsRef.current
          ? Object.keys(testActionsRef.current).filter((key) => typeof testActionsRef.current[key] === 'function')
          : [];

        return {
          activeTab: activeTabRef.current,
          hasBranchNotification: Boolean(hasBranchNotification),
          availableBranchActions,
          availableTestActions
        };
      },
      executeCommand: (command) => {
        if (!followAutomationRef.current) {
          return;
        }

        const commandType = command?.type;
        const payload = command?.payload || {};

        const normalizeTab = (value) => {
          if (typeof value !== 'string') {
            return '';
          }
          const trimmed = value.trim();
          if (!trimmed) {
            return '';
          }
          const lower = trimmed.toLowerCase();

          const tabAliases = {
            tests: 'test',
            branches: 'branch',
            'llm usage': 'llm-usage',
            llmusage: 'llm-usage'
          };

          return tabAliases[lower] || lower;
        };

        if (commandType === 'NAVIGATE_TAB') {
          const tab = normalizeTab(payload?.tab);
          if (tab) {
            setActiveTab(tab, { source: 'agent' });
            if (tab === 'files') {
              focusLatestStagedFile({ source: 'agent' });
            }
          }
          return;
        }

        if (commandType === 'OPEN_FILE') {
          const filePath = payload?.filePath;
          const currentId = projectIdRef.current;
          if (currentId && requestEditorFocus && typeof filePath === 'string' && filePath.trim()) {
            requestEditorFocus(currentId, filePath.trim(), { source: 'agent', highlight: 'editor' });
            setActiveTab('files', { source: 'agent' });
          }
          return;
        }

        if (commandType === 'BRANCH_TOOLBAR_ACTION') {
          const actionName = payload?.action;
          if (typeof actionName !== 'string') {
            return;
          }
          const action = branchActionsRef.current?.[actionName];
          if (action?.onClick) {
            action.onClick();
          }
          return;
        }

        if (commandType === 'TEST_ACTION') {
          const actionName = payload?.action;
          if (typeof actionName !== 'string') {
            return;
          }
          const action = testActionsRef.current?.[actionName];
          if (typeof action === 'function') {
            action();
          }
          return;
        }

        if (commandType === 'PREVIEW_RELOAD') {
          handleReload();
        }
      }
    });

    return () => {
      stop();
    };
  }, [currentProject?.id, hasBranchNotification, requestEditorFocus, handleReload, reportBackendConnectivity]);

  useEffect(() => {
    if (!currentProject?.id) {
      return;
    }

    if (activeTab !== 'files') {
      return;
    }

    if (!followAutomation) {
      return;
    }

    focusLatestStagedFile({ source: 'automation' });
  }, [workspaceChanges, activeTab, followAutomation, currentProject?.id, focusLatestStagedFile]);

  const handleOpenInNewTab = useCallback(() => {
    if (!isPreviewActive || !previewRef.current || !currentProject) {
      return;
    }

    const targetUrl =
      previewRef.current.getDisplayedUrl?.() ||
      previewRef.current.getPreviewUrl?.();

    const currentHostname = typeof window !== 'undefined' ? window.location?.hostname : '';
    const shouldPreferProxyTarget = !isLoopbackHostname(currentHostname);

    if (shouldPreferProxyTarget && targetUrl && targetUrl !== 'about:blank') {
      window.open(targetUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    const directUrl = previewRef.current.getOpenInNewTabUrl?.();
    if (directUrl && directUrl !== 'about:blank') {
      window.open(directUrl, '_blank', 'noopener,noreferrer');
      return;
    }

    if (!targetUrl || targetUrl === 'about:blank') {
      return;
    }

    window.open(targetUrl, '_blank', 'noopener,noreferrer');
  }, [isPreviewActive, currentProject]);

  const handleBranchFileOpen = useCallback(
    (filePath) => {
      if (!currentProject || !filePath) {
        return;
      }

      requestEditorFocus?.(currentProject.id, filePath, { source: 'branches' });
      setActiveTab('files', { source: 'user' });
    },
    [currentProject, requestEditorFocus, setActiveTab]
  );

  const handleShowTestsTab = useCallback(() => {
    setActiveTab('test', { source: 'user' });
  }, [setActiveTab]);

  const runPendingTests = useCallback(() => {
    if (!pendingTestRunRef.current || activeTabRef.current !== 'test') {
      return;
    }

    const runAllTests = testActionsRef.current?.runAllTests;
    if (typeof runAllTests !== 'function') {
      return;
    }

    const options = pendingTestRunRef.current;
    pendingTestRunRef.current = null;
    runAllTests(options);
  }, []);

  const handleShowTestsTabAndRun = useCallback((options = {}) => {
    const shouldAutoRun = Boolean(options?.autoRun);
    if (shouldAutoRun) {
      pendingTestRunRef.current = {
        source: typeof options?.source === 'string' ? options.source : 'automation',
        autoCommit: Boolean(options?.autoCommit),
        returnToCommits: Boolean(options?.returnToCommits)
      };
    }

    setActiveTab('test', { source: 'user' });
    runPendingTests();
  }, [runPendingTests, setActiveTab]);

  const handleShowCommitsTab = useCallback(() => {
    setActiveTab('commits', { source: 'user' });
  }, [setActiveTab]);

  useEffect(() => {
    runPendingTests();
  }, [testActions, runPendingTests]);

  useEffect(() => {
    if (activeTab !== 'test') {
      return;
    }
    runPendingTests();
  }, [activeTab, runPendingTests]);

  useEffect(() => {
    if (!PreviewPanel.__testHooks) {
      return;
    }
    PreviewPanel.__testHooks.handleReload = handleReload;
    PreviewPanel.__testHooks.handleOpenInNewTab = handleOpenInNewTab;
    PreviewPanel.__testHooks.handleFileSaved = handleFileSaved;
    return () => {
      if (PreviewPanel.__testHooks) {
        PreviewPanel.__testHooks.handleReload = undefined;
        PreviewPanel.__testHooks.handleOpenInNewTab = undefined;
        PreviewPanel.__testHooks.handleFileSaved = undefined;
      }
    };
  }, [handleReload, handleOpenInNewTab, handleFileSaved]);

  const renderBranchActionButton = (action, fallbackTestId) => {
    if (!action) {
      return null;
    }

    const variantClass = action.variant ? ` ${action.variant}` : '';
    return (
      <button
        type="button"
        className={`preview-action-button${variantClass}`}
        onClick={action.onClick}
        disabled={!currentProject || action.disabled}
        data-testid={action.testId || fallbackTestId}
      >
        {action.label}
      </button>
    );
  };

  const renderNonGoalsTab = () => {
    switch (activeTab) {
      case 'files':
        return (
          <FilesTab
            project={currentProject}
            registerSaveHandler={handleRegisterFilesSave}
            showInlineSaveButton={false}
            onFileSaved={handleFileSaved}
          />
        );
      case 'assets':
        return <AssetsTab project={currentProject} />;
      case 'test':
        return (
          <TestTab
            project={currentProject}
            registerTestActions={handleRegisterTestActions}
            onRequestCommitsTab={handleShowCommitsTab}
          />
        );
      case 'branch':
        return (
          <BranchTab
            project={currentProject}
            onRequestFileOpen={handleBranchFileOpen}
            onRequestTestsTab={handleShowTestsTab}
            onRequestCommitsTab={handleShowCommitsTab}
            registerBranchActions={handleRegisterBranchActions}
          />
        );
      case 'commits':
        return (
          <CommitsTab
            project={currentProject}
            autofillRequestId={commitsAutofillRequestId}
            onConsumeAutofillRequest={() => setCommitsAutofillRequestId(null)}
            onRequestTestsTab={handleShowTestsTabAndRun}
            registerCommitsActions={handleRegisterCommitsActions}
          />
        );
      case 'git':
        return <GitTab />;
      case 'packages':
        return <PackageTab project={currentProject} />;
      case 'processes':
        return (
          <ProcessesTab
            project={currentProject}
            processInfo={projectProcesses}
            onRefreshStatus={refreshProcessStatus}
            onRestartProject={restartProject}
            onStopProject={stopProjectProcess}
            onCreateBackend={createBackend}
          />
        );
      case 'llm-usage':
        return <LLMUsageTab project={currentProject} />;
    }
  };

  return (
    <div className="preview-panel" data-testid="preview-panel">
      <div className="preview-header">
        <div className="preview-tabs">
          <button
            data-testid="preview-tab"
            className={`tab ${activeTab === 'preview' ? 'active' : ''}`}
            onClick={() => setActiveTab('preview', { source: 'user' })}
          >
            Preview
          </button>
          <button
            data-testid="goals-tab"
            className={`tab ${activeTab === 'goals' ? 'active' : ''}`}
            onClick={() => setActiveTab('goals', { source: 'user' })}
          >
            Goals
          </button>
          <button
            data-testid="branch-tab"
            className={`tab ${activeTab === 'branch' ? 'active' : ''} ${hasBranchNotification ? 'with-indicator' : ''}`.trim()}
            onClick={() => setActiveTab('branch', { source: 'user' })}
          >
            Branches
            {hasBranchNotification && (
              <span
                className="tab-indicator"
                data-testid="branch-spot-indicator"
                aria-label="Branch has pending commits"
              />
            )}
          </button>
          <button
            data-testid="files-tab"
            className={`tab ${activeTab === 'files' ? 'active' : ''}`}
            onClick={() => setActiveTab('files', { source: 'user' })}
          >
            Files
          </button>
          <button
            data-testid="assets-tab"
            className={`tab ${activeTab === 'assets' ? 'active' : ''}`}
            onClick={() => setActiveTab('assets', { source: 'user' })}
          >
            Assets
          </button>
          <button
            data-testid="test-tab"
            className={`tab ${activeTab === 'test' ? 'active' : ''}`}
            onClick={() => setActiveTab('test', { source: 'user' })}
          >
            Test
          </button>
          <button
            data-testid="commits-tab"
            className={`tab ${activeTab === 'commits' ? 'active' : ''}`}
            onClick={() => setActiveTab('commits', { source: 'user' })}
          >
            Commits
          </button>
          <button
            data-testid="git-tab"
            className={`tab ${activeTab === 'git' ? 'active' : ''} ${hasGitNotification ? 'with-indicator' : ''}`.trim()}
            onClick={() => setActiveTab('git', { source: 'user' })}
          >
            Git
            {hasGitNotification && (
              <span
                className="tab-indicator"
                data-testid="git-spot-indicator"
                aria-label="Git tab requires pull"
              />
            )}
          </button>
          <button
            data-testid="packages-tab"
            className={`tab ${activeTab === 'packages' ? 'active' : ''}`}
            onClick={() => setActiveTab('packages', { source: 'user' })}
          >
            Packages
          </button>
          <button
            data-testid="processes-tab"
            className={`tab ${activeTab === 'processes' ? 'active' : ''}`}
            onClick={() => setActiveTab('processes', { source: 'user' })}
          >
            Processes
          </button>
        </div>

        <div className="preview-actions">
          {isFilesActive && (
            <button
              type="button"
              className="preview-action-button"
              onClick={() => filesSaveControl.handleSave?.()}
              disabled={filesSaveControl.isDisabled}
              data-testid="files-save-button"
            >
              Save
            </button>
          )}
          {isAssetsActive && null}
          {isTestActive && (
            <>
            </>
          )}
          {isBranchActive && (
            <>
              {renderBranchActionButton(branchActions?.createBranch, 'branch-create')}
            </>
          )}
          {isCommitsActive && (
            <button
              type="button"
              className="preview-action-button"
              onClick={() => commitsActions?.refreshCommits?.()}
              disabled={!currentProject || commitsActions?.isDisabled}
              data-testid="commits-refresh"
            >
              Refresh
            </button>
          )}
        </div>
      </div>
      
      <div className="tab-content">
        <div className={`tab-pane ${isPreviewActive ? 'is-active' : 'is-hidden'}`}>
          <PreviewTab
            ref={previewRef}
            project={currentProject}
            processInfo={projectProcesses}
            onRestartProject={restartProject}
            onRefreshProcessStatus={refreshProcessStatus}
            isProjectStopped={Boolean(currentProject?.id && stoppedProjects?.[currentProject.id])}
            onReloadPreview={handleReload}
            onOpenInNewTab={handleOpenInNewTab}
          />
        </div>
        <div className={`tab-pane ${isGoalsActive ? 'is-active' : 'is-hidden'}`}>
          <GoalsTab />
        </div>
        {!isPreviewActive && !isGoalsActive && (
          <div className="tab-pane is-active">
            {renderNonGoalsTab()}
          </div>
        )}
      </div>
    </div>
  );
};

export default PreviewPanel;