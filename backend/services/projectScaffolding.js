import fs from 'fs/promises';
import path from 'path';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { PROJECT_CREATION_STEPS } from '../constants/progressSteps.js';
import { buildProgressPayload } from './progressTracker.js';
import { buildExecErrorTail, execWithRetry, looksLikeWindowsLock } from './projectScaffolding/exec.js';
import { ensureDirectory, pathExists, sanitizeProjectName, writeFile } from './projectScaffolding/files.js';
import {
  DEFAULT_BACKEND_PORT_BASE,
  DEFAULT_FRONTEND_PORT_BASE,
  RESERVED_BACKEND_PORTS,
  RESERVED_FRONTEND_PORTS,
  buildPortOverrideOptions,
  findAvailablePort,
  normalizePortBase,
  normalizePortCandidate,
  snapshotReservedPorts
} from './projectScaffolding/ports.js';
import { buildStubProcesses, createProcessInfo, MAX_LOG_LINES } from './projectScaffolding/processes.js';
import {
  generateBackendFiles,
  generateFrontendFiles,
  generateMainProjectFiles,
  templates
} from './projectScaffolding/generate.js';
import { initializeGitRepository } from './projectScaffolding/git.js';
import { buildCloneUrl } from '../utils/gitUrl.js';
import {
  runGitCommand,
  getCurrentBranch,
  configureGitUser
} from '../utils/git.js';

const execAsync = promisify(exec);
const FORCE_REAL_START = process.env.LUCIDCODER_FORCE_REAL_START === 'true';
const isTestMode = process.env.NODE_ENV === 'test' && !FORCE_REAL_START;

const PRE_INSTALL_IGNORE_ENTRIES = {
  node: ['node_modules/'],
  python: ['venv/', '.venv/', '__pycache__/']
};

const PRE_INSTALL_TRACKED_PATHS = [
  'package-lock.json',
  'frontend/package-lock.json',
  'backend/package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'frontend/yarn.lock',
  'backend/yarn.lock',
  'frontend/pnpm-lock.yaml',
  'backend/pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock'
];

const FRONTEND_HOST_BINDING = '0.0.0.0';
const FRONTEND_DEV_HOST_FLAG_PATTERN = /(^|\s)--host(?:=|\s|$)/i;

const shouldPatchFrontendDevScriptHost = (devScript) => {
  if (typeof devScript !== 'string') {
    return false;
  }

  const normalized = devScript.trim();
  if (!normalized) {
    return false;
  }

  if (!/\bvite\b/i.test(normalized)) {
    return false;
  }

  return !FRONTEND_DEV_HOST_FLAG_PATTERN.test(normalized);
};

const ensureFrontendLanHostBinding = async (projectPath, { logger = console } = {}) => {
  const candidatePackagePaths = [
    path.join(projectPath, 'frontend', 'package.json'),
    path.join(projectPath, 'package.json')
  ];

  const patchedFiles = [];

  for (const packagePath of candidatePackagePaths) {
    try {
      const packageRaw = await fs.readFile(packagePath, 'utf8');
      const parsedPackage = JSON.parse(packageRaw);
      const scripts = parsedPackage && typeof parsedPackage === 'object' ? parsedPackage.scripts : null;
      const devScript = scripts && typeof scripts === 'object' ? scripts.dev : null;

      if (!shouldPatchFrontendDevScriptHost(devScript)) {
        continue;
      }

      parsedPackage.scripts.dev = `${devScript.trim()} --host ${FRONTEND_HOST_BINDING}`;
      await fs.writeFile(packagePath, `${JSON.stringify(parsedPackage, null, 2)}\n`, 'utf8');
      patchedFiles.push(packagePath);
    } catch (error) {
      if (error?.code !== 'ENOENT' && logger?.warn) {
        logger.warn('⚠️ Failed to evaluate frontend host binding for package.json:', packagePath, error?.message);
      }
    }
  }

  if (patchedFiles.length > 0 && logger?.info) {
    logger.info('🔧 Added frontend --host 0.0.0.0 binding to dev script', patchedFiles.map((filePath) => path.relative(projectPath, filePath)));
  }

  return patchedFiles;
};

const readPackageScripts = async (packageJsonPath) => {
  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    if (!parsed.scripts || typeof parsed.scripts !== 'object' || Array.isArray(parsed.scripts)) {
      return {};
    }
    return parsed.scripts;
  } catch {
    return {};
  }
};

const resolveBackendScriptName = (scripts = {}) => {
  const backendScript = typeof scripts.backend === 'string' ? scripts.backend.trim() : '';
  if (backendScript) {
    return 'backend';
  }
  const backendStartScript = typeof scripts['backend:start'] === 'string' ? scripts['backend:start'].trim() : '';
  if (backendStartScript) {
    return 'backend:start';
  }
  return '';
};

