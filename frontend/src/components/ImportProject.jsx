import React, { useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import './ImportProject.css';

const FRONTEND_LANGUAGES = ['javascript', 'typescript'];

const BACKEND_LANGUAGES = ['javascript', 'typescript', 'python', 'java', 'csharp', 'go', 'rust', 'php', 'ruby', 'swift'];

const FRONTEND_FRAMEWORKS = {
  javascript: ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vite'],
  typescript: ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vite']
};

const BACKEND_FRAMEWORKS = {
  javascript: ['express', 'nestjs', 'fastify', 'koa', 'hapi'],
  typescript: ['express', 'nestjs', 'fastify', 'koa', 'hapi'],
  python: ['django', 'flask', 'fastapi', 'pyramid', 'tornado'],
  java: ['spring', 'springboot', 'hibernate', 'struts', 'jsf'],
  csharp: ['aspnet', 'aspnetcore', 'mvc', 'webapi', 'blazor'],
  go: ['gin', 'echo', 'fiber', 'gorilla', 'chi'],
  rust: ['actix', 'warp', 'rocket', 'axum', 'tide'],
  php: ['laravel', 'symfony', 'codeigniter', 'zend', 'cakephp'],
  ruby: ['rails', 'sinatra', 'padrino', 'hanami', 'grape'],
  swift: ['vapor', 'perfect', 'kitura', 'swiftnio']
};

export const resolveFrontendFrameworks = (language) => FRONTEND_FRAMEWORKS[language] || ['none'];

export const resolveBackendFrameworks = (language) => BACKEND_FRAMEWORKS[language] || ['none'];

const SUPPORTED_IMPORT_METHODS = ['folder', 'git', 'zip'];

const sanitizeImportMethod = (method) => (SUPPORTED_IMPORT_METHODS.includes(method) ? method : 'folder');

const ImportProject = ({ initialImportMethod = 'folder' } = {}) => {
  const { importProject, selectProject, showMain } = useAppState();
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState('');
  const [importMethod, setImportMethod] = useState(sanitizeImportMethod(initialImportMethod));
  
  // Import form state
  const [importData, setImportData] = useState({
    name: '',
    description: '',
    path: '',
    gitUrl: '',
    frontend: {
      language: 'javascript',
      framework: 'react'
    },
    backend: {
      language: 'javascript',
      framework: 'express'
    }
  });

  const frontendLanguages = FRONTEND_LANGUAGES;
  const backendLanguages = BACKEND_LANGUAGES;

  const handleImportProject = async (e) => {
    e.preventDefault();
    
    if (!importData.name.trim()) {
      setImportError('Project name is required');
      return;
    }

    if (importMethod === 'folder' && !importData.path.trim()) {
      setImportError('Project path is required');
      return;
    }

    if (importMethod === 'git' && !importData.gitUrl.trim()) {
      setImportError('Git repository URL is required');
      return;
    }

    try {
      setImportLoading(true);
      setImportError('');
      const trimmedName = importData.name.trim();
      const trimmedDescription = importData.description.trim();
      const trimmedPath = importData.path.trim();
      const trimmedGitUrl = importData.gitUrl.trim();
      
      // TODO: Implement actual import logic
      const projectData = {
        name: trimmedName,
        description: trimmedDescription,
        frontend: {
          language: importData.frontend.language,
          framework: importData.frontend.framework
        },
        backend: {
          language: importData.backend.language,
          framework: importData.backend.framework
        },
        importMethod,
        source: importMethod === 'git' ? trimmedGitUrl : trimmedPath,
        createdAt: new Date().toISOString()
      };

      const newProject = await importProject(projectData);
      selectProject(newProject);
      showMain();
    } catch (err) {
      setImportError(err.message || 'Failed to import project');
    } finally {
      setImportLoading(false);
    }
  };

  const handleCancel = () => {
    setImportError('');
    setImportData({
      name: '',
      description: '',
      path: '',
      gitUrl: '',
      frontend: {
        language: 'javascript',
        framework: 'react'
      },
      backend: {
        language: 'javascript',
        framework: 'express'
      }
    });
    showMain();
  };

  const getAvailableFrontendFrameworks = () => resolveFrontendFrameworks(importData.frontend.language);

  const getAvailableBackendFrameworks = () => resolveBackendFrameworks(importData.backend.language);

  const handleFolderSelect = () => {
    // TODO: Implement folder selection dialog
    setImportError('Folder selection not yet implemented');
  };

  return (
    <div className="import-project-view">
      <div className="import-project-container">
        <div className="import-project-header">
          <button onClick={handleCancel} className="back-btn">
            ← Back to Projects
          </button>
          <h1>Import Existing Project</h1>
          <p>Import an existing project from your local machine or a Git repository.</p>
        </div>

        <div className="import-project-form">
          <form onSubmit={handleImportProject} role="form">
            <div className="form-section">
              <h3>Import Method</h3>
              <div className="import-methods">
                <label className={`import-method ${importMethod === 'folder' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="importMethod"
                    value="folder"
                    checked={importMethod === 'folder'}
                    onChange={(e) => setImportMethod(e.target.value)}
                  />
                  <div className="method-icon">📁</div>
                  <div className="method-info">
                    <h4>Local Folder</h4>
                    <p>Import from a folder on your computer</p>
                  </div>
                </label>

                <label className={`import-method ${importMethod === 'git' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="importMethod"
                    value="git"
                    checked={importMethod === 'git'}
                    onChange={(e) => setImportMethod(e.target.value)}
                  />
                  <div className="method-icon">🔗</div>
                  <div className="method-info">
                    <h4>Git Repository</h4>
                    <p>Clone from GitHub, GitLab, or other Git hosts</p>
                  </div>
                </label>

                <label className={`import-method ${importMethod === 'zip' ? 'selected' : ''} disabled`}>
                  <input
                    type="radio"
                    name="importMethod"
                    value="zip"
                    checked={importMethod === 'zip'}
                    onChange={(e) => setImportMethod(e.target.value)}
                    disabled
                  />
                  <div className="method-icon">📦</div>
                  <div className="method-info">
                    <h4>ZIP Archive</h4>
                    <p>Import from a ZIP file (Coming Soon)</p>
                  </div>
                </label>
              </div>
            </div>

            <div className="form-section">
              <h3>Project Source</h3>
              {importMethod === 'folder' && (
                <div className="form-group">
                  <label htmlFor="project-path">Project Folder Path *</label>
                  <div className="path-input-group">
                    <input
                      id="project-path"
                      type="text"
                      placeholder="Select or enter the path to your project folder"
                      value={importData.path}
                      onChange={(e) => setImportData(prev => ({ ...prev, path: e.target.value }))}
                      className="form-input"
                      disabled={importLoading}
                    />
                    <button
                      type="button"
                      onClick={handleFolderSelect}
                      className="browse-btn"
                      disabled={importLoading}
                    >
                      Browse
                    </button>
                  </div>
                </div>
              )}

              {importMethod === 'git' && (
                <div className="form-group">
                  <label htmlFor="git-url">Git Repository URL *</label>
                  <input
                    id="git-url"
                    type="url"
                    placeholder="https://github.com/username/repository.git"
                    value={importData.gitUrl}
                    onChange={(e) => setImportData(prev => ({ ...prev, gitUrl: e.target.value }))}
                    className="form-input"
                    disabled={importLoading}
                  />
                </div>
              )}
            </div>

            <div className="form-section">
              <h3>Project Details</h3>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="project-name">Project Name *</label>
                  <input
                    id="project-name"
                    type="text"
                    placeholder="Enter project name"
                    value={importData.name}
                    onChange={(e) => setImportData(prev => ({ ...prev, name: e.target.value }))}
                    className="form-input"
                    disabled={importLoading}
                  />
                </div>
                
                <div className="form-group">
                  <label htmlFor="project-description">Description</label>
                  <input
                    id="project-description"
                    type="text"
                    placeholder="Brief description of your project"
                    value={importData.description}
                    onChange={(e) => setImportData(prev => ({ ...prev, description: e.target.value }))}
                    className="form-input"
                    disabled={importLoading}
                  />
                </div>
              </div>
            </div>

            <div className="form-section">
              <h3>Frontend Technology</h3>
              <div className="form-row">
                <div className="form-group">
                  <label htmlFor="frontend-language-select">Frontend Language *</label>
                  <select
                    id="frontend-language-select"
                    value={importData.frontend.language}
                    onChange={(e) => setImportData(prev => ({ 
                      ...prev, 
                      frontend: {
                        ...prev.frontend,
                        language: e.target.value,
                        framework: resolveFrontendFrameworks(e.target.value)[0]
                      }
                    }))}
                    className="form-select"
                    disabled={importLoading}
                  >
                    {frontendLanguages.map(lang => (
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
                    value={importData.frontend.framework}
                    onChange={(e) => setImportData(prev => ({ 
                      ...prev, 
                      frontend: { ...prev.frontend, framework: e.target.value }
                    }))}
                    className="form-select"
                    disabled={importLoading}
                  >
                    {getAvailableFrontendFrameworks().map(framework => (
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
                    value={importData.backend.language}
                    onChange={(e) => setImportData(prev => ({ 
                      ...prev, 
                      backend: {
                        ...prev.backend,
                        language: e.target.value,
                        framework: resolveBackendFrameworks(e.target.value)[0]
                      }
                    }))}
                    className="form-select"
                    disabled={importLoading}
                  >
                    {backendLanguages.map(lang => (
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
                    value={importData.backend.framework}
                    onChange={(e) => setImportData(prev => ({ 
                      ...prev, 
                      backend: { ...prev.backend, framework: e.target.value }
                    }))}
                    className="form-select"
                    disabled={importLoading}
                  >
                    {getAvailableBackendFrameworks().map(framework => (
                      <option key={framework} value={framework}>
                        {framework.charAt(0).toUpperCase() + framework.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {importError && (
              <div className="error-message">
                {importError}
              </div>
            )}

            <div className="form-actions">
              <button
                type="button"
                onClick={handleCancel}
                className="cancel-btn"
                disabled={importLoading}
              >
                Cancel
              </button>
              
              <button
                type="submit"
                className="import-btn"
                disabled={importLoading || !importData.name.trim() || 
                  (importMethod === 'folder' && !importData.path.trim()) ||
                  (importMethod === 'git' && !importData.gitUrl.trim())}
              >
                {importLoading ? 'Importing Project...' : 'Import Project'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default ImportProject;