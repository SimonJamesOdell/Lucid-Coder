export const generateBranchName = () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `feature/autosave-${timestamp}`;
};

export const registerBranchActivity = ({ projectId, updater, setWorkingBranches }) => {
  if (!projectId) {
    return;
  }

  setWorkingBranches((prev) => {
    const existing = prev[projectId] || {
      name: generateBranchName(),
      createdAt: new Date().toISOString(),
      commits: 0,
      merged: false
    };
    const updated = {
      ...existing,
      ...updater(existing)
    };
    return {
      ...prev,
      [projectId]: updated
    };
  });
};

export const applyBranchOverview = ({ projectId, overview, setWorkingBranches, setWorkspaceChanges }) => {
  if (!projectId) {
    return;
  }

  const workingBranchList = Array.isArray(overview?.workingBranches) ? overview.workingBranches : [];
  const currentBranchName = typeof overview?.current === 'string' ? overview.current.trim() : '';
  const workingBranch = currentBranchName && currentBranchName !== 'main'
    ? (workingBranchList.find((branch) => branch?.name === currentBranchName) || null)
    : (workingBranchList[0] || null);

  if (workingBranch) {
    const stagedFiles = workingBranch.stagedFiles || [];
    const lastTestSummary = workingBranch?.lastTestSummary && typeof workingBranch.lastTestSummary === 'object'
      ? workingBranch.lastTestSummary
      : null;
    const mergeBlockedReason = typeof workingBranch?.mergeBlockedReason === 'string'
      ? workingBranch.mergeBlockedReason
      : null;
    const lastTestCompletedAt = typeof workingBranch?.lastTestCompletedAt === 'string'
      ? workingBranch.lastTestCompletedAt
      : null;

    setWorkingBranches((prev) => ({
      ...prev,
      [projectId]: {
        name: workingBranch.name,
        status: workingBranch.status,
        merged: workingBranch.status === 'merged',
        commits: stagedFiles.length,
        stagedFiles,
        lastTestStatus: workingBranch.lastTestStatus || null,
        testsRequired: Boolean(workingBranch.testsRequired),
        mergeBlockedReason,
        lastTestCompletedAt,
        lastTestSummary
      }
    }));

    setWorkspaceChanges((prev) => ({
      ...prev,
      [projectId]: {
        stagedFiles
      }
    }));
    return;
  }

  setWorkingBranches((prev) => {
    if (!prev[projectId]) {
      return prev;
    }
    const next = { ...prev };
    delete next[projectId];
    return next;
  });

  setWorkspaceChanges((prev) => {
    if (!prev[projectId]) {
      return prev;
    }
    return {
      ...prev,
      [projectId]: {
        stagedFiles: []
      }
    };
  });
};

export const applyLocalStageFallback = ({
  projectId,
  filePath,
  source,
  normalizeRepoPath,
  registerBranchActivity,
  setWorkspaceChanges
}) => {
  const normalizedPath = normalizeRepoPath(filePath);
  const timestamp = new Date().toISOString();

  registerBranchActivity(projectId, (existing) => ({
    commits: (existing.commits || 0) + 1,
    merged: false,
    lastActivity: timestamp
  }));

  setWorkspaceChanges((prev) => {
    const projectChanges = prev[projectId]?.stagedFiles || [];
    const filtered = projectChanges.filter((file) => normalizeRepoPath(file.path) !== normalizedPath);
    const nextFiles = [
      ...filtered,
      {
        path: normalizedPath,
        source,
        timestamp
      }
    ];

    return {
      ...prev,
      [projectId]: {
        stagedFiles: nextFiles
      }
    };
  });
};

export const stageFileChange = async ({
  projectId,
  filePath,
  source = 'editor',
  trackedFetch,
  normalizeRepoPath,
  applyBranchOverview,
  applyLocalStageFallback
}) => {
  if (!projectId || !filePath) {
    return null;
  }

  const normalizedPath = normalizeRepoPath(filePath);

  try {
    const response = await trackedFetch(`/api/projects/${projectId}/branches/stage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filePath: normalizedPath, source })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data?.error || 'Failed to stage file change');
    }

    applyBranchOverview(projectId, data.overview);
    return data;
  } catch (error) {
    console.warn('Failed to sync staged change with backend', error);
    applyLocalStageFallback(projectId, normalizedPath, source);
    return null;
  }
};

export const clearStagedChanges = async ({
  projectId,
  options = {},
  trackedFetch,
  normalizeRepoPath,
  workingBranches,
  setWorkspaceChanges,
  setWorkingBranches,
  setProjectFilesRevision,
  applyBranchOverview
}) => {
  if (!projectId) {
    return;
  }

  const normalizedPath = options.filePath ? normalizeRepoPath(options.filePath) : '';

  const payload = {};
  if (options.branchName) {
    payload.branchName = options.branchName;
  }
  if (normalizedPath) {
    payload.filePath = normalizedPath;
  }

  const hasBody = Object.keys(payload).length > 0;

  const trackedBranchName = workingBranches?.[projectId]?.name;
  const shouldPruneLocalWorkspace = !options.branchName
    || (trackedBranchName && options.branchName === trackedBranchName);

  const bumpProjectFilesRevision = () => {
    if (!shouldPruneLocalWorkspace) {
      return;
    }

    setProjectFilesRevision((prev) => {
      const current = Number(prev?.[projectId] || 0);
      return {
        ...prev,
        [projectId]: current + 1
      };
    });
  };

  const pruneLocalStaged = () => {
    if (!shouldPruneLocalWorkspace) {
      return;
    }

    setWorkspaceChanges((prev) => {
      if (!prev[projectId]) {
        return prev;
      }
      const existing = Array.isArray(prev[projectId].stagedFiles) ? prev[projectId].stagedFiles : [];
      const nextFiles = normalizedPath
        ? existing.filter((entry) => normalizeRepoPath(entry.path) !== normalizedPath)
        : [];
      return {
        ...prev,
        [projectId]: {
          ...prev[projectId],
          stagedFiles: nextFiles
        }
      };
    });

    setWorkingBranches((prev) => {
      if (!prev[projectId]) {
        return prev;
      }
      const existingFiles = Array.isArray(prev[projectId].stagedFiles) ? prev[projectId].stagedFiles : [];
      const nextFiles = normalizedPath
        ? existingFiles.filter((entry) => normalizeRepoPath(entry.path) !== normalizedPath)
        : [];
      return {
        ...prev,
        [projectId]: {
          ...prev[projectId],
          commits: nextFiles.length,
          stagedFiles: nextFiles,
          merged: prev[projectId].merged || false
        }
      };
    });
  };

  pruneLocalStaged();

  try {
    const response = await trackedFetch(`/api/projects/${projectId}/branches/stage`, {
      method: 'DELETE',
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(payload) : undefined
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      throw new Error(data?.error || 'Failed to clear staged changes');
    }
    applyBranchOverview(projectId, data.overview);
    bumpProjectFilesRevision();
    pruneLocalStaged();
    return data;
  } catch (error) {
    console.warn('Falling back to clearing staged files locally', error);
    pruneLocalStaged();
    return null;
  }
};

export const stageAiChange = async ({ projectId, prompt, detectFileTokens, stageFileChange }) => {
  if (!projectId || !prompt) {
    return;
  }

  const files = detectFileTokens(prompt);
  if (files.length === 0) {
    const fallback = `notes/ai-request-${Date.now()}.md`;
    await stageFileChange(projectId, fallback, 'ai');
    return;
  }

  for (const filePath of files) {
    await stageFileChange(projectId, filePath, 'ai');
  }
};