const resolveWindowsShell = async () => {
  if (process.platform !== 'win32') {
    return null;
  }

  const candidates = [
    typeof process.env.ComSpec === 'string' ? process.env.ComSpec.trim() : '',
    path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'cmd.exe'),
    'cmd.exe'
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.toLowerCase() === 'cmd.exe') {
      return candidate;
    }

    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }
};

const normalizeGitIgnoreLine = (line) => {
  const trimmed = typeof line === 'string' ? line.trim() : '';
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  return trimmed;
};

const getRepoRoot = async (projectPath) => {
  try {
    const result = await runGitCommand(projectPath, ['rev-parse', '--show-toplevel']);
    const root = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
    return root || projectPath;
  } catch {
    return projectPath;
  }
};

const readGitIgnoreEntries = async (projectPath) => {
  const repoRoot = await getRepoRoot(projectPath);
  const gitignorePath = path.join(repoRoot, '.gitignore');

  try {
    const content = await fs.readFile(gitignorePath, 'utf8');
    const entries = content
      .split(/\r?\n/)
      .map(normalizeGitIgnoreLine)
      .filter(Boolean);
    return { repoRoot, entries };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { repoRoot, entries: [] };
    }
    throw error;
  }
};

const buildPreInstallGitIgnoreSuggestion = async (projectPath) => {
  const { repoRoot, entries } = await readGitIgnoreEntries(projectPath);
  const existing = new Set(entries);

  const hasFile = async (relativePath) => {
    try {
      await fs.access(path.join(repoRoot, relativePath));
      return true;
    } catch {
      return false;
    }
  };

  const hasNodeProject = await Promise.all([
    hasFile('package.json'),
    hasFile(path.join('frontend', 'package.json')),
    hasFile(path.join('backend', 'package.json'))
  ]).then((results) => results.some(Boolean));

  const hasPythonProject = await Promise.all([
    hasFile('requirements.txt'),
    hasFile('pyproject.toml'),
    hasFile(path.join('backend', 'requirements.txt')),
    hasFile(path.join('backend', 'pyproject.toml'))
  ]).then((results) => results.some(Boolean));

  const expectedEntries = [
    ...(hasNodeProject ? PRE_INSTALL_IGNORE_ENTRIES.node : []),
    ...(hasPythonProject ? PRE_INSTALL_IGNORE_ENTRIES.python : [])
  ];

  const missing = expectedEntries.filter((entry) => !existing.has(entry));
  let trackedFiles = [];
  try {
    const tracked = await runGitCommand(projectPath, ['ls-files', '--', ...PRE_INSTALL_TRACKED_PATHS]);
    trackedFiles = typeof tracked?.stdout === 'string'
      ? tracked.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      : [];
  } catch {
    trackedFiles = [];
  }

  return {
    needed: missing.length > 0 || trackedFiles.length > 0,
    entries: missing,
    trackedFiles,
    repoRoot
  };
};
// Main scaffolding functions
export const generateProjectFiles = async (projectConfig) => {
  const { name, description, frontend, backend, path: projectPath } = projectConfig;
  
  if (!name || !name.trim()) {
    throw new Error('Project name is required');
  }

  const sanitizedName = sanitizeProjectName(name);
  const frontendPath = path.join(projectPath, 'frontend');
  const backendPath = path.join(projectPath, 'backend');
  const rootPackageJsonPath = path.join(projectPath, 'package.json');
  const frontendPackageJsonPath = path.join(frontendPath, 'package.json');
  const backendPackageJsonPath = path.join(backendPath, 'package.json');

  // Create main project directories
  await ensureDirectory(projectPath);
  await ensureDirectory(frontendPath);
  await ensureDirectory(backendPath);

  // Generate main project files
  await generateMainProjectFiles(projectPath, { name, description, frontend, backend });
  
  // Generate frontend files
  await generateFrontendFiles(frontendPath, { name: sanitizedName, ...frontend });
  
  // Generate backend files
  await generateBackendFiles(backendPath, { name: sanitizedName, ...backend });
};

