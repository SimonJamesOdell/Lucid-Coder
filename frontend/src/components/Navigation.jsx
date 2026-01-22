import React, { useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import Dropdown, { DropdownItem, DropdownDivider, DropdownLabel } from './Dropdown';
import sunIcon from '../assets/icon-theme-sun.svg';
import moonIcon from '../assets/icon-theme-moon.svg';
import GitSettingsModal from './GitSettingsModal';
import PortSettingsModal from './PortSettingsModal';
import LLMConfigModal from './LLMConfigModal';
import './Navigation.css';

const Navigation = ({ versionLabel = null }) => {
  const {
    isLLMConfigured,
    currentProject,
    projects,
    canUseProjects,
    canUseTools,
    canUseSettings,
    theme,
    selectProject,
    closeProject,
    createProject,
    importProject,
    toggleTheme,
    setPreviewPanelTab,
    gitSettings,
    updateGitSettings,
    portSettings,
    updatePortSettings,
    projectShutdownState
  } = useAppState();
  const [isGitSettingsOpen, setGitSettingsOpen] = useState(false);
  const [isPortSettingsOpen, setPortSettingsOpen] = useState(false);
  const [isLLMConfigOpen, setLLMConfigOpen] = useState(false);

  const handleCreateProject = async () => {
    const name = prompt('Enter project name:');
    if (name && name.trim()) {
      const description = prompt('Enter project description (optional):') || '';
      try {
        await createProject({ name: name.trim(), description: description.trim() });
        alert('Project created successfully!');
      } catch (error) {
        alert('Failed to create project: ' + error.message);
      }
    }
  };

  const handleImportProject = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          try {
            const projectData = JSON.parse(event.target.result);
            importProject(projectData);
            alert('Project imported successfully!');
          } catch (error) {
            alert('Error importing project: Invalid JSON file');
          }
        };
        reader.readAsText(file);
      }
    };
    input.click();
  };

  const handleConfigureLLM = () => {
    setLLMConfigOpen(true);
  };

  const handleCloseLLMConfig = () => {
    setLLMConfigOpen(false);
  };

  const handleOpenPortSettings = () => {
    setPortSettingsOpen(true);
  };

  const handleOpenGitSettings = () => {
    setGitSettingsOpen(true);
  };

  const handleCloseGitSettings = () => {
    setGitSettingsOpen(false);
  };

  const handleClosePortSettings = () => {
    setPortSettingsOpen(false);
  };

  const handleSaveGitSettings = async (nextSettings) => {
    try {
      await updateGitSettings(nextSettings);
      setGitSettingsOpen(false);
    } catch (error) {
      console.error('Failed to update git settings', error);
      alert('Failed to update git settings. Please try again.');
    }
  };

  const handleSavePortSettings = async (nextSettings) => {
    try {
      await updatePortSettings(nextSettings);
      setPortSettingsOpen(false);
    } catch (error) {
      console.error('Failed to update port settings', error);
      alert(error?.message || 'Failed to update port settings. Please try again.');
    }
  };

  const handleToolAction = (toolName) => {
    alert(`${toolName} tool would execute here`);
  };

  const handleOpenLlmUsage = () => {
    if (typeof setPreviewPanelTab === 'function') {
      setPreviewPanelTab('llm-usage', { source: 'user' });
    }
  };


  const shutdownStatus = projectShutdownState || {};
  const isStoppingCurrentProject = Boolean(
    shutdownStatus.isStopping && currentProject && shutdownStatus.projectId === currentProject.id
  );
  const showShutdownStatus = Boolean(shutdownStatus.isStopping || shutdownStatus.error);

  return (
    <nav className="navigation">
      <div className="nav-left">
        <h1 className="nav-title">Lucid Coder</h1>
        {versionLabel ? (
          <span className="nav-version" data-testid="nav-version">v{versionLabel}</span>
        ) : null}

        <Dropdown 
          title="Projects" 
          disabled={!canUseProjects}
          className="nav-dropdown"
        >
          {projects.length === 0 ? (
            <DropdownLabel>No projects available</DropdownLabel>
          ) : (
            <>
              <DropdownLabel>Select Project:</DropdownLabel>
              {projects.map(project => (
                <DropdownItem 
                  key={project.id}
                  onClick={() => selectProject(project)}
                  className={currentProject?.id === project.id ? 'active' : ''}
                >
                  {project.name}
                </DropdownItem>
              ))}
            </>
          )}
          
          <DropdownDivider />
          
          <DropdownItem onClick={handleCreateProject}>
            Create new project
          </DropdownItem>
          
          <DropdownItem onClick={handleImportProject}>
            Import project
          </DropdownItem>
        </Dropdown>

        <Dropdown 
          title="Settings" 
          disabled={!canUseSettings}
          className="nav-dropdown"
        >
          <DropdownItem onClick={handleConfigureLLM}>
            Configure LLM
          </DropdownItem>

          <DropdownItem onClick={handleOpenGitSettings}>
            Configure Git
          </DropdownItem>
          
          <DropdownItem onClick={handleOpenPortSettings}>
            Ports
          </DropdownItem>
        </Dropdown>

        <Dropdown 
          title="Tools" 
          disabled={!canUseTools}
          className="nav-dropdown"
        >
          <DropdownItem onClick={() => handleToolAction('Clean Up')}>
            Clean Up
          </DropdownItem>
          
          <DropdownItem onClick={() => handleToolAction('Refactor')}>
            Refactor
          </DropdownItem>
          
          <DropdownItem onClick={() => handleToolAction('Add Tests')}>
            Add Tests
          </DropdownItem>
          
          <DropdownItem onClick={() => handleToolAction('Audit Security')}>
            Audit Security
          </DropdownItem>
        </Dropdown>

        <button
          type="button"
          className="dropdown-trigger"
          onClick={handleOpenLlmUsage}
          disabled={!canUseTools}
          data-testid="nav-llm-usage"
        >
          LLM Usage
        </button>
      </div>

      <div className="nav-center">
        <span className="project-title">
          {currentProject ? currentProject.name : 'No Project Selected'}
        </span>
        {currentProject && (
          <button 
            className={`close-project-btn${isStoppingCurrentProject ? ' is-busy' : ''}`} 
            onClick={() => closeProject()}
            title="Close project"
            aria-label="Close project"
            disabled={isStoppingCurrentProject}
            aria-busy={isStoppingCurrentProject}
            data-testid="close-project-button"
          >
            {isStoppingCurrentProject ? <span className="close-project-spinner" aria-hidden="true" /> : '×'}
          </button>
        )}
        {showShutdownStatus && (
          <div
            className={`shutdown-status${shutdownStatus.error ? ' is-error' : ''}`}
            role="status"
            aria-live="polite"
            data-testid="shutdown-status"
          >
            <span className="shutdown-dot" aria-hidden="true" />
            <span>
              {shutdownStatus.isStopping
                ? `Stopping ${shutdownStatus.projectName || 'project'}…`
                : `Stop failed: ${shutdownStatus.error}`}
            </span>
          </div>
        )}
      </div>

      <div className="nav-right">
        <button 
          className="theme-toggle-btn" 
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          <img
            src={theme === 'dark' ? sunIcon : moonIcon}
            alt=""
            aria-hidden="true"
            className="theme-toggle-icon"
          />
        </button>
      </div>

      <GitSettingsModal
        isOpen={isGitSettingsOpen}
        onClose={handleCloseGitSettings}
        onSave={handleSaveGitSettings}
        scope="global"
        settings={gitSettings}
      />

      <PortSettingsModal
        isOpen={isPortSettingsOpen}
        onClose={handleClosePortSettings}
        onSave={handleSavePortSettings}
        settings={portSettings}
      />

      <LLMConfigModal isOpen={isLLMConfigOpen} onClose={handleCloseLLMConfig} />
    </nav>
  );
};

export default Navigation;