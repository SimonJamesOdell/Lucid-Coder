import React, { useLayoutEffect, useState } from 'react';
import SettingsModal from './SettingsModal';
import './TestingSettingsModal.css';

const defaultSettings = {
  coverageTarget: 100
};

const MIN_COVERAGE_TARGET = 50;
const MAX_COVERAGE_TARGET = 100;
const COVERAGE_STEP = 10;

const TestingSettingsModal = ({ isOpen, onClose, settings = defaultSettings, onSave }) => {
  const [coverageTarget, setCoverageTarget] = useState(defaultSettings.coverageTarget);

  useLayoutEffect(() => {
    if (isOpen) {
      setCoverageTarget(Number(settings.coverageTarget) || defaultSettings.coverageTarget);
    }
  }, [isOpen, settings]);

  if (!isOpen) {
    return null;
  }

  const handleSubmit = (event) => {
    event.preventDefault();
    onSave({ coverageTarget });
  };

  return (
    <SettingsModal
      isOpen={isOpen}
      onClose={onClose}
      title="Configure Testing"
      subtitle="Control how strict the global test gate is for coverage."
      testId="testing-settings-modal"
      closeTestId="testing-settings-close"
      titleId="testing-settings-title"
      panelClassName="testing-settings-panel"
      closeLabel="Close testing settings"
    >
      <form onSubmit={handleSubmit} className="testing-settings-form" data-testid="testing-settings-form">
        <label className="testing-settings-label" htmlFor="testing-coverage-target">
          Coverage confidence target
        </label>

        <div className="testing-settings-slider-row">
          <input
            id="testing-coverage-target"
            type="range"
            min={MIN_COVERAGE_TARGET}
            max={MAX_COVERAGE_TARGET}
            step={COVERAGE_STEP}
            value={coverageTarget}
            onChange={(event) => setCoverageTarget(Number(event.target.value))}
            data-testid="testing-coverage-slider"
          />
          <span className="testing-settings-value" data-testid="testing-coverage-value">{coverageTarget}%</span>
        </div>

        <p className="testing-settings-hint" data-testid="testing-settings-hint">
          Lower values use fewer tokens and finish faster, but provide less confidence. Higher values increase confidence while using more tokens and taking more time.
        </p>

        <div className="testing-settings-footer">
          <button
            type="button"
            className="git-settings-button secondary"
            onClick={onClose}
            data-testid="testing-settings-cancel"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="git-settings-button primary"
            data-testid="testing-settings-save"
          >
            Save settings
          </button>
        </div>
      </form>
    </SettingsModal>
  );
};

export default TestingSettingsModal;