export const installDependencies = async (projectPath) => {
  const frontendPath = path.join(projectPath, 'frontend');
  const backendPath = path.join(projectPath, 'backend');
  const rootPackageJsonPath = path.join(projectPath, 'package.json');
  const frontendPackageJsonPath = path.join(frontendPath, 'package.json');
  const backendPackageJsonPath = path.join(backendPath, 'package.json');
  const maxBuffer = 1024 * 1024 * 50; // 50MB to tolerate noisy installers
  const windowsShell = await resolveWindowsShell();
  const npmInstallShellOptions = windowsShell ? { shell: windowsShell } : {};
  const removePathIfPresent = async (targetPath) => {
    try {
      await fs.rm(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200
      });
    } catch {
      // Best-effort cleanup only.
    }
  };
  const rootPackageJsonExists = await fs.access(rootPackageJsonPath).then(() => true).catch(() => false);
  const frontendPackageJsonExists = await fs.access(frontendPackageJsonPath).then(() => true).catch(() => false);
  const backendPackageJsonExists = await fs.access(backendPackageJsonPath).then(() => true).catch(() => false);
  const isRootOnlyNodeLayout = rootPackageJsonExists && !frontendPackageJsonExists && !backendPackageJsonExists;

  if (isRootOnlyNodeLayout) {
    console.log('📦 Installing root dependencies...');
    try {
      await removePathIfPresent(path.join(projectPath, 'node_modules'));
      await removePathIfPresent(path.join(projectPath, 'package-lock.json'));
      await execWithRetry(execAsync, 'npm install', { cwd: projectPath, ...npmInstallShellOptions }, { maxBuffer });
      console.log('✅ Root dependencies installed');
    } catch (error) {
      console.error('❌ Root dependency installation failed:', error.message);
      throw new Error(`Root dependency installation failed: ${error.message}${buildExecErrorTail(error)}`);
    }
    return;
  }

  console.log('📦 Installing frontend dependencies...');
  try {
    // If a previous create attempt partially installed deps, start from a clean slate.
    await removePathIfPresent(path.join(frontendPath, 'node_modules'));
    await removePathIfPresent(path.join(frontendPath, 'package-lock.json'));
    await execWithRetry(execAsync, 'npm install', { cwd: frontendPath, ...npmInstallShellOptions }, { maxBuffer });
    console.log('✅ Frontend dependencies installed');
  } catch (error) {
    console.error('❌ Frontend dependency installation failed:', error.message);
    throw new Error(`Frontend dependency installation failed: ${error.message}${buildExecErrorTail(error)}`);
  }

  console.log('📦 Installing backend dependencies...');
  try {
    // Check what type of backend we're dealing with
    const packageJsonPath = path.join(backendPath, 'package.json');
    const requirementsPath = path.join(backendPath, 'requirements.txt');
    
    const packageJsonExists = await fs.access(packageJsonPath).then(() => true).catch(() => false);
    const requirementsExists = await fs.access(requirementsPath).then(() => true).catch(() => false);
    const hasNodeBackend = packageJsonExists;
    const hasPythonBackend = !packageJsonExists && requirementsExists;

    if (hasNodeBackend) {
      // Node.js backend
      await removePathIfPresent(path.join(backendPath, 'node_modules'));
      await removePathIfPresent(path.join(backendPath, 'package-lock.json'));
      await execWithRetry(execAsync, 'npm install', { cwd: backendPath, ...npmInstallShellOptions }, { maxBuffer });
      console.log('✅ Backend dependencies installed');
    }

    if (hasPythonBackend) {
      // Python backend - create virtual environment and install dependencies
      await execAsync('python -m venv venv', { cwd: backendPath });
      
      const activateCmd = process.platform === 'win32' 
        ? path.join('venv', 'Scripts', 'activate.bat') + ' && pip install -r requirements.txt'
        : 'source ' + path.join('venv', 'bin', 'activate') + ' && pip install -r requirements.txt';
      
      await execAsync(activateCmd, { cwd: backendPath, shell: true, maxBuffer });
      console.log('✅ Backend dependencies installed in virtual environment');
    }
  } catch (error) {
    console.error('❌ Backend dependency installation failed:', error.message);
    throw new Error(`Backend dependency installation failed: ${error.message}${buildExecErrorTail(error)}`);
  }
};

