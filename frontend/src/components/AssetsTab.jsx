import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import './AssetsTab.css';
import AssetOptimizeModal from './AssetOptimizeModal';
import AssetRenameModal from './AssetRenameModal';
import {
  getAssistantAssetContextPaths,
  setAssistantAssetContextPaths
} from '../utils/assistantAssetContext';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'ogg', 'mov']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac']);

const getFileExtension = (filePath) => {
  if (typeof filePath !== 'string') {
    return '';
  }

  const fileName = filePath.split('/').pop() || '';
  const dot = fileName.lastIndexOf('.');
  if (dot < 0 || dot === fileName.length - 1) {
    return '';
  }
  return fileName.slice(dot + 1).toLowerCase();
};

const encodeRepoPath = (filePath) => {
  return String(filePath || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
};

const formatSizeBytes = (value) => {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) {
    return 'Unknown';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  if (size < 1024 * 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
};

const splitAssetFileName = (assetPath) => {
  const sourcePath = String(assetPath || '').trim();
  const sourceParts = sourcePath.split('/').filter(Boolean);
  if (sourceParts.length === 0) {
    return { parentParts: [], sourceName: '', baseName: '', extension: '' };
  }

  const sourceName = sourceParts[sourceParts.length - 1];
  const dotIndex = sourceName.lastIndexOf('.');
  const hasExtension = dotIndex > 0 && dotIndex < sourceName.length - 1;

  return {
    parentParts: sourceParts.slice(0, -1),
    sourceName,
    baseName: hasExtension ? sourceName.slice(0, dotIndex) : sourceName,
    extension: hasExtension ? sourceName.slice(dotIndex + 1) : ''
  };
};

const buildRenamedAssetPath = (assetPath, nextBaseName) => {
  const sourcePath = String(assetPath || '').trim();
  const requestedBaseName = String(nextBaseName || '').trim();

  if (!sourcePath || !requestedBaseName) {
    return { error: 'Rename cancelled or empty name.' };
  }

  if (requestedBaseName.includes('/') || requestedBaseName.includes('\\')) {
    return { error: 'Name cannot include path separators.' };
  }

  if (requestedBaseName === '.' || requestedBaseName === '..') {
    return { error: 'Name is invalid.' };
  }

  const { parentParts, sourceName, extension } = splitAssetFileName(sourcePath);
  if (!sourceName) {
    return { error: 'Asset path is invalid.' };
  }

  if (extension && requestedBaseName.includes('.')) {
    return { error: 'Name cannot include an extension.' };
  }

  const requestedName = extension ? `${requestedBaseName}.${extension}` : requestedBaseName;
  if (requestedName === sourceName) {
    return { error: null, toPath: sourcePath, unchanged: true };
  }

  const toPath = [...parentParts, requestedName].join('/');
  return { error: null, toPath, unchanged: false };
};

const sortAssets = (entries) => {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path));
};

