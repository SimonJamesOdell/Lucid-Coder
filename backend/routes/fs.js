import express from 'express';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { scanCompatibility } from '../services/importCompatibility.js';
import { buildCloneUrl } from '../utils/gitUrl.js';
import { runGitCommand } from '../utils/git.js';

const router = express.Router();
const isWindows = process.platform === 'win32';
const unsafePathPattern = /["\r\n\0]/;

const normalizePathInput = (value) => {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
};

const isUnsafePath = (value) => unsafePathPattern.test(value || '');

const listWindowsDrives = async () => {
  const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
  const roots = [];

  await Promise.all(letters.map(async (letter) => {
    const drivePath = `${letter}:\\`;
    try {
      await fs.access(drivePath);
      roots.push({ name: `${letter}:`, path: drivePath });
    } catch {
      // ignore missing drive
    }
  }));

  return roots.sort((a, b) => a.name.localeCompare(b.name));
};

const listRoots = async () => {
  const roots = [];

  const homeDir = os.homedir();
  if (homeDir) {
    roots.push({ name: 'Home', path: homeDir });
  }

  if (isWindows) {
    roots.push(...await listWindowsDrives());
  } else {
    roots.push({ name: '/', path: '/' });
  }

  return roots;
};

const fileExists = async (filePath) => {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const dirExists = async (dirPath) => {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const readJsonFile = async (filePath) => {
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
};

const readTextFileIfExists = async (filePath) => {
  if (!(await fileExists(filePath))) {
    return '';
  }
  return fs.readFile(filePath, 'utf-8');
};

const getPackageDependencies = (pkg = {}) => ({
  ...pkg.dependencies,
  ...pkg.devDependencies
});

const matchDependency = (deps = {}, names = []) =>
  names.find((name) => Object.prototype.hasOwnProperty.call(deps, name));

const detectNodeTech = async (baseDir) => {
  const pkgPath = path.join(baseDir, 'package.json');
  if (!(await fileExists(pkgPath))) {
    return null;
  }

  const pkg = await readJsonFile(pkgPath);
  const deps = getPackageDependencies(pkg);
  const hasTypeScript = Boolean(deps.typescript) || await fileExists(path.join(baseDir, 'tsconfig.json'));

  const frontendFramework = matchDependency(deps, ['next', 'nuxt', 'react', 'vue', 'angular', 'svelte', 'vite']);
  const backendFramework = matchDependency(deps, ['express', '@nestjs/core', 'fastify', 'koa', '@hapi/hapi', 'hapi']);

  return {
    language: hasTypeScript ? 'typescript' : 'javascript',
    frontendFramework,
    backendFramework
  };
};

const detectPythonTech = async (baseDir) => {
  const requirements = await readTextFileIfExists(path.join(baseDir, 'requirements.txt'));
  const pyproject = await readTextFileIfExists(path.join(baseDir, 'pyproject.toml'));
  const text = `${requirements}\n${pyproject}`.toLowerCase();
  if (!text.trim()) {
    return null;
  }

  const frameworks = ['django', 'flask', 'fastapi', 'pyramid', 'tornado'];
  const framework = frameworks.find((name) => text.includes(name)) || 'django';
  return { language: 'python', framework };
};

const detectJavaTech = async (baseDir) => {
  const hasPom = await fileExists(path.join(baseDir, 'pom.xml'));
  const hasGradle = await fileExists(path.join(baseDir, 'build.gradle')) || await fileExists(path.join(baseDir, 'build.gradle.kts'));
  if (!hasPom && !hasGradle) {
    return null;
  }
  const pom = await readTextFileIfExists(path.join(baseDir, 'pom.xml'));
  const gradle = await readTextFileIfExists(path.join(baseDir, 'build.gradle'));
  const text = `${pom}\n${gradle}`.toLowerCase();
  const framework = text.includes('spring') ? 'spring' : 'springboot';
  return { language: 'java', framework };
};

const detectCSharpTech = async (baseDir) => {
  const entries = await fs.readdir(baseDir).catch(() => []);
  const hasCsproj = entries.some((name) => name.toLowerCase().endsWith('.csproj'));
  if (!hasCsproj) {
    return null;
  }
  return { language: 'csharp', framework: 'aspnetcore' };
};

const detectGoTech = async (baseDir) => {
  const goMod = await readTextFileIfExists(path.join(baseDir, 'go.mod'));
  if (!goMod.trim()) {
    return null;
  }
  const text = goMod.toLowerCase();
  const frameworks = [
    { name: 'gin', marker: 'github.com/gin-gonic/gin' },
    { name: 'echo', marker: 'github.com/labstack/echo' },
    { name: 'fiber', marker: 'github.com/gofiber/fiber' },
    { name: 'chi', marker: 'github.com/go-chi/chi' },
    { name: 'gorilla', marker: 'github.com/gorilla/mux' }
  ];
  const match = frameworks.find((entry) => text.includes(entry.marker));
  return { language: 'go', framework: match ? match.name : 'gin' };
};

const detectRustTech = async (baseDir) => {
  const cargo = await readTextFileIfExists(path.join(baseDir, 'Cargo.toml'));
  if (!cargo.trim()) {
    return null;
  }
  const text = cargo.toLowerCase();
  const frameworks = ['actix-web', 'warp', 'rocket', 'axum', 'tide'];
  const match = frameworks.find((name) => text.includes(name));
  return { language: 'rust', framework: match ? match.replace('-web', '') : 'actix' };
};

const detectPhpTech = async (baseDir) => {
  const composer = await readTextFileIfExists(path.join(baseDir, 'composer.json'));
  if (!composer.trim()) {
    return null;
  }
  const text = composer.toLowerCase();
  const frameworks = ['laravel', 'symfony', 'codeigniter', 'zend', 'cakephp'];
  const framework = frameworks.find((name) => text.includes(name)) || 'laravel';
  return { language: 'php', framework };
};

const detectRubyTech = async (baseDir) => {
  const gemfile = await readTextFileIfExists(path.join(baseDir, 'Gemfile'));
  if (!gemfile.trim()) {
    return null;
  }
  const text = gemfile.toLowerCase();
  const frameworks = ['rails', 'sinatra', 'padrino', 'hanami', 'grape'];
  const framework = frameworks.find((name) => text.includes(name)) || 'rails';
  return { language: 'ruby', framework };
};

const detectSwiftTech = async (baseDir) => {
  const pkg = await readTextFileIfExists(path.join(baseDir, 'Package.swift'));
  if (!pkg.trim()) {
    return null;
  }
  const text = pkg.toLowerCase();
  const framework = text.includes('vapor') ? 'vapor' : 'vapor';
  return { language: 'swift', framework };
};

const detectTechStack = async (rootPath) => {
  const candidates = [
    rootPath,
    path.join(rootPath, 'frontend'),
    path.join(rootPath, 'client'),
    path.join(rootPath, 'web'),
    path.join(rootPath, 'app'),
    path.join(rootPath, 'backend'),
    path.join(rootPath, 'server'),
    path.join(rootPath, 'api')
  ];

  const existingDirs = [];
  for (const candidate of candidates) {
    if (await dirExists(candidate)) {
      existingDirs.push(candidate);
    }
  }

  let frontend = null;
  let backend = null;

  for (const dir of existingDirs) {
    const nodeInfo = await detectNodeTech(dir);
    if (nodeInfo?.frontendFramework && !frontend) {
      frontend = {
        language: nodeInfo.language,
        framework: nodeInfo.frontendFramework === 'next' ? 'nextjs'
          : nodeInfo.frontendFramework === 'nuxt' ? 'nuxtjs'
          : nodeInfo.frontendFramework
      };
    }

    if (nodeInfo?.backendFramework && !backend) {
      backend = {
        language: nodeInfo.language,
        framework: nodeInfo.backendFramework === '@nestjs/core' ? 'nestjs' : nodeInfo.backendFramework
      };
    }
  }

  for (const dir of existingDirs) {
    if (!backend) {
      backend = await detectPythonTech(dir)
        || await detectJavaTech(dir)
        || await detectCSharpTech(dir)
        || await detectGoTech(dir)
        || await detectRustTech(dir)
        || await detectPhpTech(dir)
        || await detectRubyTech(dir)
        || await detectSwiftTech(dir);
    }
    if (!frontend) {
      const nodeInfo = await detectNodeTech(dir);
      if (nodeInfo) {
        frontend = {
          language: nodeInfo.language,
          framework: nodeInfo.frontendFramework
            ? (nodeInfo.frontendFramework === 'next' ? 'nextjs'
              : nodeInfo.frontendFramework === 'nuxt' ? 'nuxtjs'
              : nodeInfo.frontendFramework)
            : 'react'
        };
      }
    }
  }

  return {
    frontend: frontend || { language: 'javascript', framework: 'react' },
    backend: backend || { language: 'javascript', framework: 'express' }
  };
};

router.get('/roots', async (req, res) => {
  try {
    const roots = await listRoots();
    return res.json({ success: true, roots });
  } catch (error) {
    console.error('Error listing filesystem roots:', error);
    return res.status(500).json({ success: false, error: 'Failed to list filesystem roots' });
  }
});

router.get('/list', async (req, res) => {
  try {
    const rawPath = normalizePathInput(req.query?.path);
    if (!rawPath) {
      return res.status(400).json({ success: false, error: 'Path is required' });
    }

    if (isUnsafePath(rawPath)) {
      return res.status(400).json({ success: false, error: 'Invalid path' });
    }

    const resolvedPath = path.resolve(rawPath);
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ success: false, error: 'Path is not a directory' });
    }

    const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => ({
        name: entry.name,
        path: path.join(resolvedPath, entry.name)
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({
      success: true,
      path: resolvedPath,
      directories
    });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Path not found' });
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    console.error('Error listing filesystem path:', error);
    return res.status(500).json({ success: false, error: 'Failed to list filesystem path' });
  }
});

router.get('/detect-tech', async (req, res) => {
  try {
    const rawPath = normalizePathInput(req.query?.path);
    if (!rawPath) {
      return res.status(400).json({ success: false, error: 'Path is required' });
    }

    if (isUnsafePath(rawPath)) {
      return res.status(400).json({ success: false, error: 'Invalid path' });
    }

    const resolvedPath = path.resolve(rawPath);
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ success: false, error: 'Path is not a directory' });
    }

    const detected = await detectTechStack(resolvedPath);
    return res.json({ success: true, path: resolvedPath, ...detected });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Path not found' });
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    console.error('Error detecting tech stack:', error);
    return res.status(500).json({ success: false, error: 'Failed to detect tech stack' });
  }
});

