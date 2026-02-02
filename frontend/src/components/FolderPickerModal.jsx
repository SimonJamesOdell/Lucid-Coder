import React, { useEffect, useMemo, useState } from 'react';
import '../styles/Modal.css';
import './FilesTab.css';
import './FolderPickerModal.css';
import FileTreeView from './filesTab/FileTreeView';

const safeString = (value) => (typeof value === 'string' ? value.trim() : '');

const getParentPath = (value) => {
  const raw = safeString(value);
  if (!raw) {
    return null;
  }
  if (raw === '/') {
    return null;
  }
  const trimmed = raw.replace(/[\\/]+$/, '');
  if (!trimmed) {
    return null;
  }
  if (/^[a-zA-Z]:$/.test(trimmed)) {
    return null;
  }

  const lastBackslash = trimmed.lastIndexOf('\\');
  const lastSlash = trimmed.lastIndexOf('/');
  const splitIndex = Math.max(lastBackslash, lastSlash);
  if (splitIndex < 0) {
    return null;
  }

  let parent = trimmed.slice(0, splitIndex);
  if (!parent) {
    parent = '/';
  }
  if (/^[a-zA-Z]:$/.test(parent)) {
    parent = `${parent}\\`;
  }
  return parent;
};

const buildBreadcrumbs = (value) => {
  const raw = safeString(value);
  if (!raw) {
    return [];
  }
  if (raw === '/') {
    return [{ label: '/', path: '/' }];
  }
  const trimmed = raw.startsWith('/')
    ? `/${raw.slice(1).replace(/[\\/]+$/, '')}`
    : raw.replace(/[\\/]+$/, '');
  if (!trimmed) {
    return [];
  }
  if (trimmed === '/') {
    return [{ label: '/', path: '/' }];
  }
  if (/^[a-zA-Z]:$/.test(trimmed)) {
    return [{ label: trimmed, path: `${trimmed}\\` }];
  }

  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  const breadcrumbs = [];
  let accumulator = trimmed.startsWith('/') ? '/' : '';

  parts.forEach((part, index) => {
    if (accumulator && !accumulator.endsWith('/') && !accumulator.endsWith('\\')) {
      accumulator += accumulator.includes('\\') ? '\\' : '/';
    }
    accumulator += part;
    if (index === 0 && /^[a-zA-Z]:$/.test(part)) {
      accumulator = `${part}\\`;
    }
    breadcrumbs.push({ label: part, path: accumulator });
  });

  return breadcrumbs;
};