const AssetsTab = ({ project }) => {
  const projectId = project?.id;
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deletingPath, setDeletingPath] = useState('');
  const [optimizingPath, setOptimizingPath] = useState('');
  const [selectedAssetPath, setSelectedAssetPath] = useState('');
  const [optimizeModalAssetPath, setOptimizeModalAssetPath] = useState('');
  const [renameModalAssetPath, setRenameModalAssetPath] = useState('');
  const [renameInputValue, setRenameInputValue] = useState('');
  const [renameErrorMessage, setRenameErrorMessage] = useState('');
  const [renamingPath, setRenamingPath] = useState('');
  const [assistantAssetContextPaths, setAssistantAssetContextPathsState] = useState([]);
  const [imageZoom, setImageZoom] = useState(1);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const [isImagePanning, setIsImagePanning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const panStartRef = useRef({ startX: 0, startY: 0, offsetX: 0, offsetY: 0 });
  const filePickerRef = useRef(null);

  const loadAssets = useCallback(async () => {
    if (!projectId) {
      setAssets([]);
      setError('');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const response = await axios.get(`/api/projects/${projectId}/assets`);
      if (!response?.data?.success) {
        throw new Error(response?.data?.error || 'Failed to load assets');
      }

      const entries = Array.isArray(response.data.assets) ? response.data.assets : [];
      const sortedEntries = sortAssets(entries);
      setAssets(sortedEntries);
      setAssistantAssetContextPathsState((previous) => {
        if (!previous.length) {
          return previous;
        }

        const availablePaths = new Set(sortedEntries.map((entry) => entry.path));
        const prunedPaths = previous.filter((path) => availablePaths.has(path));

        if (prunedPaths.length !== previous.length) {
          setAssistantAssetContextPaths(projectId, prunedPaths);
          return prunedPaths;
        }

        return previous;
      });
    } catch (err) {
      console.error('Failed to load assets:', err);
      setAssets([]);
      setError(err?.response?.data?.error || err?.message || 'Failed to load assets');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadAssets();
  }, [loadAssets]);

  useEffect(() => {
    setSelectedAssetPath('');
    setOptimizeModalAssetPath('');
    setRenameModalAssetPath('');
    setRenameInputValue('');
    setRenameErrorMessage('');
    setRenamingPath('');
  }, [projectId]);

  useEffect(() => {
    if (!projectId) {
      setAssistantAssetContextPathsState([]);
      return;
    }

    setAssistantAssetContextPathsState(getAssistantAssetContextPaths(projectId));
  }, [projectId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !projectId) {
      return undefined;
    }

    const handleAssetsUpdated = (event) => {
      const targetProjectId = event?.detail?.projectId;
      if (targetProjectId && String(targetProjectId) !== String(projectId)) {
        return;
      }
      loadAssets();
    };

    window.addEventListener('lucidcoder:assets-updated', handleAssetsUpdated);
    return () => {
      window.removeEventListener('lucidcoder:assets-updated', handleAssetsUpdated);
    };
  }, [loadAssets, projectId]);

  const toBase64 = useCallback(async (file) => {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 0x8000;

    for (let index = 0; index < bytes.length; index += chunkSize) {
      const chunk = bytes.subarray(index, index + chunkSize);
      binary += String.fromCharCode(...chunk);
    }

    return btoa(binary);
  }, []);

  const sanitizeUploadFileName = useCallback((name) => {
    const normalized = String(name || 'file').replace(/[\\/]+/g, '-').trim();
    const fallback = normalized || 'file';
    return fallback.replace(/[^a-zA-Z0-9._-]/g, '_');
  }, []);

  const buildUniqueUploadPath = useCallback((fileName, attempt = 0) => {
    const safeName = sanitizeUploadFileName(fileName);
    const dotIndex = safeName.lastIndexOf('.');
    const hasExtension = dotIndex > 0;
    const stem = hasExtension ? safeName.slice(0, dotIndex) : safeName;
    const extension = hasExtension ? safeName.slice(dotIndex) : '';
    const suffix = attempt > 0 ? `-${attempt}` : '';
    return `uploads/${stem}${suffix}${extension}`;
  }, [sanitizeUploadFileName]);

  const createProjectFileFromUpload = useCallback(async (file, attempt = 0) => {
    const filePath = buildUniqueUploadPath(file.name, attempt);
    const contentBase64 = await toBase64(file);

    try {
      await axios.post(`/api/projects/${projectId}/files-ops/create-file`, {
        filePath,
        contentBase64,
        encoding: 'base64',
        openInEditor: false
      });
      return filePath;
    } catch (uploadError) {
      if (uploadError?.response?.status === 409) {
        return createProjectFileFromUpload(file, attempt + 1);
      }
      throw uploadError;
    }
  }, [buildUniqueUploadPath, projectId, toBase64]);

  const handleUploadClick = useCallback(() => {
    filePickerRef.current?.click?.();
  }, []);

  const handleUploadSelected = useCallback(async (event) => {
    const selected = Array.from(event?.target?.files || []);
    if (!selected.length || !projectId) {
      if (event?.target) {
        event.target.value = '';
      }
      return;
    }

    setUploading(true);
    setError('');

    try {
      const uploadedPaths = await Promise.all(selected.map((file) => createProjectFileFromUpload(file)));
      await loadAssets();
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('lucidcoder:assets-updated', {
          detail: { projectId, paths: uploadedPaths }
        }));
      }
    } catch (uploadError) {
      console.error('Failed to upload assets:', uploadError);
      setError(uploadError?.response?.data?.error || uploadError?.message || 'Failed to upload assets');
    } finally {
      setUploading(false);
      if (event?.target) {
        event.target.value = '';
      }
    }
  }, [createProjectFileFromUpload, loadAssets, projectId]);

  const deleteAsset = useCallback(async (assetPath) => {
    if (!projectId || !assetPath) {
      return;
    }

    const ok = window.confirm(`Delete this asset?\n\n${assetPath}`);
    if (!ok) {
      return;
    }

    setDeletingPath(assetPath);
    try {
      const response = await axios.post(`/api/projects/${projectId}/files-ops/delete`, {
        targetPath: assetPath,
        recursive: false
      });
      if (!response?.data?.success) {
        throw new Error(response?.data?.error || 'Failed to delete asset');
      }
      await loadAssets();
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('lucidcoder:assets-updated', {
          detail: { projectId }
        }));
      }
    } catch (err) {
      console.error('Failed to delete asset:', err);
      window.alert(err?.response?.data?.error || err?.message || 'Failed to delete asset');
    } finally {
      setDeletingPath('');
    }
  }, [loadAssets, projectId]);

  const applyAssetRename = useCallback(async ({ fromPath, toPath }) => {
    if (!projectId || !fromPath || !toPath) {
      return;
    }

    setRenamingPath(fromPath);
    try {
      const priorContextPaths = getAssistantAssetContextPaths(projectId);

      const response = await axios.post(`/api/projects/${projectId}/files-ops/rename`, {
        fromPath,
        toPath
      });
      if (!response?.data?.success) {
        throw new Error(response?.data?.error || 'Failed to rename asset');
      }

      await loadAssets();

      if (selectedAssetPath === fromPath) {
        setSelectedAssetPath(toPath);
      }
      if (optimizeModalAssetPath === fromPath) {
        setOptimizeModalAssetPath(toPath);
      }

      const remappedContextPaths = [...new Set(priorContextPaths.map((path) => (path === fromPath ? toPath : path)))];
      setAssistantAssetContextPaths(projectId, remappedContextPaths);
      setAssistantAssetContextPathsState(remappedContextPaths);

      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('lucidcoder:assets-updated', {
          detail: { projectId }
        }));
      }

      setRenameModalAssetPath('');
      setRenameInputValue('');
      setRenameErrorMessage('');
    } catch (err) {
      console.error('Failed to rename asset:', err);
      setRenameErrorMessage(err?.response?.data?.error || err?.message || 'Failed to rename asset');
    } finally {
      setRenamingPath('');
    }
  }, [loadAssets, optimizeModalAssetPath, projectId, selectedAssetPath]);

  const openRenameModal = useCallback((assetPath) => {
    if (!projectId || !assetPath) {
      return;
    }

    const { baseName } = splitAssetFileName(assetPath);
    setRenameModalAssetPath(assetPath);
    setRenameInputValue(baseName);
    setRenameErrorMessage('');
  }, [projectId]);

  const submitRenameModal = useCallback(async () => {
    if (!renameModalAssetPath) {
      return;
    }

    const { error: validationError, toPath, unchanged } = buildRenamedAssetPath(renameModalAssetPath, renameInputValue);
    if (validationError) {
      setRenameErrorMessage(validationError);
      return;
    }
    if (unchanged || !toPath) {
      setRenameModalAssetPath('');
      setRenameInputValue('');
      setRenameErrorMessage('');
      return;
    }

    await applyAssetRename({ fromPath: renameModalAssetPath, toPath });
  }, [applyAssetRename, renameInputValue, renameModalAssetPath]);

  const optimizeAsset = useCallback(async (assetPath, payload = {}) => {
    if (!projectId || !assetPath) {
      return;
    }

    setOptimizingPath(assetPath);
    try {
      const response = await axios.post(`/api/projects/${projectId}/assets/optimize`, {
        assetPath,
        ...payload
      });
      if (!response?.data?.success) {
        throw new Error(response?.data?.error || 'Failed to optimize asset');
      }

      const nextPath = typeof response?.data?.path === 'string' ? response.data.path : assetPath;
      await loadAssets();
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('lucidcoder:assets-updated', {
          detail: { projectId }
        }));
      }
      if (selectedAssetPath === assetPath) {
        setSelectedAssetPath(nextPath);
      }
      setAssistantAssetContextPathsState((previous) => {
        const nextPaths = [...new Set(previous.map((path) => (path === assetPath ? nextPath : path)))]
          .sort((left, right) => left.localeCompare(right));

        if (nextPaths.length === previous.length && nextPaths.every((path, index) => path === previous[index])) {
          return previous;
        }

        setAssistantAssetContextPaths(projectId, nextPaths);
        return nextPaths;
      });
      setOptimizeModalAssetPath('');
    } catch (err) {
      console.error('Failed to optimize asset:', err);
      window.alert(err?.response?.data?.error || err?.message || 'Failed to optimize asset');
    } finally {
      setOptimizingPath('');
    }
  }, [loadAssets, projectId, selectedAssetPath]);

  const toggleAssistantAssetContextPath = useCallback((assetPath) => {
    if (!projectId || !assetPath) {
      return;
    }

    setAssistantAssetContextPathsState((previous) => {
      const nextPaths = previous.includes(assetPath) ? [] : [assetPath];
      setAssistantAssetContextPaths(projectId, nextPaths);
      return nextPaths;
    });
  }, [projectId]);

  const cards = useMemo(() => {
    return assets.map((entry) => {
      const ext = getFileExtension(entry.path);
      const encodedPath = encodeRepoPath(entry.path);
      const assetUrl = `/api/projects/${encodeURIComponent(String(projectId))}/assets/${encodedPath}`;
      const isImage = IMAGE_EXTENSIONS.has(ext);
      const isVideo = VIDEO_EXTENSIONS.has(ext);
      const isAudio = AUDIO_EXTENSIONS.has(ext);

      return {
        ...entry,
        ext,
        assetUrl,
        isImage,
        isVideo,
        isAudio,
        sizeLabel: formatSizeBytes(entry.sizeBytes),
        optimizedLabel: entry.optimizedForTransmission ? 'optimized' : 'unoptimized',
        optimizedClassName: entry.optimizedForTransmission
          ? 'assets-tab__optimization assets-tab__optimization--optimized'
          : 'assets-tab__optimization assets-tab__optimization--unoptimized'
      };
    });
  }, [assets, projectId]);

  const selectedAsset = useMemo(() => {
    if (!selectedAssetPath) {
      return null;
    }
    return cards.find((entry) => entry.path === selectedAssetPath) || null;
  }, [cards, selectedAssetPath]);

  useEffect(() => {
    setImageZoom(1);
    setImageOffset({ x: 0, y: 0 });
    setIsImagePanning(false);
  }, [selectedAssetPath]);

  const modalAsset = useMemo(() => {
    if (!optimizeModalAssetPath) {
      return null;
    }
    return cards.find((entry) => entry.path === optimizeModalAssetPath) || null;
  }, [cards, optimizeModalAssetPath]);

  const imageZoomPercent = Math.round(imageZoom * 100);
  const selectedAssistantAssetCount = assistantAssetContextPaths.length;
  const selectedAssistantAssetPath = assistantAssetContextPaths[0] || '';

  const handleAutoOptimize = useCallback(() => {
    if (!modalAsset?.path) {
      return;
    }
    optimizeAsset(modalAsset.path, { mode: 'auto' });
  }, [modalAsset?.path, optimizeAsset]);

  const handleManualOptimize = useCallback((options) => {
    if (!modalAsset?.path) {
      return;
    }
    optimizeAsset(modalAsset.path, {
      mode: 'manual',
      options
    });
  }, [modalAsset?.path, optimizeAsset]);

  const clampZoom = useCallback((value) => {
    return Math.max(0.05, Math.min(6, value));
  }, []);

  const handleImageWheel = useCallback((event) => {
    event.preventDefault();

    const zoomDelta = -event.deltaY * 0.0015;
    setImageZoom((prevZoom) => {
      const nextZoom = clampZoom(prevZoom + zoomDelta);
      if (nextZoom <= 1) {
        setImageOffset({ x: 0, y: 0 });
      }
      return nextZoom;
    });
  }, [clampZoom]);

  const handleImageMouseDown = useCallback((event) => {
    if (event.button !== 0 || imageZoom <= 1) {
      return;
    }

    event.preventDefault();
    panStartRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      offsetX: imageOffset.x,
      offsetY: imageOffset.y
    };
    setIsImagePanning(true);
  }, [imageOffset.x, imageOffset.y, imageZoom]);

  const handleImageMouseMove = useCallback((event) => {
    if (!isImagePanning) {
      return;
    }

    const deltaX = event.clientX - panStartRef.current.startX;
    const deltaY = event.clientY - panStartRef.current.startY;
    setImageOffset({
      x: panStartRef.current.offsetX + deltaX,
      y: panStartRef.current.offsetY + deltaY
    });
  }, [isImagePanning]);

  const handleImageMouseUp = useCallback(() => {
    if (!isImagePanning) {
      return;
    }
    setIsImagePanning(false);
  }, [isImagePanning]);

  if (AssetsTab.__testHooks?.handlers) {
    AssetsTab.__testHooks.handlers.deleteAsset = deleteAsset;
    AssetsTab.__testHooks.handlers.applyAssetRename = applyAssetRename;
    AssetsTab.__testHooks.handlers.renameAsset = openRenameModal;
    AssetsTab.__testHooks.handlers.openOptimizeModal = setOptimizeModalAssetPath;
    AssetsTab.__testHooks.handlers.submitRenameModal = submitRenameModal;
    AssetsTab.__testHooks.handlers.optimizeAsset = optimizeAsset;
    AssetsTab.__testHooks.handlers.toggleAssistantAssetContextPath = toggleAssistantAssetContextPath;
    AssetsTab.__testHooks.handlers.handleAutoOptimize = handleAutoOptimize;
    AssetsTab.__testHooks.handlers.handleManualOptimize = handleManualOptimize;
  }

  if (!projectId) {
    return <div className="assets-tab__empty">Select a project to view assets.</div>;
  }

  return (
    <div className="assets-tab" data-testid="assets-tab-content">
      <div className="assets-tab__header">
        <div className="assets-tab__header-title">
          <h3>Assets</h3>
          <span className="assets-tab__assistant-count">AI context: {selectedAssistantAssetCount}</span>
        </div>
        <div className="assets-tab__header-actions">
          <button
            type="button"
            className="assets-tab__refresh assets-tab__upload"
            onClick={handleUploadClick}
            disabled={loading || uploading}
          >
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          <button
            type="button"
            className="assets-tab__refresh"
            onClick={loadAssets}
            disabled={loading || uploading}
          >
            Refresh
          </button>
          <input
            ref={filePickerRef}
            type="file"
            multiple
            className="assets-tab__file-picker"
            onChange={handleUploadSelected}
          />
        </div>
      </div>

      {loading && <div className="assets-tab__status">Loading assets…</div>}
      {!loading && error && <div className="assets-tab__status assets-tab__status--error">{error}</div>}
      {!loading && !error && cards.length === 0 && (
        <div className="assets-tab__empty">No uploaded assets yet. Use the + button in chat to add files.</div>
      )}

      {!loading && !error && cards.length > 0 && (
        <>
          {selectedAsset ? (
            <section className="assets-tab__viewer" data-testid="asset-viewer">
              <div className="assets-tab__viewer-header">
                <div className="assets-tab__viewer-title" title={selectedAsset.path}>{selectedAsset.path}</div>
                <div className="assets-tab__viewer-actions">
                  {selectedAsset.isImage ? (
                    <span className="assets-tab__viewer-zoom" aria-live="polite">Zoom {imageZoomPercent}%</span>
                  ) : null}
                  <button
                    type="button"
                    className="assets-tab__viewer-rename"
                    onClick={() => openRenameModal(selectedAsset.path)}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className="assets-tab__viewer-optimize"
                    onClick={() => setOptimizeModalAssetPath(selectedAsset.path)}
                    disabled={optimizingPath === selectedAsset.path}
                  >
                    Optimize
                  </button>
                  <button
                    type="button"
                    className="assets-tab__viewer-close"
                    onClick={() => setSelectedAssetPath('')}
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className={`assets-tab__viewer-body ${selectedAsset.isImage ? 'assets-tab__viewer-body--image' : ''}`}>
                {selectedAsset.isImage ? (
                  <div
                    className={`assets-tab__image-panzoom ${imageZoom > 1 ? 'assets-tab__image-panzoom--active' : ''} ${isImagePanning ? 'assets-tab__image-panzoom--panning' : ''}`}
                    onWheel={handleImageWheel}
                    onMouseDown={handleImageMouseDown}
                    onMouseMove={handleImageMouseMove}
                    onMouseUp={handleImageMouseUp}
                    onMouseLeave={handleImageMouseUp}
                  >
                    <img
                      src={selectedAsset.assetUrl}
                      alt={selectedAsset.name}
                      draggable={false}
                      style={{ transform: `translate(${imageOffset.x}px, ${imageOffset.y}px) scale(${imageZoom})` }}
                    />
                  </div>
                ) : selectedAsset.isVideo ? (
                  <video src={selectedAsset.assetUrl} controls autoPlay />
                ) : selectedAsset.isAudio ? (
                  <audio src={selectedAsset.assetUrl} controls autoPlay />
                ) : (
                  <div className="assets-tab__viewer-fallback">
                    <p>Preview not available for this file type.</p>
                    <a href={selectedAsset.assetUrl} className="assets-tab__viewer-download" download>
                      Download file
                    </a>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <div className="assets-tab__grid">
              {cards.map((asset) => (
                <article
                  key={asset.path}
                  className={`assets-tab__card ${selectedAssistantAssetPath && selectedAssistantAssetPath !== asset.path ? 'assets-tab__card--dimmed' : ''}`}
                  data-testid="asset-card"
                  onClick={() => setSelectedAssetPath(asset.path)}
                >
                  <div className="assets-tab__preview">
                    <label
                      className={`assets-tab__context-overlay ${selectedAssistantAssetPath === asset.path ? 'assets-tab__context-overlay--selected' : ''}`}
                      onClick={(event) => {
                        event.stopPropagation();
                      }}
                    >
                      <input
                        type="checkbox"
                        aria-label="Include in AI context"
                        checked={selectedAssistantAssetPath === asset.path}
                        disabled={Boolean(selectedAssistantAssetPath && selectedAssistantAssetPath !== asset.path)}
                        onChange={() => {
                          toggleAssistantAssetContextPath(asset.path);
                        }}
                      />
                    </label>
                    {asset.isImage ? (
                      <img src={asset.assetUrl} alt={asset.name} loading="lazy" />
                    ) : asset.isVideo ? (
                      <video src={asset.assetUrl} controls preload="metadata" />
                    ) : asset.isAudio ? (
                      <audio src={asset.assetUrl} controls preload="metadata" />
                    ) : (
                      <div className="assets-tab__file-badge">{asset.ext ? asset.ext.toUpperCase() : 'FILE'}</div>
                    )}
                  </div>
                  <div className="assets-tab__meta">
                    <div className="assets-tab__name" title={asset.name}>{asset.name}</div>
                    <div className="assets-tab__path" title={asset.path}>{asset.path}</div>
                    <div className="assets-tab__detail">Size on disk: {asset.sizeLabel}</div>
                    {asset.isImage ? (
                      <div className="assets-tab__detail">
                        Dimensions: {asset.pixelWidth && asset.pixelHeight ? `${asset.pixelWidth} × ${asset.pixelHeight} px` : 'Unknown'}
                      </div>
                    ) : null}
                    <div className="assets-tab__detail">
                      Transmission: <span className={asset.optimizedClassName}>{asset.optimizedLabel}</span>
                    </div>
                  </div>
                  <div className="assets-tab__actions">
                    <button
                      type="button"
                      className="assets-tab__action assets-tab__action--rename"
                      onClick={(event) => {
                        event.stopPropagation();
                        openRenameModal(asset.path);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className="assets-tab__action assets-tab__action--optimize"
                      onClick={(event) => {
                        event.stopPropagation();
                        setOptimizeModalAssetPath(asset.path);
                      }}
                      disabled={optimizingPath === asset.path}
                    >
                      Optimize
                    </button>
                    <button
                      type="button"
                      className="assets-tab__action assets-tab__action--delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        deleteAsset(asset.path);
                      }}
                      disabled={deletingPath === asset.path}
                    >
                      {deletingPath === asset.path ? 'Deleting…' : 'Delete'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      <AssetOptimizeModal
        isOpen={Boolean(modalAsset)}
        asset={modalAsset}
        onClose={() => setOptimizeModalAssetPath('')}
        onAutoOptimize={handleAutoOptimize}
        onManualOptimize={handleManualOptimize}
        isAutoOptimizing={Boolean(modalAsset?.path && optimizingPath === modalAsset.path)}
        isManualOptimizing={Boolean(modalAsset?.path && optimizingPath === modalAsset.path)}
      />

      <AssetRenameModal
        isOpen={Boolean(renameModalAssetPath)}
        assetPath={renameModalAssetPath}
        fileName={splitAssetFileName(renameModalAssetPath).sourceName}
        extension={splitAssetFileName(renameModalAssetPath).extension}
        value={renameInputValue}
        errorMessage={renameErrorMessage}
        isSubmitting={Boolean(renamingPath)}
        onClose={() => {
          if (renamingPath) {
            return;
          }
          setRenameModalAssetPath('');
          setRenameInputValue('');
          setRenameErrorMessage('');
        }}
        onChange={(nextValue) => {
          setRenameInputValue(nextValue);
          if (renameErrorMessage) {
            setRenameErrorMessage('');
          }
        }}
        onSubmit={submitRenameModal}
      />
    </div>
  );
};

export default AssetsTab;

AssetsTab.__testHooks = AssetsTab.__testHooks || {};
Object.assign(AssetsTab.__testHooks, {
  handlers: AssetsTab.__testHooks.handlers || {},
  helpers: {
    getFileExtension,
    formatSizeBytes,
    encodeRepoPath,
    buildRenamedAssetPath
  }
});
