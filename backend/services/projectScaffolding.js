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

const execAsync = promisify(exec);
const FORCE_REAL_START = process.env.LUCIDCODER_FORCE_REAL_START === 'true';
const isTestMode = process.env.NODE_ENV === 'test' && !FORCE_REAL_START;
// Main scaffolding functions
export const generateProjectFiles = async (projectConfig) => {
  const { name, description, frontend, backend, path: projectPath } = projectConfig;
  
  if (!name || !name.trim()) {
    throw new Error('Project name is required');
  }

  const sanitizedName = sanitizeProjectName(name);
  const frontendPath = path.join(projectPath, 'frontend');
  const backendPath = path.join(projectPath, 'backend');

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
  const maxBuffer = 1024 * 1024 * 50; // 50MB to tolerate noisy installers

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

  console.log('📦 Installing frontend dependencies...');
  try {
    // If a previous create attempt partially installed deps, start from a clean slate.
    await removePathIfPresent(path.join(frontendPath, 'node_modules'));
    await removePathIfPresent(path.join(frontendPath, 'package-lock.json'));
    await execWithRetry(execAsync, 'npm install', { cwd: frontendPath }, { maxBuffer });
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
      await execWithRetry(execAsync, 'npm install', { cwd: backendPath }, { maxBuffer });
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

  let preferredFrontendPort = normalizePortCandidate(options.frontendPort);
  if (preferredFrontendPort && RESERVED_FRONTEND_PORTS.has(preferredFrontendPort)) {
    preferredFrontendPort = null;
  }

  const packageJsonPath = path.join(backendPath, 'package.json');
  const appPyPath = path.join(backendPath, 'app.py');

  const packageJsonExists = await fs.access(packageJsonPath).then(() => true).catch(() => false);
  const appPyExists = await fs.access(appPyPath).then(() => true).catch(() => false);

  const hasExplicitFrontendBase = Object.prototype.hasOwnProperty.call(options, 'frontendPortBase');
  const resolvedFrontendPortBase = normalizePortBase(options.frontendPortBase, DEFAULT_FRONTEND_PORT_BASE);
  if (preferredFrontendPort && preferredFrontendPort < resolvedFrontendPortBase && hasExplicitFrontendBase) {
    preferredFrontendPort = null;
  }
  const frontendPort = await findAvailablePort(preferredFrontendPort, resolvedFrontendPortBase, RESERVED_FRONTEND_PORTS);

  let preferredBackendPort = normalizePortCandidate(options.backendPort);
  const hasExplicitBackendBase = Object.prototype.hasOwnProperty.call(options, 'backendPortBase');
  const resolvedBackendPortBase = normalizePortBase(options.backendPortBase, DEFAULT_BACKEND_PORT_BASE);
  const backendDefaultPort = packageJsonExists ? 3000 : 5000;
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
    }

    if (shouldStartFrontend) {
      // Give backend a moment to start when we're launching both.
      if (shouldStartBackend) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      console.log('🚀 Starting frontend development server...');
      const frontendProcess = spawn('npm', ['run', 'dev', '--', '--port', String(frontendPort)], {
        cwd: frontendPath,
        stdio: 'pipe',
        shell: true
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

export const __testing = {
  MAX_LOG_LINES,
  looksLikeWindowsLock,
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

  const packageJsonPath = path.join(backendPath, 'package.json');
  const appPyPath = path.join(backendPath, 'app.py');
  const packageJsonExists = await fs.access(packageJsonPath).then(() => true).catch(() => false);
  const appPyExists = await fs.access(appPyPath).then(() => true).catch(() => false);

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
    const backendDefaultPort = packageJsonExists ? 3000 : 5000;
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
    const proc = spawn('npm', ['run', 'dev', '--', '--port', String(frontendPort)], {
      cwd: frontendPath,
      stdio: 'pipe',
      shell: true
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
