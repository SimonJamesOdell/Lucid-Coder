import React, { useEffect, useState } from 'react';
import SettingsModal from './SettingsModal';
import './AssetOptimizeModal.css';

const AssetOptimizeModal = ({
  isOpen,
  asset,
  onClose,
  onAutoOptimize,
  onManualOptimize,
  isAutoOptimizing = false,
  isManualOptimizing = false
}) => {
  const [quality, setQuality] = useState(76);
  const [scalePercent, setScalePercent] = useState(100);
  const [format, setFormat] = useState('auto');

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setQuality(76);
    setScalePercent(100);
    setFormat('auto');
  }, [isOpen, asset?.path]);

  const isBusy = isAutoOptimizing || isManualOptimizing;

  return (
    <SettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Optimize Asset"
      subtitle="Tune compression, scaling, and output type—or let Auto Optimize pick the best settings."
      testId="asset-optimize-modal"
      closeTestId="asset-optimize-close"
      titleId="asset-optimize-title"
      panelClassName="asset-optimize-modal-panel"
      bodyClassName="asset-optimize-modal-body"
      closeLabel="Close optimize modal"
    >
      <div className="asset-optimize-form">
        <div className="asset-optimize-target" title={asset?.path || ''}>{asset?.path || 'No asset selected'}</div>

        <label className="asset-optimize-field" htmlFor="asset-optimize-format">
          <span className="asset-optimize-label">Output type</span>
          <select
            id="asset-optimize-format"
            className="asset-optimize-input"
            value={format}
            onChange={(event) => setFormat(event.target.value)}
            disabled={isBusy}
          >
            <option value="auto">Auto (recommended)</option>
            <option value="jpeg">JPEG</option>
            <option value="webp">WebP</option>
            <option value="avif">AVIF</option>
            <option value="png">PNG</option>
          </select>
        </label>

        <label className="asset-optimize-field" htmlFor="asset-optimize-quality">
          <span className="asset-optimize-label">Compression level</span>
          <input
            id="asset-optimize-quality"
            className="asset-optimize-range"
            type="range"
            min={1}
            max={100}
            step={1}
            value={quality}
            onChange={(event) => setQuality(Number(event.target.value))}
            disabled={isBusy}
          />
          <span className="asset-optimize-value">{quality}</span>
        </label>

        <label className="asset-optimize-field" htmlFor="asset-optimize-scale">
          <span className="asset-optimize-label">Scaling</span>
          <input
            id="asset-optimize-scale"
            className="asset-optimize-range"
            type="range"
            min={10}
            max={100}
            step={1}
            value={scalePercent}
            onChange={(event) => setScalePercent(Number(event.target.value))}
            disabled={isBusy}
          />
          <span className="asset-optimize-value">{scalePercent}%</span>
        </label>

        <div className="asset-optimize-actions">
          <button
            type="button"
            className="asset-optimize-button"
            onClick={onClose}
            disabled={isBusy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="asset-optimize-button asset-optimize-button--auto"
            onClick={() => onAutoOptimize?.()}
            disabled={isBusy || !asset?.path}
          >
            {isAutoOptimizing ? 'Auto Optimizing…' : 'Auto Optimize'}
          </button>
          <button
            type="button"
            className="asset-optimize-button asset-optimize-button--primary"
            onClick={() => onManualOptimize?.({ quality, scalePercent, format })}
            disabled={isBusy || !asset?.path}
          >
            {isManualOptimizing ? 'Optimizing…' : 'Optimize'}
          </button>
        </div>
      </div>
    </SettingsModal>
  );
};

export default AssetOptimizeModal;
