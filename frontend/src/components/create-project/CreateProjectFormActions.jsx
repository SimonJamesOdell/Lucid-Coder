import React from 'react';

const resolveSubmitLabel = ({ setupStep, projectSource, createLoading }) => {
  if (setupStep === 'source') {
    return 'Next';
  }

  if (setupStep === 'git') {
    return 'Next';
  }

  if (setupStep === 'compatibility' && projectSource === 'local') {
    return createLoading ? 'Importing Project...' : 'Import Project';
  }

  return createLoading ? 'Creating Project...' : 'Create Project';
};

const CreateProjectFormActions = ({
  setupStep,
  projectSource,
  createLoading,
  handleCancel,
  handleBackToDetails
}) => {
  return (
    <div className="form-actions">
      <button
        type="button"
        onClick={handleCancel}
        className="git-settings-button secondary"
        disabled={createLoading}
      >
        Cancel
      </button>

      {setupStep !== 'source' && (
        <button
          type="button"
          onClick={handleBackToDetails}
          className="git-settings-button secondary"
          disabled={createLoading}
        >
          Back
        </button>
      )}

      <button
        type="submit"
        className="git-settings-button primary"
        disabled={createLoading}
      >
        {resolveSubmitLabel({ setupStep, projectSource, createLoading })}
      </button>
    </div>
  );
};

export default CreateProjectFormActions;