router.post('/detect-git-tech', async (req, res) => {
  let tempRoot = null;
  try {
    const payload = req.body || {};
    const rawUrl = typeof payload.gitUrl === 'string' ? payload.gitUrl.trim() : '';
    if (!rawUrl) {
      return res.status(400).json({ success: false, error: 'Git repository URL is required' });
    }

    if (isUnsafePath(rawUrl)) {
      return res.status(400).json({ success: false, error: 'Invalid git repository URL' });
    }

    const cloneAuthMethod = typeof payload.authMethod === 'string' ? payload.authMethod.trim() : '';
    const cloneToken = typeof payload.token === 'string' ? payload.token.trim() : '';
    const cloneUsername = typeof payload.username === 'string' ? payload.username.trim() : '';
    const cloneProvider = typeof payload.provider === 'string' ? payload.provider.trim() : '';

    const { cloneUrl } = buildCloneUrl({
      url: rawUrl,
      authMethod: cloneAuthMethod || undefined,
      token: cloneToken || undefined,
      username: cloneUsername || undefined,
      provider: cloneProvider || undefined
    });

    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lucidcoder-git-detect-'));
    const repoDir = path.join(tempRoot, 'repo');

    await runGitCommand(tempRoot, ['clone', '--depth', '1', cloneUrl, repoDir]);

    const detected = await detectTechStack(repoDir);
    return res.json({ success: true, frontend: detected.frontend, backend: detected.backend });
  } catch (error) {
    console.error('Error detecting git tech stack:', error);
    return res.status(500).json({ success: false, error: 'Failed to detect git tech stack' });
  } finally {
    if (tempRoot) {
      try {
        await fs.rm(tempRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('Failed to clean up git tech detection temp folder:', cleanupError?.message || cleanupError);
      }
    }
  }
});

router.get('/compatibility', async (req, res) => {
  try {
    const rawPath = normalizePathInput(req.query?.path);
    if (!rawPath) {
      return res.status(400).json({ success: false, error: 'Path is required' });
    }

    if (isUnsafePath(rawPath)) {
      return res.status(400).json({ success: false, error: 'Invalid path' });
    }

    const resolvedPath = path.resolve(rawPath);
    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return res.status(400).json({ success: false, error: 'Path is not a directory' });
    }

    const plan = await scanCompatibility(resolvedPath);
    return res.json({ success: true, path: resolvedPath, plan });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Path not found' });
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return res.status(403).json({ success: false, error: 'Access denied' });
    }
    console.error('Error scanning compatibility:', error);
    return res.status(500).json({ success: false, error: 'Failed to scan compatibility' });
  }
});

export { isUnsafePath, detectCSharpTech };
export default router;