export const startProject = async (projectPath, options = {}) => {
  // Validate project path
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('Invalid project path: path must be a non-empty string');
  }

  const requestedTarget = options.target === 'frontend' || options.target === 'backend'
    ? options.target
    : null;
  const shouldStartFrontend = !requestedTarget || requestedTarget === 'frontend';
  const shouldStartBackend = !requestedTarget || requestedTarget === 'backend';
  
  const frontendPath = path.join(projectPath, 'frontend');
  const backendPath = path.join(projectPath, 'backend');
  const rootPackageJsonPath = path.join(projectPath, 'package.json');
  const frontendPackageJsonPath = path.join(frontendPath, 'package.json');
  const backendPackageJsonPath = path.join(backendPath, 'package.json');

  let preferredFrontendPort = normalizePortCandidate(options.frontendPort);
  if (preferredFrontendPort && RESERVED_FRONTEND_PORTS.has(preferredFrontendPort)) {
    preferredFrontendPort = null;
  }

  const appPyPath = path.join(backendPath, 'app.py');

  const frontendPackageJsonExists = await fs.access(frontendPackageJsonPath).then(() => true).catch(() => false);
  const rootPackageJsonExists = await fs.access(rootPackageJsonPath).then(() => true).catch(() => false);
  const packageJsonExists = await fs.access(backendPackageJsonPath).then(() => true).catch(() => false);
  const appPyExists = await fs.access(appPyPath).then(() => true).catch(() => false);
  const resolvedFrontendPath = frontendPackageJsonExists
    ? frontendPath
    : (rootPackageJsonExists ? projectPath : frontendPath);
  const hasFrontendEntrypoint = frontendPackageJsonExists || rootPackageJsonExists;
  const rootScripts = rootPackageJsonExists ? await readPackageScripts(rootPackageJsonPath) : {};
  const rootBackendScriptName = resolveBackendScriptName(rootScripts);

  const hasExplicitFrontendBase = Object.prototype.hasOwnProperty.call(options, 'frontendPortBase');
  const resolvedFrontendPortBase = normalizePortBase(options.frontendPortBase, DEFAULT_FRONTEND_PORT_BASE);
  if (preferredFrontendPort && preferredFrontendPort < resolvedFrontendPortBase && hasExplicitFrontendBase) {
    preferredFrontendPort = null;
  }
  const frontendPort = await findAvailablePort(preferredFrontendPort, resolvedFrontendPortBase, RESERVED_FRONTEND_PORTS);

  let preferredBackendPort = normalizePortCandidate(options.backendPort);
  const hasExplicitBackendBase = Object.prototype.hasOwnProperty.call(options, 'backendPortBase');
  const resolvedBackendPortBase = normalizePortBase(options.backendPortBase, DEFAULT_BACKEND_PORT_BASE);
  const backendDefaultPort = (packageJsonExists || rootBackendScriptName) ? 3000 : 5000;
  if (preferredBackendPort && preferredBackendPort < resolvedBackendPortBase && hasExplicitBackendBase) {
    preferredBackendPort = null;
  }

  let backendPreferred = preferredBackendPort;
  if (!backendPreferred) {
    backendPreferred = backendDefaultPort >= resolvedBackendPortBase ? backendDefaultPort : null;
  }

  const backendPort = await findAvailablePort(
    backendPreferred,
    resolvedBackendPortBase,
    RESERVED_BACKEND_PORTS
  );

  if (isTestMode) {
    const stub = buildStubProcesses({
      frontendPort,
      backendPort
    });

    return {
      success: true,
      processes: {
        frontend: shouldStartFrontend ? stub.frontend : null,
        backend: shouldStartBackend ? stub.backend : null
      }
    };
  }

  if (shouldStartFrontend && !hasFrontendEntrypoint) {
    throw new Error('No frontend package.json found in frontend/ or project root');
  }

  const processes = {
    frontend: null,
    backend: null
  };

  try {
    if (shouldStartBackend) {
      // Start backend first
      console.log('🚀 Starting backend server...');
      
      if (packageJsonExists) {
        // Node.js backend
        const backendProcess = spawn('npm', ['run', 'dev'], {
          cwd: backendPath,
          stdio: 'pipe',
          shell: true,
          env: { ...process.env, PORT: String(backendPort) }
        });
        processes.backend = createProcessInfo('backend', backendProcess, backendPort);
      }

      if (!packageJsonExists && appPyExists) {
        // Python backend - cross-platform virtual environment handling
        let backendProcess;
        
        if (process.platform === 'win32') {
          // Windows
          const activateScript = path.join(backendPath, 'venv', 'Scripts', 'activate.bat');
          const pythonExe = path.join(backendPath, 'venv', 'Scripts', 'python.exe');
          void pythonExe;
          
          // Check if virtual environment exists, otherwise use system python
          try {
            await fs.access(activateScript);
            backendProcess = spawn('cmd', ['/c', `"${activateScript}" && python app.py`], {
              cwd: backendPath,
              stdio: 'pipe',
              shell: false,
              env: { ...process.env, PORT: String(backendPort) }
            });
          } catch {
            // Fallback to system python
            backendProcess = spawn('python', ['app.py'], {
              cwd: backendPath,
              stdio: 'pipe',
              shell: false,
              env: { ...process.env, PORT: String(backendPort) }
            });
          }
        } else {
          // Unix-like systems (Linux, macOS)
          const activateScript = path.join(backendPath, 'venv', 'bin', 'activate');
          
          // Check if virtual environment exists, otherwise use system python
          try {
            await fs.access(activateScript);
            backendProcess = spawn('bash', ['-c', `source "${activateScript}" && python app.py`], {
              cwd: backendPath,
              stdio: 'pipe',
              shell: false,
              env: { ...process.env, PORT: String(backendPort) }
            });
          } catch {
            // Fallback to system python
            backendProcess = spawn('python3', ['app.py'], {
              cwd: backendPath,
              stdio: 'pipe',
              shell: false,
              env: { ...process.env, PORT: String(backendPort) }
            });
          }
        }
        
        processes.backend = createProcessInfo('backend', backendProcess, backendPort);
      }

      if (!packageJsonExists && !appPyExists && rootBackendScriptName) {
        const backendProcess = spawn('npm', ['run', rootBackendScriptName], {
          cwd: projectPath,
          stdio: 'pipe',
          shell: true,
          env: { ...process.env, PORT: String(backendPort) }
        });
        processes.backend = createProcessInfo('backend', backendProcess, backendPort);
      }
    }

    if (shouldStartFrontend) {
      // Give backend a moment to start when we're launching both.
      if (shouldStartBackend) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      await ensureFrontendLanHostBinding(projectPath, { logger: console });

      console.log('🚀 Starting frontend development server...');
      const frontendProcess = spawn('npm', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(frontendPort)], {
        cwd: resolvedFrontendPath,
        stdio: 'pipe',
        shell: true,
        env: {
          ...process.env,
          PORT: String(frontendPort),
          HOST: '0.0.0.0',
          HOSTNAME: '0.0.0.0'
        }
      });
      processes.frontend = createProcessInfo('frontend', frontendProcess, frontendPort);
    }

    console.log('✅ Project started successfully');
    if (processes.frontend && typeof processes.frontend.port === 'number') {
      console.log(`Frontend: http://localhost:${processes.frontend.port}`);
    }
    if (processes.backend && typeof processes.backend.port === 'number') {
      console.log(`Backend: http://localhost:${processes.backend.port}`);
    }

    return { success: true, processes };
  } catch (error) {
    console.error('❌ Failed to start project:', error.message);
    throw new Error(`Failed to start project: ${error.message}`);
  }
};

