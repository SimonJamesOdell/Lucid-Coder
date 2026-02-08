import express from 'express';
import path from 'path';
import { getProject } from '../database.js';
import { startJob, listJobsForProject, getJob, cancelJob } from '../services/jobRunner.js';
import { describeBranchCssOnlyStatus } from '../services/branchWorkflow.js';

const router = express.Router({ mergeParams: true });

const TEST_JOB_TYPES = new Set(['frontend:test', 'backend:test']);

const pathExists = async (targetPath) => {
  if (!targetPath) {
    return false;
  }
  try {
    const fs = await import('fs/promises');
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const ensureProjectPath = (project) => {
  if (!project.path) {
    const error = new Error('Project path not found. Please re-import or recreate the project.');
    error.statusCode = 400;
    throw error;
  }
  return project.path;
};

const ensureWorkingDir = async (description, cwd) => {
  const exists = await pathExists(cwd);
  if (!exists) {
    const error = new Error(`${description} not found. Run project creation again or install dependencies.`);
    error.statusCode = 400;
    throw error;
  }
  return cwd;
};

const coercePayloadObject = (payload) => (payload && typeof payload === 'object' ? payload : {});

const requirePackageName = (payload = {}) => {
  const value = typeof payload.packageName === 'string' ? payload.packageName.trim() : '';
  if (!value) {
    throw Object.assign(new Error('packageName is required for this job'), { statusCode: 400 });
  }
  return value;
};

const normalizeVersionTag = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'latest') {
    return '';
  }
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
};

const buildPackageSpecifier = (name, version) => {
  const tag = normalizeVersionTag(version);
  return tag ? `${name}@${tag}` : name;
};

const shouldSaveAsDev = (payload = {}) => Boolean(payload.dev || payload.devDependency || payload.isDev);

const buildInstallArgs = (specifier, { dev = false, action = 'install' } = {}) => {
  const args = [action, specifier];
  if (action === 'install') {
    args.push(dev ? '--save-dev' : '--save');
  } else if (action === 'uninstall') {
    args.push(dev ? '--save-dev' : '--save');
  }
  return args;
};

const buildJobDefinition = async (project, type, payload = {}) => {
  const projectRoot = ensureProjectPath(project);
  const frontendPath = path.join(projectRoot, 'frontend');
  const backendPath = path.join(projectRoot, 'backend');
  const hasFrontendPackage = await pathExists(path.join(frontendPath, 'package.json'));
  const hasBackendPackage = await pathExists(path.join(backendPath, 'package.json'));
  const hasBackendRequirements = await pathExists(path.join(backendPath, 'requirements.txt'));

  switch (type) {
    case 'frontend:install':
      if (!hasFrontendPackage) {
        throw Object.assign(new Error('Frontend package.json not found'), { statusCode: 400 });
      }
      return {
        displayName: 'Install frontend dependencies',
        command: 'npm',
        args: ['install'],
        cwd: await ensureWorkingDir('Frontend workspace', frontendPath)
      };
    case 'frontend:lint':
      if (!hasFrontendPackage) {
        throw Object.assign(new Error('Frontend package.json not found'), { statusCode: 400 });
      }
      return {
        displayName: 'Frontend lint',
        command: 'npm',
        args: ['run', 'lint'],
        cwd: await ensureWorkingDir('Frontend workspace', frontendPath)
      };
    case 'frontend:test':
      if (!hasFrontendPackage) {
        throw Object.assign(new Error('Frontend package.json not found'), { statusCode: 400 });
      }
      return {
        displayName: 'Frontend tests',
        command: 'npm',
        args: ['run', 'test:coverage'],
        cwd: await ensureWorkingDir('Frontend workspace', frontendPath)
      };
    case 'backend:install':
      if (hasBackendPackage) {
        return {
          displayName: 'Install backend dependencies',
          command: 'npm',
          args: ['install'],
          cwd: await ensureWorkingDir('Backend workspace', backendPath)
        };
      }
      if (hasBackendRequirements) {
        return {
          displayName: 'Install backend dependencies',
          command: 'python',
          args: ['-m', 'pip', 'install', '-r', 'requirements.txt'],
          cwd: await ensureWorkingDir('Backend workspace', backendPath)
        };
      }
      throw Object.assign(new Error('Backend dependencies manifest not found'), { statusCode: 400 });
    case 'backend:lint':
      if (hasBackendPackage) {
        return {
          displayName: 'Backend lint',
          command: 'npm',
          args: ['run', 'lint'],
          cwd: await ensureWorkingDir('Backend workspace', backendPath)
        };
      }
      return {
        displayName: 'Backend lint',
        command: 'python',
        args: ['-m', 'flake8'],
        cwd: await ensureWorkingDir('Backend workspace', backendPath)
      };
    case 'backend:test':
      if (hasBackendPackage) {
        return {
          displayName: 'Backend tests',
          command: 'npm',
          args: ['run', 'test:coverage'],
          cwd: await ensureWorkingDir('Backend workspace', backendPath)
        };
      }
      if (hasBackendRequirements) {
        return {
          displayName: 'Backend tests',
          command: 'python',
          args: ['-m', 'pytest'],
          cwd: await ensureWorkingDir('Backend workspace', backendPath)
        };
      }
      throw Object.assign(new Error('Backend test runner not configured'), { statusCode: 400 });
    case 'frontend:add-package': {
      if (!hasFrontendPackage) {
        throw Object.assign(new Error('Frontend package.json not found'), { statusCode: 400 });
      }
      const safePayload = coercePayloadObject(payload);
      const packageName = requirePackageName(safePayload);
      const specifier = buildPackageSpecifier(packageName, safePayload.version);
      const dev = shouldSaveAsDev(safePayload);
      return {
        displayName: `Add ${packageName} to frontend`,
        command: 'npm',
        args: buildInstallArgs(specifier, { dev, action: 'install' }),
        cwd: await ensureWorkingDir('Frontend workspace', frontendPath)
      };
    }
    case 'frontend:remove-package': {
      if (!hasFrontendPackage) {
        throw Object.assign(new Error('Frontend package.json not found'), { statusCode: 400 });
      }
      const safePayload = coercePayloadObject(payload);
      const packageName = requirePackageName(safePayload);
      const specifier = buildPackageSpecifier(packageName);
      const dev = shouldSaveAsDev(safePayload);
      return {
        displayName: `Remove ${packageName} from frontend`,
        command: 'npm',
        args: buildInstallArgs(specifier, { dev, action: 'uninstall' }),
        cwd: await ensureWorkingDir('Frontend workspace', frontendPath)
      };
    }
    case 'backend:add-package': {
      if (!hasBackendPackage) {
        throw Object.assign(new Error('Backend package.json not found (package management is only supported for Node.js backends)'), { statusCode: 400 });
      }
      const safePayload = coercePayloadObject(payload);
      const packageName = requirePackageName(safePayload);
      const specifier = buildPackageSpecifier(packageName, safePayload.version);
      const dev = shouldSaveAsDev(safePayload);
      return {
        displayName: `Add ${packageName} to backend`,
        command: 'npm',
        args: buildInstallArgs(specifier, { dev, action: 'install' }),
        cwd: await ensureWorkingDir('Backend workspace', backendPath)
      };
    }
    case 'backend:remove-package': {
      if (!hasBackendPackage) {
        throw Object.assign(new Error('Backend package.json not found (package management is only supported for Node.js backends)'), { statusCode: 400 });
      }
      const safePayload = coercePayloadObject(payload);
      const packageName = requirePackageName(safePayload);
      const specifier = buildPackageSpecifier(packageName);
      const dev = shouldSaveAsDev(safePayload);
      return {
        displayName: `Remove ${packageName} from backend`,
        command: 'npm',
        args: buildInstallArgs(specifier, { dev, action: 'uninstall' }),
        cwd: await ensureWorkingDir('Backend workspace', backendPath)
      };
    }
    case 'git:status':
      return {
        displayName: 'Git status',
        command: 'git',
        args: ['status', '--short', '--branch'],
        cwd: await ensureWorkingDir('Project workspace', projectRoot)
      };
    case 'git:pull':
      return {
        displayName: 'Git pull',
        command: 'git',
        args: ['pull', '--ff-only'],
        cwd: await ensureWorkingDir('Project workspace', projectRoot)
      };
    default:
      throw Object.assign(new Error(`Unknown job type: ${type}`), { statusCode: 400 });
  }
};

