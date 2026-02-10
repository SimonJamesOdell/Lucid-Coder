import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import axios from 'axios';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { useAppState } from '../context/AppStateContext';
import './FilesTab.css';
import FileTreeView from './filesTab/FileTreeView';
import { buildChildPath, buildSiblingPath, suggestDuplicateName } from './filesTab/filesTabUtils';

const DEFAULT_EXPANDED_FOLDERS = ['src', 'public'];
const DEFAULT_EXPLORER_WIDTH = 260;
const MIN_EXPLORER_WIDTH = 180;
const MAX_EXPLORER_WIDTH = 520;

const FilesTab = ({
  project,
  registerSaveHandler,
  showInlineSaveButton = true,
  onFileSaved = null,
  __testHooks = null
}) => {
  const {
    theme = 'dark',
    stageFileChange,
    workspaceChanges,
    projectFilesRevision,
    projectShutdownState,
    isProjectStopping,
    getFileExplorerState,
    setFileExplorerState,
    editorFocusRequest,
    clearEditorFocusRequest
  } = useAppState();
  const projectId = project?.id;
  const projectPath = typeof project?.path === 'string' ? project.path.trim() : '';
  const getFileExplorerStateRef = useRef(getFileExplorerState);
  const initialExplorerState = projectId ? getFileExplorerState?.(projectId) : null;
  const [fileTree, setFileTree] = useState([]);
  const [explorerWidth, setExplorerWidth] = useState(() => (
    Number.isFinite(initialExplorerState?.explorerWidth)
      ? initialExplorerState.explorerWidth
      : DEFAULT_EXPLORER_WIDTH
  ));
  const [expandedFolders, setExpandedFolders] = useState(() =>
    new Set(
      initialExplorerState?.expandedFolders?.length
        ? initialExplorerState.expandedFolders
        : DEFAULT_EXPANDED_FOLDERS
    )
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [openFiles, setOpenFiles] = useState([]);
  const [fileStates, setFileStates] = useState({});
  const [activeFilePath, setActiveFilePath] = useState('');
  const [saveStatus, setSaveStatus] = useState('');
  const [diffModeByPath, setDiffModeByPath] = useState({});
  const [diffStates, setDiffStates] = useState({});
  const [contextMenu, setContextMenu] = useState({
    isOpen: false,
    x: 0,
    y: 0,
    target: null
  });
  const saveHandlerRef = useRef(null);
  const handleFileSelectRef = useRef(null);
  const lastRevisionRefreshProjectIdRef = useRef(null);
  const fileStatesRef = useRef(fileStates);
  const activeFilePathRef = useRef(activeFilePath);
  const expandedFoldersRef = useRef(expandedFolders);
  const diffModeByPathRef = useRef(diffModeByPath);
  const diffStatesRef = useRef(diffStates);
  const saveStatusTimeoutRef = useRef(null);
  const filesTabRef = useRef(null);
  const explorerWidthRef = useRef(explorerWidth);
  const dragStateRef = useRef(null);
  const [isResizingExplorer, setIsResizingExplorer] = useState(false);
  const shuttingDown = isProjectStopping?.(projectId) ?? Boolean(
    projectShutdownState?.isStopping && projectShutdownState?.projectId === projectId
  );

  const scheduleClearSaveStatus = useCallback(() => {
    clearTimeout(saveStatusTimeoutRef.current);
    saveStatusTimeoutRef.current = setTimeout(() => setSaveStatus(''), 3000);
  }, []);

  useEffect(() => () => {
    clearTimeout(saveStatusTimeoutRef.current);
  }, []);

  const activeFileMeta = useMemo(
    () => openFiles.find((file) => file.path === activeFilePath) || null,
    [openFiles, activeFilePath]
  );

  const activeFileState = activeFilePath ? fileStates[activeFilePath] : null;
  const hasUnsavedChanges = Boolean(
    activeFileState && activeFileState.content !== activeFileState.originalContent
  );
  const isLoadingActiveFile = Boolean(activeFileState?.isLoading);
  const isDiffModeActive = Boolean(activeFilePath && diffModeByPath[activeFilePath]);
  const activeDiffState = activeFilePath ? diffStates[activeFilePath] : null;

  const stagedPathSet = useMemo(() => {
    const stagedFiles = workspaceChanges?.[projectId]?.stagedFiles;
    if (!Array.isArray(stagedFiles) || stagedFiles.length === 0) {
      return new Set();
    }
    return new Set(
      stagedFiles
        .map((entry) => (typeof entry?.path === 'string' ? entry.path : ''))
        .filter(Boolean)
    );
  }, [workspaceChanges, projectId]);

  useEffect(() => {
    fileStatesRef.current = fileStates;
  }, [fileStates]);

  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
  }, [activeFilePath]);

  useEffect(() => {
    expandedFoldersRef.current = expandedFolders;
  }, [expandedFolders]);

  useEffect(() => {
    explorerWidthRef.current = explorerWidth;
  }, [explorerWidth]);

  useEffect(() => {
    diffModeByPathRef.current = diffModeByPath;
  }, [diffModeByPath]);

  useEffect(() => {
    diffStatesRef.current = diffStates;
  }, [diffStates]);

  useEffect(() => {
    getFileExplorerStateRef.current = getFileExplorerState;
  }, [getFileExplorerState]);

  useEffect(() => {
    if (contextMenu.isOpen) {
      const handleClose = () => setContextMenu((prev) => ({ ...prev, isOpen: false, target: null }));
      const handleKeyDown = (event) => {
        if (event.key === 'Escape') {
          handleClose();
        }
      };

      window.addEventListener('mousedown', handleClose);
      window.addEventListener('keydown', handleKeyDown);
      return () => {
        window.removeEventListener('mousedown', handleClose);
        window.removeEventListener('keydown', handleKeyDown);
      };
    }

    return undefined;
  }, [contextMenu.isOpen]);

  const refreshFileTree = useCallback(async () => {
    if (!projectId) {
      setFileTree([]);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await axios.get(`/api/projects/${projectId}/files`);

      if (response.data.success) {
        const files = Array.isArray(response.data.files) ? response.data.files : [];
        setFileTree(files);
      } else {
        setError(response.data.error || 'Failed to load files');
        setFileTree([]);
      }
    } catch (err) {
      console.error('Error fetching project files:', err);
      setError(err.response?.data?.error || 'Failed to load project files');
      setFileTree([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    refreshFileTree();
  }, [refreshFileTree]);

  const projectFilesRevisionValue = projectId ? (projectFilesRevision?.[projectId] || 0) : 0;

  useEffect(() => {
    if (lastRevisionRefreshProjectIdRef.current !== projectId) {
      lastRevisionRefreshProjectIdRef.current = projectId;
      return;
    }
    if (shuttingDown) {
      return;
    }
    refreshFileTree();
  }, [projectFilesRevisionValue, refreshFileTree, shuttingDown]);

  useEffect(() => {
    setOpenFiles([]);
    setFileStates({});
    setActiveFilePath('');
    setDiffModeByPath({});
    setDiffStates({});
    setContextMenu({ isOpen: false, x: 0, y: 0, target: null });

    const storedState = projectId ? getFileExplorerStateRef.current?.(projectId) : null;
    setExpandedFolders(
      new Set(
        storedState?.expandedFolders?.length ? storedState.expandedFolders : DEFAULT_EXPANDED_FOLDERS
      )
    );
    setExplorerWidth(
      Number.isFinite(storedState?.explorerWidth)
        ? storedState.explorerWidth
        : DEFAULT_EXPLORER_WIDTH
    );
  }, [projectId]);

  useEffect(() => {
    setSaveStatus('');
  }, [activeFilePath]);

  const toggleFolder = (folderPath) => {
    const nextExpanded = new Set(expandedFolders);
    if (nextExpanded.has(folderPath)) {
      nextExpanded.delete(folderPath);
    } else {
      nextExpanded.add(folderPath);
    }

    setExpandedFolders(nextExpanded);

    if (projectId && setFileExplorerState) {
      setFileExplorerState(projectId, {
        expandedFolders: Array.from(nextExpanded)
      });
    }
  };

  const clampExplorerWidth = useCallback((value) => {
    if (!Number.isFinite(value)) {
      return DEFAULT_EXPLORER_WIDTH;
    }
    return Math.min(Math.max(value, MIN_EXPLORER_WIDTH), MAX_EXPLORER_WIDTH);
  }, []);

  const handleDividerMouseDown = useCallback((event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragStateRef.current = {
      startX: event.clientX,
      startWidth: explorerWidthRef.current
    };
    setIsResizingExplorer(true);
  }, []);

  useEffect(() => {
    if (!isResizingExplorer) {
      return undefined;
    }

    const handleMouseMove = (event) => {
      if (!dragStateRef.current) {
        return;
      }
      const delta = event.clientX - dragStateRef.current.startX;
      const nextWidth = clampExplorerWidth(dragStateRef.current.startWidth + delta);
      setExplorerWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setIsResizingExplorer(false);
      dragStateRef.current = null;
      if (projectId && setFileExplorerState) {
        setFileExplorerState(projectId, {
          expandedFolders: Array.from(expandedFoldersRef.current),
          explorerWidth: explorerWidthRef.current
        });
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [clampExplorerWidth, isResizingExplorer, projectId, setFileExplorerState]);

  const ensureTabForFile = (file) => {
    setOpenFiles((prev) => {
      if (prev.some((entry) => entry.path === file.path)) {
        return prev;
      }
      return [...prev, { path: file.path, name: file.name }];
    });
  };

  const loadDiffForFile = useCallback(async (filePath, options = {}) => {
    if (!projectId || !filePath) {
      return;
    }

    const commitSha = typeof options?.commitSha === 'string' && options.commitSha.trim()
      ? options.commitSha.trim()
      : null;

    setDiffStates((prev) => ({
      ...prev,
      [filePath]: {
        original: prev[filePath]?.original ?? '',
        modified: prev[filePath]?.modified ?? '',
        originalLabel: prev[filePath]?.originalLabel ?? null,
        modifiedLabel: prev[filePath]?.modifiedLabel ?? null,
        commitSha,
        isLoading: true,
        error: null
      }
    }));

    try {
      const endpoint = commitSha
        ? `/api/projects/${projectId}/commits/${encodeURIComponent(commitSha)}/files-diff-content/${filePath}`
        : `/api/projects/${projectId}/files-diff-content/${filePath}`;

      const response = await axios.get(endpoint, {
        headers: {
          'Cache-Control': 'no-cache'
        },
        params: {
          _ts: Date.now()
        }
      });
      const payload = response.data;
      if (payload?.success) {
        setDiffStates((prev) => ({
          ...prev,
          [filePath]: {
            original: typeof payload.original === 'string' ? payload.original : '',
            modified: typeof payload.modified === 'string' ? payload.modified : '',
            originalLabel: typeof payload.originalLabel === 'string' ? payload.originalLabel : null,
            modifiedLabel: typeof payload.modifiedLabel === 'string' ? payload.modifiedLabel : null,
            commitSha,
            isLoading: false,
            error: null
          }
        }));
      } else {
        setDiffStates((prev) => ({
          ...prev,
          [filePath]: {
            original: '',
            modified: '',
            originalLabel: null,
            modifiedLabel: null,
            commitSha,
            isLoading: false,
            error: payload?.error || 'Diff unavailable'
          }
        }));
      }
    } catch (err) {
      console.error('Error fetching file diff:', err);
      setDiffStates((prev) => ({
        ...prev,
        [filePath]: {
          original: '',
          modified: '',
          originalLabel: null,
          modifiedLabel: null,
          commitSha,
          isLoading: false,
          error: err.response?.data?.error || 'Diff unavailable'
        }
      }));
    }
  }, [projectId]);

  const handleFileSelect = async (file, options = {}) => {
    if (shuttingDown || !projectId || file.type === 'folder') {
      return;
    }

    const selectionSource = options?.source || 'explorer';
    const shouldOpenDiff = selectionSource === 'explorer-diff';

    if (selectionSource === 'explorer') {
      setDiffModeByPath((prev) => ({
        ...prev,
        [file.path]: false
      }));
    }

    if (shouldOpenDiff) {
      setDiffModeByPath((prev) => ({
        ...prev,
        [file.path]: true
      }));
    }

    ensureTabForFile(file);
    setActiveFilePath(file.path);

    if (shouldOpenDiff) {
      await loadDiffForFile(file.path);
    }

    const existingState = fileStates[file.path];
    if (existingState && !existingState.isLoading && existingState.content) {
      return;
    }

    setFileStates((prev) => ({
      ...prev,
      [file.path]: {
        content: prev[file.path]?.content ?? '',
        originalContent: prev[file.path]?.originalContent ?? '',
        isLoading: true
      }
    }));

    try {
      const response = await axios.get(`/api/projects/${projectId}/files/${file.path}`);

      if (response.data.success) {
        setFileStates((prev) => ({
          ...prev,
          [file.path]: {
            content: response.data.content,
            originalContent: response.data.content,
            isLoading: false
          }
        }));
      } else {
        const errorMsg = `// Error loading file: ${response.data.error}`;
        setFileStates((prev) => ({
          ...prev,
          [file.path]: {
            content: errorMsg,
            originalContent: errorMsg,
            isLoading: false
          }
        }));
      }
    } catch (err) {
      console.error('Error fetching file content:', err);
      const errorMsg = `// Error loading file: ${err.response?.data?.error || err.message}`;
      setFileStates((prev) => ({
        ...prev,
        [file.path]: {
          content: errorMsg,
          originalContent: errorMsg,
          isLoading: false
        }
      }));
    }
  };

  const handleTabSelect = (filePath) => {
    if (shuttingDown) {
      return;
    }
    setActiveFilePath(filePath);
  };

  const handleTabClose = (event, filePath) => {
    event.stopPropagation();

    setDiffModeByPath((prev) => {
      if (!prev || !Object.prototype.hasOwnProperty.call(prev, filePath)) {
        return prev;
      }
      const next = { ...prev };
      delete next[filePath];
      return next;
    });

    setDiffStates((prev) => {
      if (!prev || !Object.prototype.hasOwnProperty.call(prev, filePath)) {
        return prev;
      }
      const next = { ...prev };
      delete next[filePath];
      return next;
    });

    setOpenFiles((prev) => {
      const filtered = prev.filter((file) => file.path !== filePath);
      if (filePath === activeFilePath) {
        const closingIndex = prev.findIndex((file) => file.path === filePath);
        const fallback = filtered[closingIndex - 1] || filtered[closingIndex] || null;
        setActiveFilePath(fallback?.path || '');
      }
      return filtered;
    });
  };

  const handleToggleDiffMode = useCallback(async () => {
    if (!activeFilePath || shuttingDown) {
      return;
    }

    const nextValue = !diffModeByPath[activeFilePath];
    setDiffModeByPath((prev) => ({ ...prev, [activeFilePath]: nextValue }));

    if (nextValue) {
      await loadDiffForFile(activeFilePath, { commitSha: activeDiffState?.commitSha || null });
    }
  }, [activeFilePath, shuttingDown, diffModeByPath, loadDiffForFile, activeDiffState?.commitSha]);

  const closeTabsForPathPrefix = useCallback((prefix) => {
    if (!prefix) {
      return;
    }

    setOpenFiles((prev) => {
      const remaining = prev.filter((entry) => entry.path !== prefix && !entry.path.startsWith(`${prefix}/`));
      return remaining;
    });

    setFileStates((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((key) => {
        if (key === prefix || key.startsWith(`${prefix}/`)) {
          delete next[key];
        }
      });
      return next;
    });

    setDiffModeByPath((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((key) => {
        if (key === prefix || key.startsWith(`${prefix}/`)) {
          delete next[key];
        }
      });
      return next;
    });

    setDiffStates((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((key) => {
        if (key === prefix || key.startsWith(`${prefix}/`)) {
          delete next[key];
        }
      });
      return next;
    });

    setActiveFilePath((prev) => {
      if (!prev) {
        return prev;
      }
      if (prev === prefix || prev.startsWith(`${prefix}/`)) {
        return '';
      }
      return prev;
    });
  }, []);

  const renameOpenFileState = useCallback((fromPath, toPath) => {
    if (!fromPath || !toPath || fromPath === toPath) {
      return;
    }

    setOpenFiles((prev) => prev.map((entry) => {
      if (entry.path !== fromPath) {
        return entry;
      }
      return { ...entry, path: toPath, name: toPath.split('/').pop() || toPath };
    }));

    setFileStates((prev) => {
      if (!prev[fromPath]) {
        return prev;
      }
      const next = { ...prev };
      next[toPath] = next[fromPath];
      delete next[fromPath];
      return next;
    });

    setDiffModeByPath((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, fromPath)) {
        return prev;
      }
      const next = { ...prev };
      next[toPath] = next[fromPath];
      delete next[fromPath];
      return next;
    });

    setDiffStates((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, fromPath)) {
        return prev;
      }
      const next = { ...prev };
      next[toPath] = next[fromPath];
      delete next[fromPath];
      return next;
    });

    setActiveFilePath((prev) => (prev === fromPath ? toPath : prev));
  }, []);

  const openContextMenu = useCallback((event, target) => {
    if (shuttingDown) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    setContextMenu({
      isOpen: true,
      x: event.clientX,
      y: event.clientY,
      target
    });
  }, [shuttingDown]);

  const handleContextAction = useCallback(async (action) => {
    if (shuttingDown || !projectId) {
      return;
    }

    const target = contextMenu.target;
    if (!target) {
      return;
    }

    const closeMenu = () => setContextMenu((prev) => ({ ...prev, isOpen: false, target: null }));

    try {
      if (action === 'rename') {
        const proposed = window.prompt('Rename to:', target.name);
        if (!proposed) {
          closeMenu();
          return;
        }

        const toPath = buildSiblingPath(target.path, proposed);
        if (!toPath) {
          window.alert('Invalid name.');
          closeMenu();
          return;
        }

        const response = await axios.post(`/api/projects/${projectId}/files-ops/rename`, {
          fromPath: target.path,
          toPath
        });

        if (!response.data?.success) {
          throw new Error(response.data?.error || 'Failed to rename');
        }

        if (target.type === 'file') {
          renameOpenFileState(target.path, toPath);
        } else {
          // If a folder was renamed, close any open tabs under it to avoid stale paths.
          closeTabsForPathPrefix(target.path);
        }

        await refreshFileTree();

        await stageFileChange?.(projectId, target.path, 'explorer');
        await stageFileChange?.(projectId, toPath, 'explorer');
        closeMenu();
        return;
      }

      if (action === 'delete') {
        const label = target.type === 'folder' ? 'folder' : 'file';
        const ok = window.confirm(`Delete this ${label}?\n\n${target.path}`);
        if (!ok) {
          closeMenu();
          return;
        }

        const response = await axios.post(`/api/projects/${projectId}/files-ops/delete`, {
          targetPath: target.path,
          recursive: target.type === 'folder'
        });

        if (!response.data?.success) {
          throw new Error(response.data?.error || 'Failed to delete');
        }

        closeTabsForPathPrefix(target.path);
        await refreshFileTree();
        await stageFileChange?.(projectId, target.path, 'explorer');
        closeMenu();
        return;
      }

      if (action === 'duplicate') {
        if (target.type !== 'file') {
          window.alert('Only files can be duplicated.');
          closeMenu();
          return;
        }

        const suggested = suggestDuplicateName(target.name);
        const proposed = window.prompt('Duplicate as:', suggested);
        if (!proposed) {
          closeMenu();
          return;
        }

        const destinationPath = buildSiblingPath(target.path, proposed);
        if (!destinationPath) {
          window.alert('Invalid name.');
          closeMenu();
          return;
        }

        const response = await axios.post(`/api/projects/${projectId}/files-ops/duplicate`, {
          sourcePath: target.path,
          destinationPath
        });

        if (!response.data?.success) {
          throw new Error(response.data?.error || 'Failed to duplicate');
        }

        await refreshFileTree();
        await stageFileChange?.(projectId, destinationPath, 'explorer');
        closeMenu();
        return;
      }

      if (action === 'create-folder') {
        const baseDir = target.type === 'folder'
          ? target.path
          : (() => {
              const idx = target.path.lastIndexOf('/');
              return idx >= 0 ? target.path.slice(0, idx) : '';
            })();

        const folderName = window.prompt('New folder name:', 'NewFolder');
        if (!folderName) {
          closeMenu();
          return;
        }

        const normalizedName = folderName.trim().replace(/\\/g, '/');
        if (!normalizedName || normalizedName.includes('/') || normalizedName.includes('..')) {
          window.alert('Invalid folder name.');
          closeMenu();
          return;
        }

        const folderPath = baseDir ? `${baseDir}/${normalizedName}` : normalizedName;

        const response = await axios.post(`/api/projects/${projectId}/files-ops/mkdir`, {
          folderPath,
          track: true
        });

        if (!response.data?.success) {
          throw new Error(response.data?.error || 'Failed to create folder');
        }

        await refreshFileTree();

        const trackingPath = response.data.trackingPath;
        if (trackingPath) {
          await stageFileChange?.(projectId, trackingPath, 'explorer');
        }

        const nextExpanded = new Set(expandedFoldersRef.current);
        if (baseDir) {
          nextExpanded.add(baseDir);
        }
        nextExpanded.add(folderPath);
        setExpandedFolders(nextExpanded);
        if (projectId && setFileExplorerState) {
          setFileExplorerState(projectId, { expandedFolders: Array.from(nextExpanded) });
        }

        closeMenu();
      }

      if (action === 'create-file') {
        const baseDir = target.type === 'folder'
          ? target.path
          : (() => {
              const idx = target.path.lastIndexOf('/');
              return idx >= 0 ? target.path.slice(0, idx) : '';
            })();

        const fileName = window.prompt('New file name:', 'NewFile.txt');
        if (!fileName) {
          closeMenu();
          return;
        }

        const filePath = buildChildPath(baseDir, fileName);
        if (!filePath) {
          window.alert('Invalid file name.');
          closeMenu();
          return;
        }

        const response = await axios.post(`/api/projects/${projectId}/files-ops/create-file`, {
          filePath,
          content: ''
        });

        if (!response.data?.success) {
          throw new Error(response.data?.error || 'Failed to create file');
        }

        await refreshFileTree();
        await stageFileChange?.(projectId, filePath, 'explorer');

        const nextExpanded = new Set(expandedFoldersRef.current);
        if (baseDir) {
          nextExpanded.add(baseDir);
        }
        setExpandedFolders(nextExpanded);
        if (projectId && setFileExplorerState) {
          setFileExplorerState(projectId, { expandedFolders: Array.from(nextExpanded) });
        }

        closeMenu();
        return;
      }
    } catch (err) {
      console.error('File operation failed:', err);
      window.alert(err.response?.data?.error || err.message || 'File operation failed');
      closeMenu();
    }
  }, [shuttingDown, projectId, contextMenu.target, refreshFileTree, stageFileChange, setFileExplorerState, closeTabsForPathPrefix, renameOpenFileState]);

  const handleEditorChange = (value) => {
    setFileStates((prev) => ({
      ...prev,
      [activeFilePath]: {
        ...(prev[activeFilePath] || { originalContent: '', isLoading: false }),
        content: value ?? ''
      }
    }));
  };

  const handleSaveFile = useCallback(async () => {
    if (
      shuttingDown ||
      !projectId ||
      !activeFilePath ||
      !activeFileState ||
      !hasUnsavedChanges
    ) {
      return;
    }

    try {
      await axios.put(`/api/projects/${projectId}/files/${activeFilePath}`, {
        content: activeFileState.content ?? ''
      });

      setSaveStatus('File saved successfully');
      scheduleClearSaveStatus();
      setFileStates((prev) => ({
        ...prev,
        [activeFilePath]: {
          ...prev[activeFilePath],
          originalContent: prev[activeFilePath]?.content ?? ''
        }
      }));

      if (stageFileChange) {
        try {
          await stageFileChange(projectId, activeFilePath, 'editor');
        } catch (error) {
          console.warn('Failed to stage file change', error);
        }
      }

      // If the user opened (or already had) the diff view while the stage request was inflight,
      // refresh the diff after staging completes so the panel reflects the latest index state.
      const latestDiffMode = diffModeByPathRef.current?.[activeFilePath];
      const hadDiffLoaded = Boolean(diffStatesRef.current?.[activeFilePath]);
      if (latestDiffMode || hadDiffLoaded) {
        await loadDiffForFile(activeFilePath);
      }

      if (onFileSaved) {
        onFileSaved(activeFilePath);
      }
    } catch (error) {
      console.error('Failed to save file', error);
      setSaveStatus('Failed to save file');
      scheduleClearSaveStatus();
    }
  }, [
    shuttingDown,
    projectId,
    activeFilePath,
    activeFileState,
    scheduleClearSaveStatus,
    stageFileChange,
    onFileSaved,
    hasUnsavedChanges,
    loadDiffForFile
  ]);

  useEffect(() => {
    saveHandlerRef.current = handleSaveFile;
  }, [handleSaveFile]);

  useEffect(() => {
    handleFileSelectRef.current = handleFileSelect;
  }, [handleFileSelect]);

  const forceActiveFilePath = useCallback((path) => {
    setActiveFilePath(path);
  }, [setActiveFilePath]);

  const forceFileState = useCallback((path, nextState) => {
    setFileStates((prev) => ({
      ...prev,
      [path]: typeof nextState === 'function' ? nextState(prev[path]) : nextState
    }));
  }, [setFileStates]);

  const getLatestFileStates = useCallback(() => fileStatesRef.current, []);
  const getLatestActiveFilePath = useCallback(() => activeFilePathRef.current, []);

  useEffect(() => {
    if (!__testHooks) {
      return undefined;
    }

    __testHooks({
      handleTabSelect,
      handleToggleDiffMode,
      handleEditorChange,
      handleSaveFile,
      dragStateRef,
      forceActiveFilePath,
      forceFileState,
      closeTabsForPathPrefix,
      renameOpenFileState,
      buildSiblingPath,
      buildChildPath,
      suggestDuplicateName,
      handleContextAction,
      getFileStates: getLatestFileStates,
      getActiveFilePath: getLatestActiveFilePath
    });

    return () => __testHooks(null);
  }, [
    __testHooks,
    handleTabSelect,
    handleToggleDiffMode,
    handleEditorChange,
    handleSaveFile,
    forceActiveFilePath,
    forceFileState,
    closeTabsForPathPrefix,
    renameOpenFileState,
    buildSiblingPath,
    buildChildPath,
    suggestDuplicateName,
    handleContextAction,
    getLatestFileStates,
    getLatestActiveFilePath
  ]);

  useEffect(() => {
    if (!editorFocusRequest || editorFocusRequest.projectId !== projectId) {
      return;
    }

    const targetPath = editorFocusRequest.filePath;
    if (!targetPath) {
      return;
    }

    const nextExpanded = new Set(expandedFoldersRef.current);
    const segments = targetPath.split('/').filter(Boolean);
    if (segments.length > 1) {
      let current = '';
      for (const segment of segments.slice(0, -1)) {
        current = current ? `${current}/${segment}` : segment;
        nextExpanded.add(current);
      }
    }
    setExpandedFolders(nextExpanded);
    if (projectId && setFileExplorerState) {
      setFileExplorerState(projectId, { expandedFolders: Array.from(nextExpanded) });
    }

    const descriptor = {
      name: targetPath.split('/').pop() || targetPath,
      path: targetPath,
      type: 'file'
    };
    handleFileSelectRef.current?.(descriptor, { source: 'focus' });

    const focusSource = editorFocusRequest.source;
    const focusCommitSha = editorFocusRequest.commitSha;
    const shouldShowDiff = editorFocusRequest.highlight === 'diff'
      && (focusSource === 'branches' || focusSource === 'commits' || focusSource === 'automation');

    if (shouldShowDiff) {
      setDiffModeByPath((prev) => ({ ...prev, [targetPath]: true }));
      loadDiffForFile(targetPath, { commitSha: focusSource === 'commits' ? focusCommitSha : null });
    }
    clearEditorFocusRequest?.();
  }, [editorFocusRequest, projectId, clearEditorFocusRequest, loadDiffForFile, setFileExplorerState]);

  useEffect(() => {
    if (!registerSaveHandler) {
      return undefined;
    }

    const unregister = registerSaveHandler({
      handleSave: handleSaveFile,
      isDisabled: shuttingDown || !hasUnsavedChanges
    });

    return () => unregister?.();
  }, [registerSaveHandler, handleSaveFile, shuttingDown, hasUnsavedChanges]);

  const getLanguageFromFile = (file) => {
    if (!file) return 'plaintext';

    const ext = file.name.split('.').pop()?.toLowerCase();
    const languageMap = {
      js: 'javascript',
      jsx: 'javascript',
      ts: 'typescript',
      tsx: 'typescript',
      json: 'json',
      html: 'html',
      css: 'css',
      scss: 'scss',
      sass: 'sass',
      py: 'python',
      java: 'java',
      cpp: 'cpp',
      c: 'c',
      cs: 'csharp',
      php: 'php',
      rb: 'ruby',
      go: 'go',
      rs: 'rust',
      md: 'markdown',
      xml: 'xml',
      yaml: 'yaml',
      yml: 'yaml',
      sql: 'sql',
      sh: 'shell',
      bash: 'shell'
    };

    return languageMap[ext] || 'plaintext';
  };

  const editorLanguage = useMemo(() => getLanguageFromFile(activeFileMeta), [activeFileMeta]);

  const activeDiffModelPaths = useMemo(() => {
    if (!projectId || !activeFilePath) {
      return null;
    }

    const encodedPath = encodeURIComponent(activeFilePath);

    const originalRef = activeDiffState?.commitSha
      ? (activeDiffState.originalLabel || `parent-${activeDiffState.commitSha.slice(0, 7)}`)
      : 'head';
    const modifiedRef = activeDiffState?.commitSha
      ? (activeDiffState.modifiedLabel || `commit-${activeDiffState.commitSha.slice(0, 7)}`)
      : 'staged';

    return {
      originalModelPath: `inmemory://lucidcoder/${projectId}/${encodeURIComponent(originalRef)}/${encodedPath}`,
      modifiedModelPath: `inmemory://lucidcoder/${projectId}/${encodeURIComponent(modifiedRef)}/${encodedPath}`
    };
  }, [projectId, activeFilePath, activeDiffState?.commitSha, activeDiffState?.originalLabel, activeDiffState?.modifiedLabel]);

  const handleEditorMount = useCallback((editor, monaco) => {
    if (!editor || typeof editor.addCommand !== 'function') {
      return;
    }

    const keyModValue = monaco?.KeyMod?.CtrlCmd ?? 0;
    const keySValue = monaco?.KeyCode?.KeyS ?? 0;
    const keybinding = keyModValue | keySValue;

    if (keybinding === 0) {
      return;
    }

    editor.addCommand(keybinding, () => saveHandlerRef.current?.());
  }, []);

  return (
    <div
      className={`files-tab${shuttingDown ? ' is-busy' : ''}${isResizingExplorer ? ' is-resizing' : ''}`}
      ref={filesTabRef}
    >
      {shuttingDown && (
        <div
          className="files-shutdown-overlay"
          data-testid="files-shutdown-overlay"
          role="status"
          aria-live="polite"
        >
          <span className="shutdown-dot" aria-hidden="true" />
          <span>Stopping project processes… Editing temporarily disabled.</span>
        </div>
      )}
      <div
        className="file-tree"
        data-testid="file-tree"
        style={{ width: `${explorerWidth}px` }}
      >
        <div className="file-tree-header">
          {projectPath ? (
            <p className="file-tree-path" title={projectPath}>
              {projectPath}
            </p>
          ) : null}
        </div>
        <div
          className="file-tree-content"
          data-testid="file-tree-content"
          onContextMenu={(event) => {
            // Root context menu: allow folder creation at project root.
            openContextMenu(event, { name: 'Project', path: '', type: 'folder' });
          }}
        >
          {loading && <div className="loading">Loading files...</div>}
          {error && <div className="error">{error}</div>}
          {!loading && !error && fileTree.length === 0 && (
            <div className="no-files">No files found in this project</div>
          )}
          {!loading && !error && fileTree.length > 0 && (
            <FileTreeView
              items={fileTree}
              expandedFolders={expandedFolders}
              activeFilePath={activeFilePath}
              stagedPathSet={stagedPathSet}
              onToggleFolder={toggleFolder}
              onOpenContextMenu={openContextMenu}
              onSelectFile={handleFileSelect}
            />
          )}
        </div>
      </div>

      <div
        className="files-tab-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file explorer"
        onMouseDown={handleDividerMouseDown}
      />

      {contextMenu.isOpen && contextMenu.target && (
        <div
          className="file-context-menu"
          role="menu"
          data-testid="file-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <div className="file-context-menu-title">
            {contextMenu.target.path || 'Project'}
          </div>
          <button
            type="button"
            role="menuitem"
            className="file-context-menu-item"
            onClick={() => handleContextAction('create-folder')}
          >
            Create folder
          </button>

          <button
            type="button"
            role="menuitem"
            className="file-context-menu-item"
            onClick={() => handleContextAction('create-file')}
          >
            Create file
          </button>

          {contextMenu.target.path && (
            <>
              <button
                type="button"
                role="menuitem"
                className="file-context-menu-item"
                onClick={() => handleContextAction('rename')}
              >
                Rename
              </button>

              {contextMenu.target.type === 'file' && (
                <button
                  type="button"
                  role="menuitem"
                  className="file-context-menu-item"
                  onClick={() => handleContextAction('duplicate')}
                >
                  Duplicate
                </button>
              )}

              <button
                type="button"
                role="menuitem"
                className="file-context-menu-item danger"
                onClick={() => handleContextAction('delete')}
              >
                Delete
              </button>
            </>
          )}
        </div>
      )}

      <div className="code-editor">
        <div className="editor-header">
          {showInlineSaveButton && (
            <div className="editor-controls-row" data-testid="editor-controls-row">
              <div className="editor-controls-spacer" />
              {activeFileMeta && (
                <button
                  type="button"
                  className={`save-button secondary${isDiffModeActive ? ' active' : ''}`}
                  onClick={handleToggleDiffMode}
                  disabled={shuttingDown}
                  data-testid="toggle-diff-button"
                  title={isDiffModeActive ? 'Hide diff' : 'Show diff'}
                >
                  Diff
                </button>
              )}
              <button
                data-testid="save-file-button"
                className="save-button"
                onClick={handleSaveFile}
                disabled={shuttingDown || !hasUnsavedChanges}
              >
                Save
              </button>
            </div>
          )}
          <div className="editor-tabs-row" data-testid="editor-tabs-row">
            <div className="editor-tabs" role="tablist">
              {openFiles.map((file) => {
                const tabState = fileStates[file.path];
                const isActive = file.path === activeFilePath;
                const isDirty = Boolean(
                  tabState && tabState.content !== tabState.originalContent
                );

                return (
                  <button
                    key={file.path}
                    role="tab"
                    type="button"
                    className={`file-tab${isActive ? ' active' : ''}`}
                    aria-selected={isActive}
                    title={file.path}
                    onClick={() => handleTabSelect(file.path)}
                    disabled={shuttingDown}
                    data-testid={`file-tab-${file.path}`}
                  >
                    <span className="file-tab-name">{file.name}</span>
                    {isDirty && <span className="file-tab-dot" aria-label="Unsaved changes" />}
                    <span
                      className="file-tab-close"
                      role="button"
                      aria-label={`Close ${file.name}`}
                      onClick={(event) => handleTabClose(event, file.path)}
                    >
                      ×
                    </span>
                  </button>
                );
              })}
              {!openFiles.length && (
                <div className="no-open-files" data-testid="no-open-files">
                  No files open
                </div>
              )}
            </div>
          </div>
        </div>

        {saveStatus && <div className="save-status">{saveStatus}</div>}

        <div className="editor-content">
          {activeFileMeta ? (
            isLoadingActiveFile ? (
              <div className="loading-content">Loading file content...</div>
            ) : (
              <>
                {isDiffModeActive && (
                  <div className="editor-diff-panel" data-testid="file-diff-panel">
                    {!activeDiffState || activeDiffState.isLoading ? (
                      <div className="loading-content">Loading diff...</div>
                    ) : activeDiffState.error ? (
                      <div className="error">{activeDiffState.error}</div>
                    ) : activeDiffState.original === activeDiffState.modified ? (
                      <div className="loading-content">No diff available.</div>
                    ) : (
                      <DiffEditor
                        height="100%"
                        language={editorLanguage}
                        original={activeDiffState.original}
                        modified={activeDiffState.modified}
                        originalModelPath={activeDiffModelPaths.originalModelPath}
                        modifiedModelPath={activeDiffModelPaths.modifiedModelPath}
                        keepCurrentOriginalModel
                        keepCurrentModifiedModel
                        theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
                        options={{
                          readOnly: true,
                          renderSideBySide: true,
                          minimap: { enabled: false },
                          scrollBeyondLastLine: false,
                          automaticLayout: true,
                          wordWrap: 'on'
                        }}
                      />
                    )}
                  </div>
                )}

                {!isDiffModeActive && (
                  <Editor
                    height="100%"
                    language={editorLanguage}
                    value={activeFileState?.content || ''}
                    onChange={handleEditorChange}
                    onMount={handleEditorMount}
                    theme={theme === 'light' ? 'vs-light' : 'vs-dark'}
                    options={{
                      minimap: {
                        enabled: true,
                        width: 150,
                        side: 'right'
                      },
                      fontSize: 14,
                      lineNumbers: 'on',
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      tabSize: 2,
                      wordWrap: 'on'
                    }}
                  />
                )}
              </>
            )
          ) : (
            <div className="editor-placeholder">
              <p>Select a file from the tree to start editing</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default FilesTab;