export const scaffoldProject = async (projectConfig) => {
  console.log('🏗️  Scaffolding project:', projectConfig.name);
  
  try {
    await generateProjectFiles(projectConfig);
    console.log('✅ Project files generated');
    
    return { success: true };
  } catch (error) {
    console.error('❌ Project scaffolding failed:', error.message);
    throw error;
  }
};

export const createProjectWithFiles = async (projectConfig, options = {}) => {
  const { onProgress, gitSettings = {}, portSettings = null } = options;
  const totalSteps = PROJECT_CREATION_STEPS.length;
  const emitProgress = typeof onProgress === 'function'
    ? (payload) => {
        try {
          onProgress({ ...payload, updatedAt: new Date().toISOString() });
        } catch (error) {
          console.warn('Progress reporter failed:', error.message);
        }
      }
    : null;

  const reportProgress = (completedCount, statusMessage, statusOverride) => {
    if (!emitProgress) return;
    const status = statusOverride || (completedCount >= totalSteps ? 'completed' : 'in-progress');
    emitProgress(buildProgressPayload(completedCount, statusMessage, status));
  };

  const reportMessage = (statusMessage, completedCount) => {
    if (!emitProgress) return;
    emitProgress(buildProgressPayload(completedCount, statusMessage, 'in-progress'));
  };

  if (isTestMode) {
    reportMessage('Creating project directories...', 0);
    await scaffoldProject(projectConfig);
    reportProgress(1, 'Project directories created');
    reportProgress(2, 'Project files generated');
    reportMessage('Initializing git repository...', 2);
    reportProgress(3, 'Git repository initialized');
    reportMessage('Installing dependencies...', 3);
    reportProgress(4, 'Dependencies installed');
    reportMessage('Starting development servers...', 4);
    const portOverrides = buildPortOverrideOptions(portSettings);
    const startResult = await startProject(projectConfig.path, portOverrides);
    reportProgress(totalSteps, 'Development servers running');
    
    const project = {
      id: Date.now(),
      name: projectConfig.name,
      description: projectConfig.description,
      frontend: projectConfig.frontend,
      backend: projectConfig.backend,
      path: projectConfig.path,
      createdAt: new Date().toISOString()
    };

    return {
      success: true,
      project,
      processes: startResult.processes,
      progress: buildProgressPayload(totalSteps, 'Development servers running', 'completed')
    };
  }

  try {
    reportMessage('Creating project directories...', 0);
    await scaffoldProject(projectConfig);
    reportProgress(1, 'Project directories created');
    reportProgress(2, 'Project files generated');
    reportMessage('Initializing git repository...', 2);
    await initializeGitRepository(projectConfig.path, gitSettings);
    reportProgress(3, 'Git repository initialized');
    
    reportMessage('Installing dependencies...', 3);
    await installDependencies(projectConfig.path);
    reportProgress(4, 'Dependencies installed');
    
    reportMessage('Starting development servers...', 4);
    const portOverrides = buildPortOverrideOptions(portSettings);
    const startResult = await startProject(projectConfig.path, portOverrides);
    reportProgress(totalSteps, 'Development servers running');
    
    const project = {
      id: Date.now(), // This will be replaced by database ID
      name: projectConfig.name,
      description: projectConfig.description,
      frontend: projectConfig.frontend,
      backend: projectConfig.backend,
      path: projectConfig.path,
      createdAt: new Date().toISOString()
    };

    return {
      success: true,
      project,
      processes: startResult.processes,
      progress: buildProgressPayload(totalSteps, 'Development servers running', 'completed')
    };
  } catch (error) {
    console.error('❌ Project creation failed:', error.message);
    throw error;
  }
};

