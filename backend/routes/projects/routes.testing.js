import {
  getProject,
  getTestingSettings,
  getProjectTestingSettings,
  saveProjectTestingSettings
} from '../../database.js';

const ALLOWED_COVERAGE_TARGETS = new Set([50, 60, 70, 80, 90, 100]);
const COVERAGE_TARGET_ERROR = 'coverageTarget must be one of 50, 60, 70, 80, 90, 100';

const normalizeCoverageTarget = (value) => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    return null;
  }
  return ALLOWED_COVERAGE_TARGETS.has(numeric) ? numeric : null;
};

const normalizeScopePayload = (scopePayload) => {
  if (scopePayload == null) {
    return {
      mode: 'global',
      coverageTarget: null
    };
  }

  const useGlobal = Boolean(scopePayload?.useGlobal);
  if (useGlobal) {
    return {
      mode: 'global',
      coverageTarget: null
    };
  }

  const coverageTarget = normalizeCoverageTarget(scopePayload?.coverageTarget);
  if (!coverageTarget) {
    return { error: COVERAGE_TARGET_ERROR };
  }

  return {
    mode: 'custom',
    coverageTarget
  };
};

const buildScopeResponse = (scope = {}, globalCoverageTarget = 100) => {
  const mode = scope?.mode === 'custom' ? 'custom' : 'global';
  return {
    mode,
    coverageTarget: mode === 'custom' ? scope?.coverageTarget ?? null : null,
    effectiveCoverageTarget: Number.isInteger(scope?.effectiveCoverageTarget)
      ? scope.effectiveCoverageTarget
      : globalCoverageTarget
  };
};

const buildSettingsResponse = (settings = {}, globalSettings = {}) => {
  const globalCoverageTarget = Number.isInteger(globalSettings?.coverageTarget)
    ? globalSettings.coverageTarget
    : 100;

  const frontend = buildScopeResponse(settings?.frontend, globalCoverageTarget);
  const backend = buildScopeResponse(settings?.backend, globalCoverageTarget);

  return {
    settings: {
      frontend,
      backend
    },
    inheritsFromGlobal: {
      frontend: frontend.mode === 'global',
      backend: backend.mode === 'global'
    }
  };
};

export const registerProjectTestingRoutes = (router) => {
  router.get('/:id/testing-settings', async (req, res) => {
    const projectId = req.params.id;

    try {
      const project = await getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const globalSettings = await getTestingSettings();
      const projectSettings = await getProjectTestingSettings(projectId);
      const response = buildSettingsResponse(projectSettings, globalSettings);

      return res.json({
        success: true,
        ...response
      });
    } catch (error) {
      console.error('Failed to fetch project testing settings:', error);
      return res.status(500).json({ success: false, error: 'Failed to fetch project testing settings' });
    }
  });

  router.put('/:id/testing-settings', async (req, res) => {
    const projectId = req.params.id;
    const payload = req.body || {};

    if (
      !Object.prototype.hasOwnProperty.call(payload, 'frontend')
      && !Object.prototype.hasOwnProperty.call(payload, 'backend')
    ) {
      return res.status(400).json({ success: false, error: 'At least one scope (frontend/backend) is required' });
    }

    try {
      const project = await getProject(projectId);
      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      const update = {};

      if (Object.prototype.hasOwnProperty.call(payload, 'frontend')) {
        const normalized = normalizeScopePayload(payload.frontend);
        if (normalized.error) {
          return res.status(400).json({ success: false, error: normalized.error });
        }
        update.frontendMode = normalized.mode;
        update.frontendCoverageTarget = normalized.coverageTarget;
      }

      if (Object.prototype.hasOwnProperty.call(payload, 'backend')) {
        const normalized = normalizeScopePayload(payload.backend);
        if (normalized.error) {
          return res.status(400).json({ success: false, error: normalized.error });
        }
        update.backendMode = normalized.mode;
        update.backendCoverageTarget = normalized.coverageTarget;
      }

      await saveProjectTestingSettings(projectId, update);

      const globalSettings = await getTestingSettings();
      const projectSettings = await getProjectTestingSettings(projectId);
      const response = buildSettingsResponse(projectSettings, globalSettings);

      return res.json({
        success: true,
        ...response
      });
    } catch (error) {
      console.error('Failed to save project testing settings:', error);
      return res.status(500).json({ success: false, error: 'Failed to save project testing settings' });
    }
  });
};
