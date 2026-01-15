import path from 'path';
import { hasUnsafeCommandCharacters } from './cleanup.js';
import { buildFileTree as buildFileTreeCore } from './fileTree.js';

let cachedFsModule = null;
let fsModuleOverride = null;

export async function getFsModule() {
  if (fsModuleOverride) {
    return fsModuleOverride;
  }
  if (!cachedFsModule) {
    cachedFsModule = await import('fs/promises');
  }
  return cachedFsModule;
}

export function setFsModuleOverride(module) {
  fsModuleOverride = module;
}

export function resetFsModuleOverride() {
  fsModuleOverride = null;
}

export const buildFileTree = (dirPath, relativePath = '') =>
  buildFileTreeCore(dirPath, relativePath, { getFsModule });

export const attachTestErrorDetails = (error, target) => {
  if (process.env.NODE_ENV !== 'test' || !target) {
    return;
  }
  target.details = error?.message || 'Unknown error';
  if (error?.stack) {
    target.stack = error.stack;
  }
};

export const buildProjectUpdatePayload = (input = {}) => ({
  name: (input.name || '').trim(),
  description: input.description?.trim() || '',
  language: input.language || 'javascript',
  framework: input.framework || 'react',
  path: input.path || null
});

export const extractFileContentFromRequest = (body) => {
  if (body && typeof body.content === 'string') {
    return body.content;
  }
  return undefined;
};

export const normalizeRepoPath = (value) => String(value ?? '')
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .trim();

export const isSensitiveRepoPath = (value) => {
  const normalized = normalizeRepoPath(value);
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  const segments = lower.split('/').filter(Boolean);
  const basename = segments[segments.length - 1] || '';

  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (basename === '.npmrc' || basename === '.pypirc') return true;
  if (basename === 'id_rsa' || basename === 'id_dsa' || basename === 'id_ed25519') return true;

  if (segments.includes('.ssh')) return true;

  if (segments[0] === '.aws' && segments[1] === 'credentials') return true;

  return false;
};

const isTruthyConfirmationValue = (value) => {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase() === 'true';
};

export const isDestructiveOperationConfirmed = (req) => {
  if (!req) return false;
  if (isTruthyConfirmationValue(req.body?.confirm)) return true;
  if (isTruthyConfirmationValue(req.query?.confirm)) return true;

  const headerValue = req.get?.('x-confirm-destructive') ?? req.headers?.['x-confirm-destructive'];
  return isTruthyConfirmationValue(headerValue);
};

export const requireDestructiveConfirmation = (req, res, { errorMessage = 'Confirmation required' } = {}) => {
  if (isDestructiveOperationConfirmed(req)) {
    return false;
  }

  res.status(409).json({ success: false, error: errorMessage });
  return true;
};

export const isUnsafeRelativePath = (value) => {
  if (!value) {
    return true;
  }

  // Prevent path traversal and absolute paths
  if (value.includes('..') || path.isAbsolute(value)) {
    return true;
  }

  return false;
};

export const isPathWithinRoot = (rootPath, candidatePath) => {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

export const assertNoSymlinkSegments = async (fs, projectRoot, resolvedPath, { errorMessage = 'Invalid path' } = {}) => {
  const projectResolved = path.resolve(projectRoot);
  const targetResolved = path.resolve(resolvedPath);

  if (!isPathWithinRoot(projectResolved, targetResolved)) {
    const error = new Error(errorMessage);
    error.statusCode = 400;
    throw error;
  }

  const relative = path.relative(projectResolved, targetResolved);
  if (!relative) {
    return;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  let current = projectResolved;

  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stats = await fs.lstat(current);
      if (typeof stats?.isSymbolicLink === 'function' && stats.isSymbolicLink()) {
        const error = new Error(errorMessage);
        error.statusCode = 400;
        throw error;
      }
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
};

export const resolveProjectRelativePath = (projectRoot, relative) => {
  const normalized = normalizeRepoPath(relative);
  if (isUnsafeRelativePath(normalized)) {
    const error = new Error('Invalid path');
    error.statusCode = 400;
    throw error;
  }

  const fullPath = path.join(projectRoot, normalized);
  const resolvedPath = path.resolve(fullPath);
  const projectResolved = path.resolve(projectRoot);

  if (!isPathWithinRoot(projectResolved, resolvedPath)) {
    const error = new Error('Invalid path');
    error.statusCode = 400;
    throw error;
  }

  // Guard against "C:\\foo" style injection that slips through on Windows.
  if (hasUnsafeCommandCharacters(resolvedPath)) {
    const error = new Error('Invalid path');
    error.statusCode = 400;
    throw error;
  }

  return { normalized, fullPath, resolvedPath, projectResolved };
};
