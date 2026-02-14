import React from 'react';

const ProjectSourceSection = ({ projectSource, setProjectSource, setCreateError, createLoading }) => {
  const handleSourceChange = (value) => {
    setProjectSource(value);
    setCreateError('');
  };

  return (
    <div className="form-section">
      <h3>Project Source</h3>
      <div className="radio-group">
        <label className={`radio-card ${projectSource === 'new' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="projectSource"
            value="new"
            checked={projectSource === 'new'}
            onChange={() => handleSourceChange('new')}
            disabled={createLoading}
          />
          <div>
            <div className="radio-title">Create a new project</div>
            <div className="radio-subtitle">Scaffold a brand-new app with your chosen tech stack.</div>
          </div>
        </label>
        <label className={`radio-card ${projectSource === 'local' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="projectSource"
            value="local"
            checked={projectSource === 'local'}
            onChange={() => handleSourceChange('local')}
            disabled={createLoading}
          />
          <div>
            <div className="radio-title">Import a local folder</div>
            <div className="radio-subtitle">Bring in an existing project from your machine.</div>
          </div>
        </label>
        <label className={`radio-card ${projectSource === 'git' ? 'selected' : ''}`}>
          <input
            type="radio"
            name="projectSource"
            value="git"
            checked={projectSource === 'git'}
            onChange={() => handleSourceChange('git')}
            disabled={createLoading}
          />
          <div>
            <div className="radio-title">Clone from Git</div>
            <div className="radio-subtitle">Connect an existing repository URL.</div>
          </div>
        </label>
      </div>
    </div>
  );
};

export default ProjectSourceSection;
