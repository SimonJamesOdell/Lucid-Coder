import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import './AssetsTab.css';
import AssetOptimizeModal from './AssetOptimizeModal';

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
  const [imageZoom, setImageZoom] = useState(1);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const [isImagePanning, setIsImagePanning] = useState(false);
  const panStartRef = useRef({ startX: 0, startY: 0, offsetX: 0, offsetY: 0 });

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
      setAssets(sortAssets(entries));
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
      setOptimizeModalAssetPath('');
    } catch (err) {
      console.error('Failed to optimize asset:', err);
      window.alert(err?.response?.data?.error || err?.message || 'Failed to optimize asset');
    } finally {
      setOptimizingPath('');
    }
  }, [loadAssets, projectId, selectedAssetPath]);

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
    AssetsTab.__testHooks.handlers.optimizeAsset = optimizeAsset;
    AssetsTab.__testHooks.handlers.handleAutoOptimize = handleAutoOptimize;
    AssetsTab.__testHooks.handlers.handleManualOptimize = handleManualOptimize;
  }

  if (!projectId) {
    return <div className="assets-tab__empty">Select a project to view assets.</div>;
  }

  return (
    <div className="assets-tab" data-testid="assets-tab-content">
      <div className="assets-tab__header">
        <h3>Assets</h3>
        <button
          type="button"
          className="assets-tab__refresh"
          onClick={loadAssets}
          disabled={loading}
        >
          Refresh
        </button>
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
                  className="assets-tab__card"
                  data-testid="asset-card"
                  onClick={() => setSelectedAssetPath(asset.path)}
                >
                  <div className="assets-tab__preview">
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
    encodeRepoPath
  }
});
