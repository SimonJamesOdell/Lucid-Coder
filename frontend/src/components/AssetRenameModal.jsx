import React from 'react';
import SettingsModal from './SettingsModal';
import './AssetRenameModal.css';

const AssetRenameModal = ({
  isOpen,
  assetPath,
  fileName,
  extension,
  value,
  errorMessage,
  isSubmitting = false,
  onClose,
  onChange,
  onSubmit
}) => {
  return (
    <SettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Rename Asset"
      subtitle="Update the asset name while keeping its file extension unchanged."
      testId="asset-rename-modal"
      closeTestId="asset-rename-close"
      titleId="asset-rename-title"
      panelClassName="asset-rename-modal-panel"
      bodyClassName="asset-rename-modal-body"
      closeLabel="Close rename modal"
    >
      <form
        className="asset-rename-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.();
        }}
      >
        <div className="asset-rename-target" title={assetPath || ''}>{assetPath || 'No asset selected'}</div>

        <label className="asset-rename-field" htmlFor="asset-rename-filename">
          <span className="asset-rename-label">Name</span>
          <div className="asset-rename-input-wrap">
            <input
              id="asset-rename-filename"
              className="asset-rename-input"
              type="text"
              value={value}
              placeholder={fileName || 'asset'}
              onChange={(event) => onChange?.(event.target.value)}
              disabled={isSubmitting}
              autoFocus
            />
            {extension ? <span className="asset-rename-extension" data-testid="asset-rename-extension">.{extension}</span> : null}
          </div>
        </label>

        {errorMessage ? (
          <div className="asset-rename-error" data-testid="asset-rename-error">{errorMessage}</div>
        ) : null}

        <div className="asset-rename-actions">
          <button
            type="button"
            className="asset-rename-button"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="asset-rename-button asset-rename-button--primary"
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Renaming…' : 'Rename'}
          </button>
        </div>
      </form>
    </SettingsModal>
  );
};

export default AssetRenameModal;
