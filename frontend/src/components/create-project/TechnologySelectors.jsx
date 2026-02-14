import React from 'react';

const TechnologySelectors = ({
  createLoading,
  projectSource,
  newProject,
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
        <h3>Frontend Technology</h3>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="frontend-language-select">Frontend Language *</label>
            <select
              id="frontend-language-select"
              value={newProject.frontend.language}
              onChange={onFrontendLanguageChange}
              className="form-select"
              disabled={createLoading || projectSource === 'git'}
            >
              {frontendLanguages.map((lang) => (
                <option key={lang} value={lang}>
                  {lang.charAt(0).toUpperCase() + lang.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="frontend-framework-select">Frontend Framework *</label>
            <select
              id="frontend-framework-select"
              value={newProject.frontend.framework}
              onChange={onFrontendFrameworkChange}
              className="form-select"
              disabled={createLoading || projectSource === 'git'}
            >
              {getFrontendFrameworks().map((framework) => (
                <option key={framework} value={framework}>
                  {framework.charAt(0).toUpperCase() + framework.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="form-section">
        <h3>Backend Technology</h3>
        <div className="form-row">
          <div className="form-group">
            <label htmlFor="backend-language-select">Backend Language *</label>
            <select
              id="backend-language-select"
              value={newProject.backend.language}
              onChange={onBackendLanguageChange}
              className="form-select"
              disabled={createLoading || projectSource === 'git'}
            >
              {backendLanguages.map((lang) => (
                <option key={lang} value={lang}>
                  {lang.charAt(0).toUpperCase() + lang.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="backend-framework-select">Backend Framework *</label>
            <select
              id="backend-framework-select"
              value={newProject.backend.framework}
              onChange={onBackendFrameworkChange}
              className="form-select"
              disabled={createLoading || projectSource === 'git'}
            >
              {getBackendFrameworks().map((framework) => (
                <option key={framework} value={framework}>
                  {framework.charAt(0).toUpperCase() + framework.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </>
  );
};

export default TechnologySelectors;
