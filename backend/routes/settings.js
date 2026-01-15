import express from 'express';
import { getGitSettings, saveGitSettings, getPortSettings, savePortSettings } from '../database.js';
import { resolveCoveragePolicy, DEFAULT_COVERAGE_THRESHOLDS } from '../constants/coveragePolicy.js';
import { DEFAULT_CHANGE_SCOPE_POLICY } from '../constants/changeScopePolicy.js';
import { DEFAULT_DONE_SIGNALS } from '../constants/doneSignals.js';

const router = express.Router();

const allowedWorkflows = ['local', 'cloud'];
const allowedProviders = ['github', 'gitlab'];
const MIN_PORT = 1024;
const MAX_PORT = 65535;

const normalizeString = (value = '') => (typeof value === 'string' ? value.trim() : '');
const normalizePort = (value) => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    return null;
  }
  if (numeric < MIN_PORT || numeric > MAX_PORT) {
    return null;
  }
  return numeric;
};

export const validateGitSettingsPayload = (payload = {}) => {
  const errors = [];
  const nextSettings = {};

  const workflow = (payload.workflow || 'local').toLowerCase();
  if (!allowedWorkflows.includes(workflow)) {
    errors.push('workflow must be either "local" or "cloud"');
  } else {
    nextSettings.workflow = workflow;
  }

  const provider = (payload.provider || 'github').toLowerCase();
  if (workflow === 'cloud' && !allowedProviders.includes(provider)) {
    errors.push('provider must be one of: GitHub, GitLab');
  } else {
    nextSettings.provider = provider;
  }

  nextSettings.remoteUrl = normalizeString(payload.remoteUrl);
  if (workflow === 'cloud' && !nextSettings.remoteUrl) {
    errors.push('remoteUrl is required when workflow is cloud');
  }

  nextSettings.username = normalizeString(payload.username);
  nextSettings.defaultBranch = normalizeString(payload.defaultBranch) || 'main';
  nextSettings.autoPush = Boolean(payload.autoPush);
  nextSettings.useCommitTemplate = Boolean(payload.useCommitTemplate);
  nextSettings.commitTemplate = nextSettings.useCommitTemplate
    ? normalizeString(payload.commitTemplate)
    : '';

  if (nextSettings.useCommitTemplate && !nextSettings.commitTemplate) {
    errors.push('commitTemplate is required when useCommitTemplate is enabled');
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'token')) {
    nextSettings.token = typeof payload.token === 'string' ? payload.token : '';
  }

  return { errors, nextSettings };
};

export const validatePortSettingsPayload = (payload = {}) => {
  const errors = [];
  const nextSettings = {};

  const frontend = normalizePort(payload.frontendPortBase);
  if (!frontend) {
    errors.push(`frontendPortBase must be an integer between ${MIN_PORT} and ${MAX_PORT}`);
  } else {
    nextSettings.frontendPortBase = frontend;
  }

  const backend = normalizePort(payload.backendPortBase);
  if (!backend) {
    errors.push(`backendPortBase must be an integer between ${MIN_PORT} and ${MAX_PORT}`);
  } else {
    nextSettings.backendPortBase = backend;
  }

  return { errors, nextSettings };
};

router.get('/git', async (req, res) => {
  try {
    const settings = await getGitSettings();
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Failed to load git settings:', error);
    res.status(500).json({ success: false, error: 'Failed to load git settings' });
  }
});

export const putGitSettingsHandler = async (req, res) => {
  const { errors, nextSettings } = validateGitSettingsPayload(req.body || {});
  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: errors.join(', ') });
  }

  try {
    const saved = await saveGitSettings(nextSettings);
    res.json({ success: true, message: 'Git settings updated', settings: saved });
  } catch (error) {
    console.error('Failed to save git settings:', error);
    res.status(500).json({ success: false, error: 'Failed to save git settings' });
  }
};

router.put('/git', putGitSettingsHandler);

router.get('/ports', async (req, res) => {
  try {
    const settings = await getPortSettings();
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Failed to load port settings:', error);
    res.status(500).json({ success: false, error: 'Failed to load port settings' });
  }
});

export const putPortSettingsHandler = async (req, res) => {
  const { errors, nextSettings } = validatePortSettingsPayload(req.body || {});
  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: errors.join(', ') });
  }

  try {
    const saved = await savePortSettings(nextSettings);
    res.json({ success: true, message: 'Port settings updated', settings: saved });
  } catch (error) {
    console.error('Failed to save port settings:', error);
    res.status(500).json({ success: false, error: 'Failed to save port settings' });
  }
};

router.put('/ports', putPortSettingsHandler);

router.get('/policy', async (req, res) => {
  try {
    const coverage = resolveCoveragePolicy({});
    res.json({
      success: true,
      policy: {
        coverage,
        changeScope: DEFAULT_CHANGE_SCOPE_POLICY,
        defaults: {
          coverageThresholds: DEFAULT_COVERAGE_THRESHOLDS,
          enforceChangedFileCoverage: true,
          changeScope: DEFAULT_CHANGE_SCOPE_POLICY
        }
      }
    });
  } catch (error) {
    console.error('Failed to resolve policy defaults:', error);
    res.status(500).json({ success: false, error: 'Failed to resolve policy defaults' });
  }
});

router.get('/done-signals', (req, res) => {
  res.json({ success: true, doneSignals: DEFAULT_DONE_SIGNALS });
});

export default router;