const CLONE_STEP_NAMES = [
  'Cloning repository',
  'Project files ready',
  'Configuring git',
  'Installing dependencies',
  'Starting development servers'
];

export const cloneProjectFromRemote = async (projectConfig, options = {}) => {
  const {
    onProgress,
    cloneOptions = {},
    portSettings = null,
    requireGitIgnoreApproval = false,
    gitIgnoreApproved = false
  } = options;
  const totalSteps = CLONE_STEP_NAMES.length;
  const emitProgress = typeof onProgress === 'function'
    ? (payload) => {
        try {
          onProgress({ ...payload, updatedAt: new Date().toISOString() });
        } catch (error) {
          console.warn('Progress reporter failed:', error.message);
        }
      }
    : null;

  const reportProgress = (completedCount, statusMessage) => {
    if (!emitProgress) return;
    const status = completedCount >= totalSteps ? 'completed' : 'in-progress';
    const completion = Math.round((Math.min(totalSteps, Math.max(0, completedCount)) / totalSteps) * 100);
    emitProgress({
      steps: CLONE_STEP_NAMES.map((name, i) => ({ name, completed: i < completedCount })),
      completion,
      status,
      statusMessage
    });
  };

  const reportMessage = (statusMessage, completedCount) => {
    if (!emitProgress) return;
    const completion = Math.round((Math.min(totalSteps, Math.max(0, completedCount)) / totalSteps) * 100);
    emitProgress({
      steps: CLONE_STEP_NAMES.map((name, i) => ({ name, completed: i < completedCount })),
      completion,
      status: 'in-progress',
      statusMessage
    });
  };

  if (isTestMode) {
    reportMessage('Cloning remote repository...', 0);
    await fs.mkdir(projectConfig.path, { recursive: true });
    reportProgress(1, 'Repository cloned');
    reportProgress(2, 'Project files ready');
    reportMessage('Configuring git...', 2);
    reportProgress(3, 'Git configured');
    reportMessage('Installing dependencies...', 3);
    reportProgress(4, 'Dependencies installed');
    reportMessage('Starting development servers...', 4);
    const portOverrides = buildPortOverrideOptions(portSettings);
    const startResult = await startProject(projectConfig.path, portOverrides);
    reportProgress(totalSteps, 'Development servers running');

    return {
      success: true,
      processes: startResult.processes,
      progress: {
        steps: CLONE_STEP_NAMES.map((name) => ({ name, completed: true })),
        completion: 100,
        status: 'completed',
        statusMessage: 'Development servers running'
      },
      cloned: true,
      branch: cloneOptions.defaultBranch || 'main',
      remote: cloneOptions.remoteUrl || null
    };
  }

  try {
    reportMessage('Cloning remote repository...', 0);

    const { cloneUrl, safeUrl } = buildCloneUrl({
      url: cloneOptions.remoteUrl,
      authMethod: cloneOptions.authMethod,
      token: cloneOptions.token,
      username: cloneOptions.username,
      provider: cloneOptions.provider
    });

    const parentDir = path.dirname(projectConfig.path);
    await fs.mkdir(parentDir, { recursive: true });
    await runGitCommand(parentDir, ['clone', cloneUrl, projectConfig.path]);

    // Strip embedded credentials from the stored remote URL
    await runGitCommand(projectConfig.path, ['remote', 'set-url', 'origin', safeUrl], { allowFailure: true });
    reportProgress(1, 'Repository cloned');
    reportProgress(2, 'Project files ready');

    reportMessage('Configuring git...', 2);
    await configureGitUser(projectConfig.path, {
      name: cloneOptions.username,
      email: cloneOptions.username ? `${cloneOptions.username}@users.noreply.github.com` : undefined
    });

    let clonedBranch;
    try {
      clonedBranch = await getCurrentBranch(projectConfig.path);
    } catch {
      clonedBranch = cloneOptions.defaultBranch || 'main';
    }
    reportProgress(3, 'Git configured');

    if (requireGitIgnoreApproval) {
      const suggestion = await buildPreInstallGitIgnoreSuggestion(projectConfig.path);
      if (suggestion.needed && !gitIgnoreApproved) {
        const completedCount = 3;
        return {
          success: true,
          processes: null,
          progress: {
            steps: CLONE_STEP_NAMES.map((name, index) => ({ name, completed: index < completedCount })),
            completion: Math.round((completedCount / totalSteps) * 100),
            status: 'awaiting-user',
            statusMessage: 'Waiting for .gitignore approval'
          },
          cloned: true,
          branch: clonedBranch,
          remote: safeUrl,
          setupRequired: true,
          gitIgnoreSuggestion: suggestion
        };
      }
    }

    reportMessage('Installing dependencies...', 3);
    await installDependencies(projectConfig.path);
    reportProgress(4, 'Dependencies installed');

    reportMessage('Starting development servers...', 4);
    const portOverrides = buildPortOverrideOptions(portSettings);
    const startResult = await startProject(projectConfig.path, portOverrides);
    reportProgress(totalSteps, 'Development servers running');

    return {
      success: true,
      processes: startResult.processes,
      progress: {
        steps: CLONE_STEP_NAMES.map((name) => ({ name, completed: true })),
        completion: 100,
        status: 'completed',
        statusMessage: 'Development servers running'
      },
      cloned: true,
      branch: clonedBranch,
      remote: safeUrl
    };
  } catch (error) {
    console.error('❌ Project clone failed:', error.message);
    throw error;
  }
};