const FolderPickerModal = ({ isOpen, initialPath = '', onSelect, onClose, __testHooks }) => {
  const [currentPath, setCurrentPath] = useState('');
  const [roots, setRoots] = useState([]);
  const [treeState, setTreeState] = useState({});
  const [selectedPath, setSelectedPath] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const breadcrumbs = useMemo(() => buildBreadcrumbs(currentPath), [currentPath]);

  const setNodeState = (pathValue, updates = {}) => {
    setTreeState((prev) => ({
      ...prev,
      [pathValue]: {
        ...(prev[pathValue] || {}),
        ...updates
      }
    }));
  };

  const loadRoots = async () => {
    setIsLoading(true);
    setError('');
    try {
      const response = await fetch('/api/fs/roots');
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to load roots');
      }
      setRoots(data.roots || []);
    } catch (err) {
      setError(err?.message || 'Failed to load roots');
    } finally {
      setIsLoading(false);
    }
  };

  const loadDirectory = async (pathValue) => {
    const target = safeString(pathValue);
    if (!target) {
      return;
    }
    setNodeState(target, { isLoading: true, error: '' });
    setError('');
    try {
      const response = await fetch(`/api/fs/list?path=${encodeURIComponent(target)}`);
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.success) {
        throw new Error(data?.error || 'Failed to load directory');
      }
      const resolvedPath = data.path || target;
      setCurrentPath(resolvedPath);
      setNodeState(resolvedPath, {
        children: data.directories || [],
        isLoading: false,
        isExpanded: true,
        hasLoaded: true,
        error: ''
      });
    } catch (err) {
      const message = err?.message || 'Failed to load directory';
      setNodeState(target, { isLoading: false, error: message });
      setError(message);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const initial = safeString(initialPath);
    setSelectedPath(initial);
    setCurrentPath(initial || '');
    loadRoots();
    if (initial) {
      loadDirectory(initial);
    }
  }, [initialPath, isOpen]);

  const handleSelect = () => {
    const target = safeString(selectedPath || currentPath);
    if (!target) {
      return;
    }
    if (typeof onSelect === 'function') {
      onSelect(target);
    }
  };

  const handleOpen = (pathValue) => {
    const target = safeString(pathValue);
    if (!target) {
      return;
    }
    setSelectedPath(target);
    setCurrentPath(target);
    const node = treeState[target];
    if (node?.hasLoaded) {
      setNodeState(target, { isExpanded: true });
      return;
    }
    loadDirectory(target);
  };

  useEffect(() => {
    if (typeof __testHooks === 'function') {
      __testHooks({ loadDirectory, handleOpen, handleSelect });
    }
  }, [__testHooks, loadDirectory, handleOpen, handleSelect]);

  const handleUp = () => {
    const parent = getParentPath(currentPath);
    if (!parent) {
      setCurrentPath('');
      setSelectedPath('');
      loadRoots();
      return;
    }
    setSelectedPath(parent);
    loadDirectory(parent);
  };

  const closeModal = () => {
    if (typeof onClose === 'function') {
      onClose();
    }
  };

  const toggleNode = (pathValue) => {
    const target = safeString(pathValue);
    if (!target) {
      return;
    }
    const node = treeState[target] || {};
    const nextExpanded = !node.isExpanded;
    setNodeState(target, { isExpanded: nextExpanded });
    if (nextExpanded && !node.hasLoaded) {
      loadDirectory(target);
    }
  };

  const buildTreeItems = (entries = []) => entries.map((entry) => {
    const nodeState = treeState[entry.path] || {};
    const children = nodeState.hasLoaded
      ? buildTreeItems(nodeState.children)
      : null;
    return {
      name: entry.name,
      path: entry.path,
      type: 'folder',
      isLoading: Boolean(nodeState.isLoading),
      children
    };
  });

  if (!isOpen) {
    return null;
  }

  const canSelect = Boolean(safeString(selectedPath || currentPath));

  return (
    <div className="modal-backdrop" onClick={closeModal}>
      <div
        className="modal-content folder-picker-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Select folder"
      >
        <div className="modal-header">
          <h3 className="modal-title">Select a folder</h3>
          <button className="modal-close" onClick={closeModal} aria-label="Close modal">
            ×
          </button>
        </div>

        <div className="modal-body folder-picker-body">
          <div className="folder-picker-toolbar">
            <button type="button" className="folder-picker-up" onClick={handleUp} disabled={!currentPath || isLoading}>
              Up
            </button>
            <div className="folder-picker-path">
              {breadcrumbs.length === 0 ? (
                <span>Roots</span>
              ) : (
                breadcrumbs.map((crumb, index) => (
                  <button
                    key={`${crumb.path}-${index}`}
                    type="button"
                    className="folder-picker-crumb"
                    onClick={() => handleOpen(crumb.path)}
                    disabled={isLoading}
                  >
                    {crumb.label}
                  </button>
                ))
              )}
            </div>
          </div>

          {error && <div className="folder-picker-error">{error}</div>}

          <div className="folder-picker-list file-tree-content" role="tree" aria-busy={isLoading}>
            {isLoading && <div className="folder-picker-loading">Loading...</div>}
            {!isLoading && roots.length === 0 && (
              <div className="folder-picker-empty">No roots available.</div>
            )}
            {!isLoading && roots.length > 0 && (
              <FileTreeView
                items={buildTreeItems(roots)}
                expandedFolders={new Set(Object.keys(treeState).filter((key) => treeState[key]?.isExpanded))}
                activeFilePath={null}
                selectedFolderPath={selectedPath}
                stagedPathSet={new Set()}
                onToggleFolder={toggleNode}
                onSelectFolder={(item) => {
                  setSelectedPath(item.path);
                  setCurrentPath(item.path);
                }}
                onSelectFile={null}
                onOpenContextMenu={null}
              />
            )}
          </div>
        </div>

        <div className="modal-footer">
          <button className="modal-btn modal-btn-cancel" onClick={closeModal}>
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-confirm modal-btn-default"
            onClick={handleSelect}
            disabled={!canSelect}
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
};

export default FolderPickerModal;
