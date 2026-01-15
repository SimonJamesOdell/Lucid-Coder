import path from 'path';
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
      const content = typeof req.body?.content === 'string' ? req.body.content : '';

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

      try {
        await fs.writeFile(fullPath, content, { encoding: 'utf-8', flag: 'wx' });
      } catch (error) {
        if (error?.code === 'EEXIST') {
          return res.status(409).json({ success: false, error: 'File already exists' });
        }
        throw error;
      }

      const io = req.app?.get?.('io');
      if (io) {
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