export const __testing = {
  MAX_LOG_LINES,
  looksLikeWindowsLock,
  shouldPatchFrontendDevScriptHost,
  ensureFrontendLanHostBinding,
  readPackageScripts,
  resolveBackendScriptName,
  resolveWindowsShell,
  execWithRetry,
  buildExecErrorTail,
  sanitizeProjectName,
  ensureDirectory,
  writeFile,
  pathExists,
  normalizePortBase,
  findAvailablePort,
  createProcessInfo,
  buildStubProcesses,
  initializeGitRepository,
  generateMainProjectFiles,
  generateFrontendFiles,
  generateBackendFiles,
  templates,
  snapshotReservedPorts
};

export const startProjectTarget = async (projectPath, target, options = {}) => {
  if (!projectPath || typeof projectPath !== 'string') {
    throw new Error('Invalid project path: path must be a non-empty string');
  }

  const normalizedTarget = target === 'frontend' || target === 'backend' ? target : null;
  if (!normalizedTarget) {
    throw new Error('Invalid start target');
  }

  const frontendPath = path.join(projectPath, 'frontend');
  const backendPath = path.join(projectPath, 'backend');
  const rootPackageJsonPath = path.join(projectPath, 'package.json');
  const frontendPackageJsonPath = path.join(frontendPath, 'package.json');
  const backendPackageJsonPath = path.join(backendPath, 'package.json');

  const appPyPath = path.join(backendPath, 'app.py');
  const frontendPackageJsonExists = await fs.access(frontendPackageJsonPath).then(() => true).catch(() => false);
  const rootPackageJsonExists = await fs.access(rootPackageJsonPath).then(() => true).catch(() => false);
  const packageJsonExists = await fs.access(backendPackageJsonPath).then(() => true).catch(() => false);
  const appPyExists = await fs.access(appPyPath).then(() => true).catch(() => false);
  const resolvedFrontendPath = frontendPackageJsonExists
    ? frontendPath
    : (rootPackageJsonExists ? projectPath : frontendPath);
  const rootScripts = rootPackageJsonExists ? await readPackageScripts(rootPackageJsonPath) : {};
  const rootBackendScriptName = resolveBackendScriptName(rootScripts);
  const hasBackendEntrypoint = packageJsonExists || appPyExists || Boolean(rootBackendScriptName);

  const hasExplicitFrontendBase = Object.prototype.hasOwnProperty.call(options, 'frontendPortBase');
  const hasExplicitBackendBase = Object.prototype.hasOwnProperty.call(options, 'backendPortBase');

  let frontendPort = null;
  let backendPort = null;

  if (normalizedTarget === 'frontend') {
    let preferredFrontendPort = normalizePortCandidate(options.frontendPort);
    if (preferredFrontendPort && RESERVED_FRONTEND_PORTS.has(preferredFrontendPort)) {
      preferredFrontendPort = null;
    }

    const resolvedFrontendPortBase = normalizePortBase(options.frontendPortBase, DEFAULT_FRONTEND_PORT_BASE);
    if (preferredFrontendPort && preferredFrontendPort < resolvedFrontendPortBase && hasExplicitFrontendBase) {
      preferredFrontendPort = null;
    }

    frontendPort = await findAvailablePort(preferredFrontendPort, resolvedFrontendPortBase, RESERVED_FRONTEND_PORTS);
  }

  if (normalizedTarget === 'backend') {
    let preferredBackendPort = normalizePortCandidate(options.backendPort);
    const resolvedBackendPortBase = normalizePortBase(options.backendPortBase, DEFAULT_BACKEND_PORT_BASE);
    const backendDefaultPort = (packageJsonExists || rootBackendScriptName) ? 3000 : 5000;
    if (preferredBackendPort && preferredBackendPort < resolvedBackendPortBase && hasExplicitBackendBase) {
      preferredBackendPort = null;
    }

    let backendPreferred = preferredBackendPort;
    if (!backendPreferred) {
      backendPreferred = backendDefaultPort >= resolvedBackendPortBase ? backendDefaultPort : null;
    }

    backendPort = await findAvailablePort(backendPreferred, resolvedBackendPortBase, RESERVED_BACKEND_PORTS);
  }

  if (isTestMode) {
    const stubs = buildStubProcesses({
      frontendPort: frontendPort ?? 5173,
      backendPort: backendPort ?? 3000
    });
    return {
      success: true,
      process: stubs[normalizedTarget],
      port: normalizedTarget === 'frontend' ? frontendPort : backendPort
    };
  }

  if (normalizedTarget === 'frontend') {
    await ensureFrontendLanHostBinding(projectPath, { logger: console });

    const proc = spawn('npm', ['run', 'dev', '--', '--host', '0.0.0.0', '--port', String(frontendPort)], {
      cwd: resolvedFrontendPath,
      stdio: 'pipe',
      shell: true,
      env: {
        ...process.env,
        PORT: String(frontendPort),
        HOST: '0.0.0.0',
        HOSTNAME: '0.0.0.0'
      }
    });

    const processInfo = createProcessInfo('frontend', proc, frontendPort);
    return { success: true, process: processInfo, port: frontendPort };
  }

  // backend
  if (packageJsonExists) {
    const backendProcess = spawn('npm', ['run', 'dev'], {
      cwd: backendPath,
      stdio: 'pipe',
      shell: true,
      env: { ...process.env, PORT: String(backendPort) }
    });
    const processInfo = createProcessInfo('backend', backendProcess, backendPort);
    return { success: true, process: processInfo, port: backendPort };
  }

  if (!packageJsonExists && !appPyExists && rootBackendScriptName) {
    const backendProcess = spawn('npm', ['run', rootBackendScriptName], {
      cwd: projectPath,
      stdio: 'pipe',
      shell: true,
      env: { ...process.env, PORT: String(backendPort) }
    });
    const processInfo = createProcessInfo('backend', backendProcess, backendPort);
    return { success: true, process: processInfo, port: backendPort };
  }

  if (!packageJsonExists && appPyExists) {
    let backendProcess;
    if (process.platform === 'win32') {
      const activateScript = path.join(backendPath, 'venv', 'Scripts', 'activate.bat');
      try {
        await fs.access(activateScript);
        backendProcess = spawn('cmd', ['/c', `"${activateScript}" && python app.py`], {
          cwd: backendPath,
          stdio: 'pipe',
          shell: false,
          env: { ...process.env, PORT: String(backendPort) }
        });
      } catch {
        backendProcess = spawn('python', ['app.py'], {
          cwd: backendPath,
          stdio: 'pipe',
          shell: false,
          env: { ...process.env, PORT: String(backendPort) }
        });
      }
    } else {
      const activateScript = path.join(backendPath, 'venv', 'bin', 'activate');
      try {
        await fs.access(activateScript);
        backendProcess = spawn('bash', ['-c', `source "${activateScript}" && python app.py`], {
          cwd: backendPath,
          stdio: 'pipe',
          shell: false,
          env: { ...process.env, PORT: String(backendPort) }
        });
      } catch {
        backendProcess = spawn('python3', ['app.py'], {
          cwd: backendPath,
          stdio: 'pipe',
          shell: false,
          env: { ...process.env, PORT: String(backendPort) }
        });
      }
    }

    const processInfo = createProcessInfo('backend', backendProcess, backendPort);
    return { success: true, process: processInfo, port: backendPort };
  }

  throw new Error('No supported backend entrypoint found');
};
