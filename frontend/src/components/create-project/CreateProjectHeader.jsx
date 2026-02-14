import React from 'react';

const CreateProjectHeader = ({ isProgressBlocking, onCancel }) => {
  return (
    <div className="create-project-header" style={{ display: isProgressBlocking ? 'none' : 'block' }}>
      <div className="create-project-header-row">
        <div>
          <h1>Add Project</h1>
          <p>Create a new project or bring in an existing one.</p>
        </div>
        <button
          type="button"
          className="create-project-close"
          onClick={onCancel}
          aria-label="Close add project"
        >
          &times;
        </button>
      </div>
    </div>
  );
};

export default CreateProjectHeader;
