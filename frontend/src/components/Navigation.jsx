import React, { useEffect, useState } from 'react';
import { useAppState } from '../context/AppStateContext';
import Dropdown, { DropdownItem, DropdownDivider, DropdownLabel } from './Dropdown';
import sunIcon from '../assets/icon-theme-sun.svg';
import moonIcon from '../assets/icon-theme-moon.svg';
import GitSettingsModal from './GitSettingsModal';
import PortSettingsModal from './PortSettingsModal';
import LLMConfigModal from './LLMConfigModal';
import CleanUpToolModal from './CleanUpToolModal';
import RefactorToolModal from './RefactorToolModal';
import AddTestsToolModal from './AddTestsToolModal';
import AuditSecurityToolModal from './AuditSecurityToolModal';
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
    showCreateProject,
    showImportProject,
    toggleTheme,
    setPreviewPanelTab,
    gitSettings,
    gitConnectionStatus,
    updateGitSettings,
    testGitConnection,
    registerGitConnectionStatus,
    portSettings,
    updatePortSettings,
    projectShutdownState
  } = useAppState();
  const [isGitSettingsOpen, setGitSettingsOpen] = useState(false);
  const [isPortSettingsOpen, setPortSettingsOpen] = useState(false);
  const [isLLMConfigOpen, setLLMConfigOpen] = useState(false);
  const [isCleanUpToolOpen, setCleanUpToolOpen] = useState(false);
  const [isRefactorToolOpen, setRefactorToolOpen] = useState(false);
  const [isAddTestsToolOpen, setAddTestsToolOpen] = useState(false);
  const [isAuditSecurityToolOpen, setAuditSecurityToolOpen] = useState(false);

  const handleCreateProject = async () => {
    if (currentProject?.id && typeof closeProject === 'function') {
      try {
        await closeProject();
      } catch (error) {
        console.error('Failed to close active project', error);
      }
    }

    if (typeof showCreateProject === 'function') {
      showCreateProject();
    }
  };

  const handleImportProject = () => {
    showImportProject();
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

  useEffect(() => {
    const handleOpenGitSettingsEvent = () => setGitSettingsOpen(true);
    window.addEventListener('lucidcoder:open-git-settings', handleOpenGitSettingsEvent);
    return () => window.removeEventListener('lucidcoder:open-git-settings', handleOpenGitSettingsEvent);
  }, []);

  useEffect(() => {
    const handleOpenCleanUpToolEvent = () => setCleanUpToolOpen(true);
    window.addEventListener('lucidcoder:open-cleanup-tool', handleOpenCleanUpToolEvent);
    return () => window.removeEventListener('lucidcoder:open-cleanup-tool', handleOpenCleanUpToolEvent);
  }, []);

  const handleCloseGitSettings = () => {
    setGitSettingsOpen(false);
  };

  const handleClosePortSettings = () => {
    setPortSettingsOpen(false);
  };

  const handleSaveGitSettings = async (nextSettings, options) => {
    const keepOpen = /* c8 ignore next */ options?.keepOpen === true;
    try {
      await updateGitSettings(nextSettings);
      if (!keepOpen) {
        setGitSettingsOpen(false);
      }
    } catch (error) {
      console.error('Failed to update git settings', error);
      alert(error?.message || 'Failed to update git settings. Please try again.');
    }
  };

  const handleTestGitConnection = async (options = {}) => {
    const result = await testGitConnection(options);
    registerGitConnectionStatus({
      provider: result.provider || /* c8 ignore next */ options.provider || '',
      account: result.account || null,
      message: result.message || 'Connected',
      testedAt: new Date().toISOString()
    });
    return result;
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

  const handleOpenCleanUpTool = () => setCleanUpToolOpen(true);
  const handleOpenRefactorTool = () => setRefactorToolOpen(true);
  const handleOpenAddTestsTool = () => setAddTestsToolOpen(true);
  const handleOpenAuditSecurityTool = () => setAuditSecurityToolOpen(true);

  const handleCloseCleanUpTool = () => setCleanUpToolOpen(false);
  const handleCloseRefactorTool = () => setRefactorToolOpen(false);
  const handleCloseAddTestsTool = () => setAddTestsToolOpen(false);
  const handleCloseAuditSecurityTool = () => setAuditSecurityToolOpen(false);

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
          <DropdownLabel>Select Project</DropdownLabel>

          {projects && projects.length > 0 ? (
            <>
              {projects.map((project) => (
                <DropdownItem
                  key={project.id}
                  className={currentProject?.id === project.id ? 'active' : ''}
                  onClick={() => selectProject(project)}
                >
                  {project.name}
                </DropdownItem>
              ))}
            </>
          ) : (
            <DropdownLabel>No projects available</DropdownLabel>
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
          <DropdownItem onClick={handleOpenCleanUpTool}>
            Clean Up
          </DropdownItem>
          
          <DropdownItem onClick={handleOpenRefactorTool}>
            Refactor
          </DropdownItem>
          
          <DropdownItem onClick={handleOpenAddTestsTool}>
            Add Tests
          </DropdownItem>
          
          <DropdownItem onClick={handleOpenAuditSecurityTool}>
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
        onTestConnection={handleTestGitConnection}
        scope="global"
        settings={gitSettings}
        connectionStatus={gitConnectionStatus}
      />

      <PortSettingsModal
        isOpen={isPortSettingsOpen}
        onClose={handleClosePortSettings}
        onSave={handleSavePortSettings}
        settings={portSettings}
      />

      <LLMConfigModal isOpen={isLLMConfigOpen} onClose={handleCloseLLMConfig} />

      <CleanUpToolModal isOpen={isCleanUpToolOpen} onClose={handleCloseCleanUpTool} />
      <RefactorToolModal isOpen={isRefactorToolOpen} onClose={handleCloseRefactorTool} />
      <AddTestsToolModal isOpen={isAddTestsToolOpen} onClose={handleCloseAddTestsTool} />
      <AuditSecurityToolModal isOpen={isAuditSecurityToolOpen} onClose={handleCloseAuditSecurityTool} />
    </nav>
  );
};

export default Navigation;