import {
  deleteProjectGitSettings,
  getGitSettings,
  getProject,
  getProjectGitSettings,
  saveProjectGitSettings
} from '../../database.js';
import { validateGitSettingsPayload } from '../settings.js';
import { createRemoteRepository, RemoteRepoCreationError } from '../../services/remoteRepoService.js';
import { requireDestructiveConfirmation } from './internals.js';

const SUPPORTED_REMOTE_PROVIDERS = ['github', 'gitlab'];

export function registerProjectGitRoutes(router) {
  router.get('/:projectId/git-settings', async (req, res) => {
    try {
      const { projectId } = req.params;
      const project = await getProject(projectId);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const [projectSettings, globalSettings] = await Promise.all([
        getProjectGitSettings(projectId),
        getGitSettings()
      ]);
      const inheritsFromGlobal = !projectSettings;
      const effectiveSettings = projectSettings || globalSettings;

      res.json({
        success: true,
        inheritsFromGlobal,
        settings: effectiveSettings,
        effectiveSettings,
        projectSettings: projectSettings || null,
        globalSettings
      });
    } catch (error) {
      console.error('Error fetching project git settings:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch project git settings' });
    }
  });

  router.put('/:projectId/git-settings', async (req, res) => {
    const { projectId } = req.params;
    const project = await getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { errors, nextSettings } = validateGitSettingsPayload(req.body || {});
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: errors.join(', ') });
    }

    try {
      const saved = await saveProjectGitSettings(projectId, nextSettings);
      res.json({
        success: true,
        inheritsFromGlobal: false,
        settings: saved,
        effectiveSettings: saved,
        projectSettings: saved
      });
    } catch (error) {
      console.error('Error saving project git settings:', error);
      res.status(500).json({ success: false, error: 'Failed to save project git settings' });
    }
  });

  router.delete('/:projectId/git-settings', async (req, res) => {
    const { projectId } = req.params;
    const project = await getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    if (requireDestructiveConfirmation(req, res)) {
      return;
    }

    try {
      await deleteProjectGitSettings(projectId);
      const globalSettings = await getGitSettings();
      res.json({
        success: true,
        inheritsFromGlobal: true,
        settings: globalSettings,
        effectiveSettings: globalSettings,
        projectSettings: null,
        globalSettings
      });
    } catch (error) {
      console.error('Error clearing project git settings:', error);
      res.status(500).json({ success: false, error: 'Failed to clear project git settings' });
    }
  });

  router.post('/:projectId/git/remotes', async (req, res) => {
    const { projectId } = req.params;
    const project = await getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const payload = req.body || {};
    const provider = (payload.provider || 'github').toLowerCase();
    if (!SUPPORTED_REMOTE_PROVIDERS.includes(provider)) {
      return res.status(400).json({ success: false, error: 'Unsupported git provider' });
    }

    const repoName = (payload.name || project.name || '').trim();
    if (!repoName) {
      return res.status(400).json({ success: false, error: 'Repository name is required' });
    }

    const token = (payload.token || '').trim();
    if (!token) {
      return res.status(400).json({ success: false, error: 'A personal access token is required to create the repository' });
    }

    const visibility = payload.visibility === 'public' ? 'public' : 'private';
    const description = typeof payload.description === 'string'
      ? payload.description.slice(0, 500)
      : '';
    const owner = typeof payload.owner === 'string' ? payload.owner.trim() : '';
    const defaultBranch = typeof payload.defaultBranch === 'string' ? payload.defaultBranch.trim() : '';
    const applySettings = payload.applySettings !== false;

    try {
      const repository = await createRemoteRepository({
        provider,
        token,
        name: repoName,
        visibility,
        description,
        owner,
        projectName: project.name
      });

      let savedSettings = null;
      if (applySettings) {
        const branchName = repository.defaultBranch || defaultBranch || 'main';
        const settingsPayload = {
          workflow: 'cloud',
          provider,
          remoteUrl: repository.remoteUrl,
          defaultBranch: branchName,
          token
        };
        if (payload.username) {
          settingsPayload.username = String(payload.username).trim();
        }
        savedSettings = await saveProjectGitSettings(projectId, settingsPayload);
      }

      let projectSettingsSnapshot = savedSettings;
      let inheritsFromGlobal = false;
      if (!projectSettingsSnapshot) {
        projectSettingsSnapshot = await getProjectGitSettings(projectId);
        if (!projectSettingsSnapshot) {
          projectSettingsSnapshot = await getGitSettings();
          inheritsFromGlobal = true;
        }
      }

      res.json({
        success: true,
        message: 'Remote repository created successfully',
        repository,
        appliedSettings: applySettings,
        inheritsFromGlobal,
        settings: projectSettingsSnapshot,
        effectiveSettings: projectSettingsSnapshot,
        projectSettings: savedSettings || (inheritsFromGlobal ? null : projectSettingsSnapshot)
      });
    } catch (error) {
      if (error instanceof RemoteRepoCreationError) {
        return res.status(error.statusCode || 400).json({
          success: false,
          error: error.message,
          provider: error.provider,
          details: error.details || null
        });
      }
      console.error('Error creating remote repository:', error);
      res.status(500).json({ success: false, error: 'Failed to create remote repository' });
    }
  });
}
