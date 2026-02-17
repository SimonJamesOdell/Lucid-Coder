import path from 'path';
import sharp from 'sharp';
import { getProject } from '../../database.js';
import { runGitCommand } from '../../utils/git.js';
import { sendAgentUiCommand } from '../../services/agentUiCommands.js';
import { isWithinManagedProjectsRoot } from './cleanup.js';
import {
  buildFileTree,
  assertNoSymlinkSegments,
  extractFileContentFromRequest,
  getFsModule,
  isSensitiveRepoPath,
  normalizeRepoPath,
  resolveProjectRelativePath,
  requireDestructiveConfirmation
} from './internals.js';

export function registerProjectFileRoutes(router) {
  const TRANSMISSION_OPTIMIZED_EXTENSIONS = new Set([
    'avif',
    'webp',
    'jpg',
    'jpeg',
    'png',
    'gif',
    'svg',
    'mp4',
    'webm',
    'mp3',
    'ogg',
    'aac',
    'm4a'
  ]);

  const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif']);

  const isUploadsRepoPath = (repoPath) => {
    const normalized = normalizeRepoPath(repoPath);
    return normalized === 'uploads' || normalized.startsWith('uploads/');
  };

  const stageUploadsPaths = async (projectId, repoPaths = []) => {
    const repoPathList = [].concat(repoPaths);
    const uniqueUploads = Array.from(new Set(
      repoPathList
        .map((candidate) => normalizeRepoPath(candidate))
        .filter((candidate) => candidate && isUploadsRepoPath(candidate))
    ));

    if (uniqueUploads.length === 0) {
      return;
    }

    const { stageWorkspaceChange } = await import('../../services/branchWorkflow.js');

    for (const filePath of uniqueUploads) {
      await stageWorkspaceChange(projectId, {
        filePath,
        source: 'editor'
      });
    }
  };

  const flattenFileTree = (nodes, bucket = []) => {
    if (!Array.isArray(nodes)) {
      return bucket;
    }

    nodes.forEach((node) => {
      if (!node || typeof node !== 'object') {
        return;
      }

      if (node.type === 'file' && typeof node.path === 'string') {
        bucket.push(node);
        return;
      }

      if (Array.isArray(node.children)) {
        flattenFileTree(node.children, bucket);
      }
    });

    return bucket;
  };

  const getExtension = (fileNameOrPath) => {
    if (typeof fileNameOrPath !== 'string') {
      return '';
    }

    const normalized = fileNameOrPath.trim();
    if (!normalized) {
      return '';
    }

    const ext = path.extname(normalized).replace(/^\./, '').toLowerCase();
    return ext;
  };

  const isOptimizedForTransmission = (filePath) => {
    const ext = getExtension(filePath);
    if (!ext) {
      return false;
    }
    return TRANSMISSION_OPTIMIZED_EXTENSIONS.has(ext);
  };

  const normalizeOutputFormat = (value, fallback = 'jpeg') => {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!raw || raw === 'auto') {
      return 'auto';
    }
    if (raw === 'jpg' || raw === 'jpeg') {
      return 'jpeg';
    }
    if (raw === 'png' || raw === 'webp' || raw === 'avif') {
      return raw;
    }
    return fallback;
  };

  const clampNumber = (value, min, max, fallback) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, parsed));
  };

  const deriveAutoOptimizationSettings = ({ width, height, hasAlpha }) => {
    const longestEdge = Math.max(width, height);
    let scalePercent = 100;

    if (longestEdge > 2600) {
      scalePercent = 60;
    } else if (longestEdge > 2000) {
      scalePercent = 70;
    } else if (longestEdge > 1600) {
      scalePercent = 78;
    } else if (longestEdge > 1280) {
      scalePercent = 88;
    }

    return {
      format: hasAlpha ? 'webp' : 'jpeg',
      quality: hasAlpha ? 78 : 76,
      scalePercent
    };
  };

  const analyzeTransmissionOptimization = ({ filePath, sizeBytes, width, height }) => {
    const ext = getExtension(filePath);
    const fallback = isOptimizedForTransmission(filePath);

    if (!IMAGE_EXTENSIONS.has(ext) || !width || !height || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return {
        optimized: fallback,
        reason: fallback ? 'format_allowlisted' : 'insufficient_metadata'
      };
    }

    const pixels = width * height;
    if (!Number.isFinite(pixels) || pixels <= 0) {
      return {
        optimized: fallback,
        reason: fallback ? 'format_allowlisted' : 'invalid_dimensions'
      };
    }

    const bytesPerPixel = sizeBytes / pixels;
    const megapixels = pixels / 1_000_000;

    if (ext === 'png') {
      const optimized = bytesPerPixel <= 0.45 && sizeBytes <= Math.max(420_000, megapixels * 480_000);
      return {
        optimized,
        reason: optimized ? 'png_density_ok' : 'png_density_high',
        bytesPerPixel
      };
    }

    if (ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'avif') {
      const optimized = bytesPerPixel <= 0.3 && sizeBytes <= Math.max(300_000, megapixels * 300_000);
      return {
        optimized,
        reason: optimized ? 'lossy_density_ok' : 'lossy_density_high',
        bytesPerPixel
      };
    }

    if (ext === 'gif') {
      const optimized = sizeBytes <= Math.max(500_000, megapixels * 550_000);
      return {
        optimized,
        reason: optimized ? 'gif_size_ok' : 'gif_size_high',
        bytesPerPixel
      };
    }

    return {
      optimized: fallback,
      reason: fallback ? 'format_allowlisted' : 'unsupported_format'
    };
  };

  const buildUniqueOptimizedPath = async (fs, projectRoot, sourcePath, targetExt) => {
    const normalizedTargetExt = targetExt === 'jpeg' ? 'jpg' : targetExt;
    const directory = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
    const sourceName = sourcePath.split('/').pop() || sourcePath;
    const currentExt = getExtension(sourceName);
    const stem = currentExt ? sourceName.slice(0, -(currentExt.length + 1)) : sourceName;

    const buildCandidate = (suffix = '') => {
      const fileName = `${stem}${suffix}.${normalizedTargetExt}`;
      return directory ? `${directory}/${fileName}` : fileName;
    };

    let candidate = buildCandidate('');
    if (candidate === sourcePath) {
      return candidate;
    }

    let attempt = 0;
    while (attempt < 50) {
      const resolved = resolveProjectRelativePath(projectRoot, candidate);
      try {
        await fs.access(resolved.fullPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return candidate;
        }
        throw error;
      }

      attempt += 1;
      candidate = buildCandidate(`-optimized-${attempt}`);
    }

    return buildCandidate(`-optimized-${Date.now()}`);
  };

  const rejectIfProjectPathOutOfScope = (project, res) => {
    if (!isWithinManagedProjectsRoot(project?.path)) {
      res.status(400).json({
        success: false,
        error: 'Invalid project path'
      });
      return true;
    }
    return false;
  };

  // GET /api/projects/:id/files - Get project file tree
  router.get('/:id/files', async (req, res) => {
    try {
      const { id } = req.params;
      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      // Check if the path exists
      const fs = await getFsModule();
      try {
        await fs.access(project.path);
      } catch (error) {
        return res.status(400).json({
          success: false,
          error: `Project path does not exist: ${project.path}`
        });
      }

      // Build file tree
      const fileTree = await buildFileTree(project.path);

      res.json({
        success: true,
        files: fileTree
      });
    } catch (error) {
      console.error('Error fetching project files:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch project files'
      });
    }
  });

  // GET /api/projects/:id/files-diff/:path(*) - Get staged git diff for a file
  router.get('/:id/files-diff/*', async (req, res) => {
    try {
      const { id } = req.params;
      const filePath = req.params[0];

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      // Security: Prevent path traversal
      if (!filePath || filePath.includes('..') || path.isAbsolute(filePath)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid file path'
        });
      }

      const fullPath = path.join(project.path, filePath);

      // Verify the resolved path is still within the project directory
      const resolvedPath = path.resolve(fullPath);
      const projectPathResolved = path.resolve(project.path);

      if (!resolvedPath.startsWith(projectPathResolved)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid file path'
        });
      }

      const result = await runGitCommand(project.path, ['diff', '--cached', '--', filePath], { allowFailure: true });
      const diffText = (result.stdout || '').toString();

      if (result.code !== 0 && diffText.trim().length === 0) {
        const message = (result.stderr || '').toString().trim() || 'Git diff unavailable';
        return res.json({
          success: false,
          error: message,
          path: filePath,
          diff: ''
        });
      }

      return res.json({
        success: true,
        path: filePath,
        diff: diffText
      });
    } catch (error) {
      console.error('Error fetching staged diff:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch staged diff'
      });
    }
  });

  // GET /api/projects/:id/files-diff-content/:path(*) - Get HEAD vs staged (index) file contents
  // This represents what would be reverted in the index if the staged change was cleared.
  router.get('/:id/files-diff-content/*', async (req, res) => {
    try {
      // This endpoint is inherently dynamic (depends on the git index), so never allow caching.
      res.set('Cache-Control', 'no-store');

      const { id } = req.params;
      const filePath = req.params[0];

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      // Security: Prevent path traversal
      if (!filePath || filePath.includes('..') || path.isAbsolute(filePath)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid file path'
        });
      }

      const fullPath = path.join(project.path, filePath);

      // Verify the resolved path is still within the project directory
      const resolvedPath = path.resolve(fullPath);
      const projectPathResolved = path.resolve(project.path);

      if (!resolvedPath.startsWith(projectPathResolved)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid file path'
        });
      }

      // `HEAD:<path>` is the last committed version; `:<path>` is the staged (index) version.
      // If a file is new, HEAD:<path> will fail; if it's deleted, :<path> will fail.
      const safeGit = async (args, options) => {
        try {
          const result = await runGitCommand(project.path, args, options);
          if (result && typeof result === 'object') {
            return result;
          }
        } catch (error) {
          // fall through
        }

        return {
          stdout: '',
          stderr: '',
          code: 1
        };
      };

      const [headResult, indexResult] = await Promise.all([
        runGitCommand(project.path, ['show', `HEAD:${filePath}`], { allowFailure: true }),
        runGitCommand(project.path, ['show', `:${filePath}`], { allowFailure: true })
      ]);

      const [headOidResult, indexOidResult] = await Promise.all([
        safeGit(['rev-parse', `HEAD:${filePath}`], { allowFailure: true }),
        safeGit(['rev-parse', `:${filePath}`], { allowFailure: true })
      ]);

      const original = headResult.code === 0 ? (headResult.stdout || '').toString() : '';
      const modified = indexResult.code === 0 ? (indexResult.stdout || '').toString() : '';
      const headBlobOid = headOidResult.code === 0 ? (headOidResult.stdout || '').toString().trim() : null;
      const indexBlobOid = indexOidResult.code === 0 ? (indexOidResult.stdout || '').toString().trim() : null;

      if (headResult.code !== 0 && indexResult.code !== 0) {
        const message =
          (indexResult.stderr || headResult.stderr || '').toString().trim() || 'Git diff unavailable';
        return res.json({
          success: false,
          error: message,
          path: filePath,
          original: '',
          modified: ''
        });
      }

      return res.json({
        success: true,
        path: filePath,
        original,
        modified,
        headBlobOid,
        indexBlobOid,
        originalLabel: 'HEAD',
        modifiedLabel: 'Staged'
      });
    } catch (error) {
      console.error('Error fetching staged diff content:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch staged diff'
      });
    }
  });

  // GET /api/projects/:id/files/:path(*) - Get file content
  router.get('/:id/files/*', async (req, res) => {
    try {
      const { id } = req.params;
      const filePath = req.params[0]; // Get everything after /files/

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      let resolved;
      try {
        resolved = resolveProjectRelativePath(project.path, filePath);
      } catch (error) {
        if (error?.statusCode === 400) {
          return res.status(400).json({ success: false, error: 'Invalid file path' });
        }
        throw error;
      }

      if (isSensitiveRepoPath(resolved.normalized)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      const fullPath = resolved.fullPath;

      // Check if file exists
      const fs = await getFsModule();
      try {
        try {
          await assertNoSymlinkSegments(fs, project.path, resolved.resolvedPath, { errorMessage: 'Invalid file path' });
        } catch (error) {
          if (error?.statusCode === 400) {
            return res.status(400).json({ success: false, error: 'Invalid file path' });
          }
          throw error;
        }

        const stats = await fs.stat(fullPath);

        if (!stats.isFile()) {
          return res.status(400).json({
            success: false,
            error: 'Path is not a file'
          });
        }

        // Read file content
        const content = await fs.readFile(fullPath, 'utf-8');

        res.json({
          success: true,
          content,
          path: filePath
        });
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({
            success: false,
            error: 'File not found'
          });
        }
        throw error;
      }
    } catch (error) {
      console.error('Error reading file:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to read file'
      });
    }
  });

  // PUT /api/projects/:id/files/:path(*) - Save file content
  router.put('/:id/files/*', async (req, res) => {
    try {
      const { id } = req.params;
      const filePath = req.params[0];
      const content = extractFileContentFromRequest(req.body);

      if (typeof content !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'File content must be provided as a string'
        });
      }

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      let resolved;
      try {
        resolved = resolveProjectRelativePath(project.path, filePath);
      } catch (error) {
        if (error?.statusCode === 400) {
          return res.status(400).json({ success: false, error: 'Invalid file path' });
        }
        throw error;
      }

      if (isSensitiveRepoPath(resolved.normalized)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      const fullPath = resolved.fullPath;

      const fs = await getFsModule();
      try {
        try {
          await assertNoSymlinkSegments(fs, project.path, resolved.resolvedPath, { errorMessage: 'Invalid file path' });
        } catch (error) {
          if (error?.statusCode === 400) {
            return res.status(400).json({ success: false, error: 'Invalid file path' });
          }
          throw error;
        }

        const stats = await fs.stat(fullPath);
        if (!stats.isFile()) {
          return res.status(400).json({
            success: false,
            error: 'Path is not a file'
          });
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({
            success: false,
            error: 'File not found'
          });
        }
        throw error;
      }

      await fs.writeFile(fullPath, content, 'utf-8');
      await stageUploadsPaths(id, [resolved.normalized]);

      const io = req.app?.get?.('io');
      if (io) {
        try {
          sendAgentUiCommand({
            io,
            projectId: id,
            command: { type: 'OPEN_FILE', payload: { filePath: resolved.normalized } }
          });
        } catch {
          // Ignore UI command failures.
        }
      }

      res.json({
        success: true,
        path: filePath
      });
    } catch (error) {
      console.error('Error saving file:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to save file'
      });
    }
  });

  // POST /api/projects/:id/files-ops/mkdir - Create a folder (optionally with a .gitkeep)
  router.post('/:id/files-ops/mkdir', async (req, res) => {
    try {
      const { id } = req.params;
      const folderPath = normalizeRepoPath(req.body?.folderPath);
      const track = req.body?.track === false ? false : true;

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      if (!folderPath) {
        return res.status(400).json({ success: false, error: 'folderPath is required' });
      }

      if (isSensitiveRepoPath(folderPath)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      const fs = await getFsModule();
      const { normalized, fullPath, resolvedPath, projectResolved } = resolveProjectRelativePath(project.path, folderPath);

      await assertNoSymlinkSegments(fs, project.path, resolvedPath);

      // Disallow creating the project root itself.
      if (resolvedPath === projectResolved) {
        return res.status(400).json({ success: false, error: 'Invalid folder path' });
      }

      await fs.mkdir(fullPath, { recursive: true });

      let trackingFile = null;
      if (track) {
        trackingFile = path.join(fullPath, '.gitkeep');
        try {
          await fs.writeFile(trackingFile, '', { flag: 'wx' });
        } catch (error) {
          // Ignore if already exists.
          if (error?.code !== 'EEXIST') {
            throw error;
          }
        }
      }

      return res.json({
        success: true,
        folderPath: normalized,
        trackingPath: track ? `${normalized.replace(/\/$/, '')}/.gitkeep` : null
      });
    } catch (error) {
      const status = error.statusCode || 500;
      res.status(status).json({ success: false, error: status === 500 ? 'Failed to create folder' : error.message });
    }
  });

  // POST /api/projects/:id/files-ops/create-file - Create a new file (optionally with initial content)
  router.post('/:id/files-ops/create-file', async (req, res) => {
    try {
      const { id } = req.params;
      const filePath = normalizeRepoPath(req.body?.filePath);
      const openInEditor = req.body?.openInEditor !== false;
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      const encoding = typeof req.body?.encoding === 'string'
        ? req.body.encoding.trim().toLowerCase()
        : 'utf-8';
      const contentBase64 = typeof req.body?.contentBase64 === 'string'
        ? req.body.contentBase64.trim()
        : null;

      if (encoding !== 'utf-8' && encoding !== 'base64') {
        return res.status(400).json({ success: false, error: 'Unsupported encoding' });
      }

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      if (!filePath) {
        return res.status(400).json({ success: false, error: 'filePath is required' });
      }

      if (isSensitiveRepoPath(filePath)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      const fs = await getFsModule();
      const { normalized, fullPath, resolvedPath, projectResolved } = resolveProjectRelativePath(project.path, filePath);

      // Disallow creating the project root itself.
      if (resolvedPath === projectResolved) {
        return res.status(400).json({ success: false, error: 'Invalid file path' });
      }

      await assertNoSymlinkSegments(fs, project.path, path.dirname(resolvedPath));

      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      const writeValue = encoding === 'base64'
        ? Buffer.from(contentBase64 || '', 'base64')
        : content;
      const writeOptions = encoding === 'base64'
        ? { flag: 'wx' }
        : { encoding: 'utf-8', flag: 'wx' };

      try {
        await fs.writeFile(fullPath, writeValue, writeOptions);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          return res.status(409).json({ success: false, error: 'File already exists' });
        }
        throw error;
      }

      await stageUploadsPaths(id, [normalized]);

      const io = req.app?.get?.('io');
      if (io && openInEditor) {
        try {
          sendAgentUiCommand({
            io,
            projectId: id,
            command: { type: 'OPEN_FILE', payload: { filePath: normalized } }
          });
        } catch {
          // Ignore UI command failures.
        }
      }

      return res.json({
        success: true,
        filePath: normalized
      });
    } catch (error) {
      const status = error.statusCode || 500;
      return res
        .status(status)
        .json({ success: false, error: status === 500 ? 'Failed to create file' : error.message });
    }
  });

  // GET /api/projects/:id/assets/:path(*) - Stream an asset file (binary-safe)
  router.get('/:id/assets', async (req, res) => {
    try {
      const { id } = req.params;
      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      const fs = await getFsModule();
      const uploadsResolved = resolveProjectRelativePath(project.path, 'uploads');

      try {
        await assertNoSymlinkSegments(fs, project.path, uploadsResolved.resolvedPath, { errorMessage: 'Invalid file path' });
      } catch (error) {
        if (error?.statusCode === 400) {
          return res.status(400).json({ success: false, error: 'Invalid file path' });
        }
        throw error;
      }

      try {
        const stats = await fs.stat(uploadsResolved.fullPath);
        if (!stats.isDirectory()) {
          return res.json({ success: true, assets: [] });
        }
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return res.json({ success: true, assets: [] });
        }
        throw error;
      }

      const uploadsTree = await buildFileTree(uploadsResolved.fullPath, 'uploads');
      const files = flattenFileTree(uploadsTree);

      const assets = await Promise.all(files.map(async (entry) => {
        const resolved = resolveProjectRelativePath(project.path, entry.path);
        const stats = await fs.stat(resolved.fullPath);

        let width = null;
        let height = null;
        let hasAlpha = null;
        const ext = getExtension(entry.path);

        if (IMAGE_EXTENSIONS.has(ext)) {
          try {
            const metadata = await sharp(resolved.fullPath).metadata();
            width = Number.isFinite(metadata?.width) ? metadata.width : null;
            height = Number.isFinite(metadata?.height) ? metadata.height : null;
            hasAlpha = typeof metadata?.hasAlpha === 'boolean' ? metadata.hasAlpha : null;
          } catch {
            width = null;
            height = null;
            hasAlpha = null;
          }
        }

        const heuristic = analyzeTransmissionOptimization({
          filePath: entry.path,
          sizeBytes: Number.isFinite(stats.size) ? stats.size : 0,
          width,
          height
        });

        return {
          name: entry.name,
          path: entry.path,
          sizeBytes: Number.isFinite(stats.size) ? stats.size : 0,
          pixelWidth: width,
          pixelHeight: height,
          hasAlpha,
          optimizedForTransmission: heuristic.optimized,
          optimizationReason: heuristic.reason
        };
      }));

      assets.sort((a, b) => a.path.localeCompare(b.path));

      return res.json({
        success: true,
        assets
      });
    } catch (error) {
      console.error('Error listing assets:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to load assets'
      });
    }
  });

  // POST /api/projects/:id/assets/optimize - Optimize an uploaded image asset
  router.post('/:id/assets/optimize', async (req, res) => {
    try {
      const { id } = req.params;
      const assetPath = normalizeRepoPath(req.body?.assetPath);
      const mode = req.body?.mode === 'manual' ? 'manual' : 'auto';
      const requestedOptions = req.body?.options && typeof req.body.options === 'object'
        ? req.body.options
        : {};

      if (!assetPath) {
        return res.status(400).json({ success: false, error: 'assetPath is required' });
      }

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      let resolved;
      try {
        resolved = resolveProjectRelativePath(project.path, assetPath);
      } catch (error) {
        if (error?.statusCode === 400) {
          return res.status(400).json({ success: false, error: 'Invalid file path' });
        }
        throw error;
      }

      if (!resolved.normalized.startsWith('uploads/')) {
        return res.status(400).json({ success: false, error: 'Only uploaded assets can be optimized' });
      }

      if (isSensitiveRepoPath(resolved.normalized)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      const fs = await getFsModule();

      try {
        await assertNoSymlinkSegments(fs, project.path, resolved.resolvedPath, { errorMessage: 'Invalid file path' });
      } catch (error) {
        if (error?.statusCode === 400) {
          return res.status(400).json({ success: false, error: 'Invalid file path' });
        }
        throw error;
      }

      try {
        const stats = await fs.stat(resolved.fullPath);
        if (!stats.isFile()) {
          return res.status(400).json({ success: false, error: 'Path is not a file' });
        }
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return res.status(404).json({ success: false, error: 'File not found' });
        }
        throw error;
      }

      const metadata = await sharp(resolved.fullPath).metadata();
      const width = Number.isFinite(metadata?.width) ? metadata.width : null;
      const height = Number.isFinite(metadata?.height) ? metadata.height : null;
      const hasAlpha = Boolean(metadata?.hasAlpha);

      if (!width || !height) {
        return res.status(400).json({ success: false, error: 'Optimization is currently supported for image files only' });
      }

      const autoSettings = deriveAutoOptimizationSettings({ width, height, hasAlpha });
      const requestedFormat = normalizeOutputFormat(requestedOptions?.format, autoSettings.format);
      const targetFormat = mode === 'auto'
        ? autoSettings.format
        : (requestedFormat === 'auto' ? autoSettings.format : requestedFormat);

      const quality = mode === 'auto'
        ? autoSettings.quality
        : clampNumber(requestedOptions?.quality, 1, 100, autoSettings.quality);

      const scalePercent = mode === 'auto'
        ? autoSettings.scalePercent
        : clampNumber(requestedOptions?.scalePercent, 10, 100, 100);

      let transformer = sharp(resolved.fullPath, { animated: false });
      if (scalePercent < 100) {
        const scaledWidth = Math.max(1, Math.round((width * scalePercent) / 100));
        const scaledHeight = Math.max(1, Math.round((height * scalePercent) / 100));
        transformer = transformer.resize({
          width: scaledWidth,
          height: scaledHeight,
          fit: 'inside',
          withoutEnlargement: true
        });
      }

      if (targetFormat === 'jpeg') {
        transformer = transformer.jpeg({
          quality: Math.round(quality),
          mozjpeg: true,
          progressive: true,
          chromaSubsampling: '4:2:0'
        });
      } else if (targetFormat === 'webp') {
        transformer = transformer.webp({
          quality: Math.round(quality),
          effort: 5
        });
      } else if (targetFormat === 'avif') {
        transformer = transformer.avif({
          quality: Math.round(clampNumber(quality, 1, 90, 55)),
          effort: 4
        });
      } else {
        const compressionLevel = Math.max(0, Math.min(9, Math.round((100 - quality) / 11)));
        transformer = transformer.png({
          compressionLevel,
          palette: true
        });
      }

      const { data, info } = await transformer.toBuffer({ resolveWithObject: true });

      const destinationPath = await buildUniqueOptimizedPath(
        fs,
        project.path,
        resolved.normalized,
        targetFormat
      );
      const destinationResolved = resolveProjectRelativePath(project.path, destinationPath);

      await fs.writeFile(destinationResolved.fullPath, data);

      if (destinationPath !== resolved.normalized) {
        await fs.unlink(resolved.fullPath).catch(() => {});
      }

      await stageUploadsPaths(id, [resolved.normalized, destinationPath]);

      const analysis = analyzeTransmissionOptimization({
        filePath: destinationPath,
        sizeBytes: data.length,
        width: Number.isFinite(info?.width) ? info.width : width,
        height: Number.isFinite(info?.height) ? info.height : height
      });

      return res.json({
        success: true,
        path: destinationPath,
        replacedPath: destinationPath !== resolved.normalized ? resolved.normalized : null,
        sizeBytes: data.length,
        pixelWidth: Number.isFinite(info?.width) ? info.width : width,
        pixelHeight: Number.isFinite(info?.height) ? info.height : height,
        optimizedForTransmission: analysis.optimized,
        optimizationReason: analysis.reason,
        applied: {
          mode,
          format: targetFormat,
          quality: Math.round(quality),
          scalePercent: Math.round(scalePercent)
        }
      });
    } catch (error) {
      console.error('Error optimizing asset:', error);
      return res.status(500).json({ success: false, error: 'Failed to optimize asset' });
    }
  });

  // GET /api/projects/:id/assets/:path(*) - Stream an asset file (binary-safe)
  router.get('/:id/assets/*', async (req, res) => {
    try {
      const { id } = req.params;
      const assetPath = req.params[0];

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({
          success: false,
          error: 'Project not found'
        });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      let resolved;
      try {
        resolved = resolveProjectRelativePath(project.path, assetPath);
      } catch (error) {
        if (error?.statusCode === 400) {
          return res.status(400).json({ success: false, error: 'Invalid file path' });
        }
        throw error;
      }

      if (isSensitiveRepoPath(resolved.normalized)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      const fullPath = resolved.fullPath;
      const fs = await getFsModule();

      try {
        try {
          await assertNoSymlinkSegments(fs, project.path, resolved.resolvedPath, { errorMessage: 'Invalid file path' });
        } catch (error) {
          if (error?.statusCode === 400) {
            return res.status(400).json({ success: false, error: 'Invalid file path' });
          }
          throw error;
        }

        const stats = await fs.stat(fullPath);
        if (!stats.isFile()) {
          return res.status(400).json({
            success: false,
            error: 'Path is not a file'
          });
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({
            success: false,
            error: 'File not found'
          });
        }
        throw error;
      }

      return res.sendFile(fullPath);
    } catch (error) {
      console.error('Error streaming asset file:', error);
      return res.status(500).json({
        success: false,
        error: 'Failed to stream asset file'
      });
    }
  });

  // POST /api/projects/:id/files-ops/rename - Rename/move a file or folder
  router.post('/:id/files-ops/rename', async (req, res) => {
    try {
      const { id } = req.params;
      const fromPath = normalizeRepoPath(req.body?.fromPath);
      const toPath = normalizeRepoPath(req.body?.toPath);

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      if (!fromPath || !toPath) {
        return res.status(400).json({ success: false, error: 'fromPath and toPath are required' });
      }

      if (isSensitiveRepoPath(fromPath) || isSensitiveRepoPath(toPath)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      const fs = await getFsModule();
      const fromResolved = resolveProjectRelativePath(project.path, fromPath);
      const toResolved = resolveProjectRelativePath(project.path, toPath);

      if (fromResolved.resolvedPath === fromResolved.projectResolved) {
        return res.status(400).json({ success: false, error: 'Invalid source path' });
      }

      if (toResolved.resolvedPath === toResolved.projectResolved) {
        return res.status(400).json({ success: false, error: 'Invalid destination path' });
      }

      await assertNoSymlinkSegments(fs, project.path, fromResolved.resolvedPath);
      await assertNoSymlinkSegments(fs, project.path, path.dirname(toResolved.resolvedPath));

      try {
        await fs.stat(fromResolved.fullPath);
      } catch (statError) {
        if (statError?.code === 'ENOENT') {
          return res.status(404).json({ success: false, error: 'Source path not found' });
        }
        throw statError;
      }

      // Ensure destination parent exists
      await fs.mkdir(path.dirname(toResolved.fullPath), { recursive: true });

      // If the target exists, bail to avoid accidental overwrite.
      try {
        await fs.stat(toResolved.fullPath);
        return res.status(400).json({ success: false, error: 'Destination already exists' });
      } catch (statError) {
        if (statError?.code !== 'ENOENT') {
          throw statError;
        }
      }

      await fs.rename(fromResolved.fullPath, toResolved.fullPath);
      await stageUploadsPaths(id, [fromResolved.normalized, toResolved.normalized]);

      return res.json({
        success: true,
        fromPath: fromResolved.normalized,
        toPath: toResolved.normalized
      });
    } catch (error) {
      const status = error.statusCode || 500;
      res.status(status).json({ success: false, error: status === 500 ? 'Failed to rename path' : error.message });
    }
  });

  // POST /api/projects/:id/files-ops/delete - Delete a file or folder
  router.post('/:id/files-ops/delete', async (req, res) => {
    try {
      const { id } = req.params;
      const targetPath = normalizeRepoPath(req.body?.targetPath);
      const recursive = req.body?.recursive === true;

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      if (!targetPath) {
        return res.status(400).json({ success: false, error: 'targetPath is required' });
      }

      if (isSensitiveRepoPath(targetPath)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      const fs = await getFsModule();
      const { normalized, fullPath, resolvedPath, projectResolved } = resolveProjectRelativePath(project.path, targetPath);

  await assertNoSymlinkSegments(fs, project.path, resolvedPath);

      if (resolvedPath === projectResolved) {
        return res.status(400).json({ success: false, error: 'Refusing to delete project root' });
      }

      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch (statError) {
        if (statError?.code === 'ENOENT') {
          return res.status(404).json({ success: false, error: 'Path not found' });
        }
        throw statError;
      }

      if (stats.isDirectory() && !recursive) {
        return res.status(400).json({ success: false, error: 'recursive must be true to delete folders' });
      }

      if (requireDestructiveConfirmation(req, res)) {
        return;
      }

      if (stats.isDirectory()) {
        await fs.rm(fullPath, { recursive: true, force: true });
      } else {
        await fs.unlink(fullPath);
      }

      await stageUploadsPaths(id, [normalized]);

      return res.json({ success: true, targetPath: normalized });
    } catch (error) {
      const status = error.statusCode || 500;
      res.status(status).json({ success: false, error: status === 500 ? 'Failed to delete path' : error.message });
    }
  });

  // POST /api/projects/:id/files-ops/duplicate - Duplicate a file (no folder copy)
  router.post('/:id/files-ops/duplicate', async (req, res) => {
    try {
      const { id } = req.params;
      const sourcePath = normalizeRepoPath(req.body?.sourcePath);
      const destinationPath = normalizeRepoPath(req.body?.destinationPath);

      const project = await getProject(id);

      if (!project) {
        return res.status(404).json({ success: false, error: 'Project not found' });
      }

      if (!project.path) {
        return res.status(400).json({
          success: false,
          error: 'Project path not found. Please re-import or recreate the project.'
        });
      }

      if (rejectIfProjectPathOutOfScope(project, res)) {
        return;
      }

      if (!sourcePath || !destinationPath) {
        return res.status(400).json({
          success: false,
          error: 'sourcePath and destinationPath are required'
        });
      }

      if (isSensitiveRepoPath(sourcePath) || isSensitiveRepoPath(destinationPath)) {
        return res.status(403).json({ success: false, error: 'Access denied' });
      }

      const fs = await getFsModule();
      const src = resolveProjectRelativePath(project.path, sourcePath);
      const dest = resolveProjectRelativePath(project.path, destinationPath);

  await assertNoSymlinkSegments(fs, project.path, src.resolvedPath);
  await assertNoSymlinkSegments(fs, project.path, path.dirname(dest.resolvedPath));

      const stats = await fs.stat(src.fullPath);
      if (!stats.isFile()) {
        return res.status(400).json({ success: false, error: 'Only file duplication is supported' });
      }

      // Ensure destination parent exists
      await fs.mkdir(path.dirname(dest.fullPath), { recursive: true });

      // If the destination exists, bail.
      try {
        await fs.stat(dest.fullPath);
        return res.status(400).json({ success: false, error: 'Destination already exists' });
      } catch (statError) {
        if (statError?.code !== 'ENOENT') {
          throw statError;
        }
      }

      await fs.copyFile(src.fullPath, dest.fullPath);
      await stageUploadsPaths(id, [src.normalized, dest.normalized]);

      return res.json({
        success: true,
        sourcePath: src.normalized,
        destinationPath: dest.normalized
      });
    } catch (error) {
      const status = error.statusCode || 500;
      res.status(status).json({ success: false, error: status === 500 ? 'Failed to duplicate file' : error.message });
    }
  });
}
