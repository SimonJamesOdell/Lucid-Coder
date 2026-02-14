import React from 'react';
import TechnologySelectors from './TechnologySelectors';

const ProjectDetailsSection = ({
  createLoading,
  projectSource,
  newProject,
  setNewProject,
  createError,
  setCreateError,
  frontendLanguages,
  backendLanguages,
  getFrontendFrameworks,
  getBackendFrameworks,
  onFrontendLanguageChange,
  onFrontendFrameworkChange,
  onBackendLanguageChange,
  onBackendFrameworkChange
}) => {
  return (
    <>
      <div className="form-section">
        <h3>Project Details</h3>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="project-name">Project Name *</label>
            <input
              id="project-name"
              type="text"
              placeholder="Enter project name"
              value={newProject.name}
              onChange={(e) => {
                setNewProject((prev) => ({ ...prev, name: e.target.value }));
                if (createError) {
                  setCreateError('');
                }
              }}
              className="form-input"
              disabled={createLoading}
              autoFocus
            />
          </div>

          <div className="form-group">
            <label htmlFor="project-description">Description</label>
            <input
              id="project-description"
              type="text"
              placeholder="Brief description of your project"
              value={newProject.description}
              onChange={(e) => setNewProject((prev) => ({ ...prev, description: e.target.value }))}
              className="form-input"
              disabled={createLoading}
            />
          </div>
        </div>
      </div>

      <TechnologySelectors
        createLoading={createLoading}
        projectSource={projectSource}
        newProject={newProject}
        frontendLanguages={frontendLanguages}
        backendLanguages={backendLanguages}
        getFrontendFrameworks={getFrontendFrameworks}
        getBackendFrameworks={getBackendFrameworks}
        onFrontendLanguageChange={onFrontendLanguageChange}
        onFrontendFrameworkChange={onFrontendFrameworkChange}
        onBackendLanguageChange={onBackendLanguageChange}
        onBackendFrameworkChange={onBackendFrameworkChange}
      />
    </>
  );
};

export default ProjectDetailsSection;
