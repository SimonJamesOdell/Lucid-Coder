import express from 'express';
import {
  getGitSettings,
  saveGitSettings,
  getPortSettings,
  savePortSettings,
  getTestingSettings,
  saveTestingSettings
} from '../database.js';
import { resolveCoveragePolicy, DEFAULT_COVERAGE_THRESHOLDS } from '../constants/coveragePolicy.js';
import { DEFAULT_CHANGE_SCOPE_POLICY } from '../constants/changeScopePolicy.js';
import { DEFAULT_DONE_SIGNALS } from '../constants/doneSignals.js';
import { testGitConnection, GitConnectionError } from '../services/gitConnectionService.js';

const router = express.Router();

const allowedWorkflows = ['local', 'cloud'];
const allowedProviders = ['github', 'gitlab'];
const MIN_PORT = 1024;
const MAX_PORT = 65535;
const MIN_COVERAGE_TARGET = 50;
const MAX_COVERAGE_TARGET = 100;

const normalizeString = (value = '') => (typeof value === 'string' ? value.trim() : '');
const normalizeDateString = (value) => (typeof value === 'string' ? value.trim() : '');
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

const normalizeCoverageTarget = (value) => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    return null;
  }
  if (numeric < MIN_COVERAGE_TARGET || numeric > MAX_COVERAGE_TARGET) {
    return null;
  }
  if (numeric % 10 !== 0) {
    return null;
  }
  return numeric;
};

const buildCoverageThresholdsFromTarget = (target) => ({
  lines: target,
  statements: target,
  functions: target,
  branches: target
});

export const validateGitSettingsPayload = (payload = {}, { requireRemoteUrl = true } = {}) => {
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
  if (workflow === 'cloud' && requireRemoteUrl && !nextSettings.remoteUrl) {
    errors.push('remoteUrl is required when workflow is cloud');
  }

  nextSettings.username = normalizeString(payload.username);
  if (Object.prototype.hasOwnProperty.call(payload, 'tokenExpiresAt')) {
    const tokenExpiresAt = normalizeDateString(payload.tokenExpiresAt);
    if (!tokenExpiresAt) {
      nextSettings.tokenExpiresAt = '';
    } else {
      const parsed = Date.parse(tokenExpiresAt);
      if (Number.isNaN(parsed)) {
        errors.push('tokenExpiresAt must be a valid date');
      } else {
        nextSettings.tokenExpiresAt = tokenExpiresAt;
      }
    }
  }
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

export const validateTestingSettingsPayload = (payload = {}) => {
  const errors = [];
  const nextSettings = {};

  const coverageTarget = normalizeCoverageTarget(payload.coverageTarget);
  if (!coverageTarget) {
    errors.push(`coverageTarget must be one of ${MIN_COVERAGE_TARGET}, 60, 70, 80, 90, 100`);
  } else {
    nextSettings.coverageTarget = coverageTarget;
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
  const { errors, nextSettings } = validateGitSettingsPayload(req.body || {}, { requireRemoteUrl: false });
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

router.post('/git/test', async (req, res) => {
  const payload = req.body || {};
  const provider = (payload.provider || 'github').toLowerCase();
  const token = typeof payload.token === 'string' ? payload.token : '';

  try {
    const result = await testGitConnection({ provider, token });
    res.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof GitConnectionError) {
      return res.status(error.statusCode || 400).json({
        success: false,
        error: error.message,
        provider: error.provider,
        details: error.details || null
      });
    }
    console.error('Failed to test git connection:', error);
    res.status(500).json({ success: false, error: 'Failed to test git connection' });
  }
});

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

router.get('/testing', async (req, res) => {
  try {
    const settings = await getTestingSettings();
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Failed to load testing settings:', error);
    res.status(500).json({ success: false, error: 'Failed to load testing settings' });
  }
});

export const putTestingSettingsHandler = async (req, res) => {
  const { errors, nextSettings } = validateTestingSettingsPayload(req.body || {});
  if (errors.length > 0) {
    return res.status(400).json({ success: false, error: errors.join(', ') });
  }

  try {
    const saved = await saveTestingSettings(nextSettings);
    res.json({ success: true, message: 'Testing settings updated', settings: saved });
  } catch (error) {
    console.error('Failed to save testing settings:', error);
    res.status(500).json({ success: false, error: 'Failed to save testing settings' });
  }
};

router.put('/testing', putTestingSettingsHandler);

router.get('/policy', async (req, res) => {
  try {
    const testingSettings = await getTestingSettings();
    const target = normalizeCoverageTarget(testingSettings?.coverageTarget) || DEFAULT_COVERAGE_THRESHOLDS.lines;
    const thresholds = buildCoverageThresholdsFromTarget(target);
    const coverage = resolveCoveragePolicy({
      coverageThresholds: thresholds,
      changedFileCoverageThresholds: thresholds
    });
    res.json({
      success: true,
      policy: {
        coverage,
        testing: {
          coverageTarget: target,
          minCoverageTarget: MIN_COVERAGE_TARGET,
          maxCoverageTarget: MAX_COVERAGE_TARGET,
          step: 10
        },
        changeScope: DEFAULT_CHANGE_SCOPE_POLICY,
        defaults: {
          coverageThresholds: thresholds,
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