const serializeJobResponse = (job) => {
  if (!job) {
    return null;
  }
  const payload = {
    id: job.id,
    type: job.type,
    displayName: job.displayName,
    status: job.status,
    command: job.command,
    args: job.args,
    cwd: job.cwd,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    exitCode: job.exitCode,
    signal: job.signal,
    logs: job.logs
  };
  if (job.summary) {
    payload.summary = job.summary;
  }
  return payload;
};

router.post('/', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { type, payload } = req.body || {};

    if (!type) {
      return res.status(400).json({ success: false, error: 'Job type is required' });
    }

    const project = await getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const payloadObject = payload && typeof payload === 'object' ? payload : {};
    const branchName = typeof payloadObject.branchName === 'string' ? payloadObject.branchName.trim() : '';

    if (TEST_JOB_TYPES.has(type)) {
      try {
        const cssStatus = await describeBranchCssOnlyStatus(project.id, branchName || undefined);
        if (cssStatus?.isCssOnly) {
          return res.status(202).json({
            success: true,
            skipped: true,
            reason: 'css-only-branch',
            branch: cssStatus.branch || null,
            indicator: cssStatus.indicator || null
          });
        }
      } catch (cssError) {
        console.warn('[JobsRoute] Failed to evaluate css-only status before starting tests', cssError);
      }
    }

    const definition = await buildJobDefinition(project, type, payload);
    const job = startJob({ projectId: project.id, type, ...definition });

    res.status(202).json({ success: true, job: serializeJobResponse(job) });
  } catch (error) {
    const status = error.statusCode || 500;
    console.error('Error starting job:', error.message);
    res.status(status).json({ success: false, error: error.message || 'Failed to start job' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const jobs = listJobsForProject(project.id).map(serializeJobResponse);
    res.json({ success: true, jobs });
  } catch (error) {
    console.error('Error listing jobs:', error);
    res.status(500).json({ success: false, error: 'Failed to list jobs' });
  }
});

router.get('/:jobId', async (req, res) => {
  try {
    const { projectId, jobId } = req.params;
    const project = await getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const job = getJob(jobId);
    if (!job || job.projectId !== project.id) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    res.json({ success: true, job: serializeJobResponse(job) });
  } catch (error) {
    console.error('Error fetching job:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch job' });
  }
});

router.post('/:jobId/cancel', async (req, res) => {
  try {
    const { projectId, jobId } = req.params;
    const project = await getProject(projectId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const job = getJob(jobId);
    if (!job || job.projectId !== project.id) {
      return res.status(404).json({ success: false, error: 'Job not found' });
    }

    const cancelled = cancelJob(jobId);
    res.json({ success: true, job: serializeJobResponse(cancelled) });
  } catch (error) {
    console.error('Error cancelling job:', error);
    res.status(500).json({ success: false, error: 'Failed to cancel job' });
  }
});

export default router;
export const __testables = { pathExists, buildInstallArgs };
