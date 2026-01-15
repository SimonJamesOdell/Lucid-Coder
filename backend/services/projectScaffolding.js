import fs from 'fs/promises';
import path from 'path';
import net from 'net';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { PROJECT_CREATION_STEPS } from '../constants/progressSteps.js';
import { buildProgressPayload } from './progressTracker.js';
import {
  runGitCommand,
  ensureGitRepository,
  configureGitUser,
  ensureInitialCommit
} from '../utils/git.js';
import { templates } from './projectScaffolding/templates.js';

const execAsync = promisify(exec);
const FORCE_REAL_START = process.env.LUCIDCODER_FORCE_REAL_START === 'true';
const isTestMode = process.env.NODE_ENV === 'test' && !FORCE_REAL_START;
const MAX_LOG_LINES = 200;

const looksLikeWindowsLock = (error, platform = process.platform) => {
  if (platform !== 'win32') {
    return false;
  }
  const text = `${error?.message || ''}\n${error?.stderr || ''}\n${error?.stdout || ''}`.toLowerCase();
  return text.includes('eperm') || text.includes('ebusy') || text.includes('eacces') || text.includes('enotempty');
};

const sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

const execWithRetry = async (
  execFn,
  command,
  options,
  {
    maxBuffer,
    delays = [500, 1500, 3000],
    platform = process.platform,
    sleepFn = sleep
  } = {}
) => {
  try {
    return await execFn(command, { ...(options || {}), maxBuffer });
  } catch (error) {
    if (!looksLikeWindowsLock(error, platform)) {
      throw error;
    }

    let lastError = error;
    for (const delay of delays) {
      await sleepFn(delay);
      try {
        return await execFn(command, { ...(options || {}), maxBuffer });
      } catch (nextError) {
        lastError = nextError;
        if (!looksLikeWindowsLock(nextError, platform)) {
          break;
        }
      }
    }
    throw lastError;
  }
};

const buildExecErrorTail = (error) => {
  const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
  const stdout = typeof error?.stdout === 'string' ? error.stdout : '';
  const combined = [stderr, stdout].filter(Boolean).join('\n');
  if (!combined) {
    return '';
  }
  const tail = combined.split(/\r?\n/).slice(-40).join('\n');
  return `\n${tail}`;
};
const DEFAULT_FRONTEND_PORT_BASE = Number(process.env.LUCIDCODER_PROJECT_FRONTEND_PORT_BASE) || 5100;
const DEFAULT_BACKEND_PORT_BASE = Number(process.env.LUCIDCODER_PROJECT_BACKEND_PORT_BASE) || 5500;
const RESERVED_FRONTEND_PORTS = new Set(
  (process.env.LUCIDCODER_HOST_PORTS || process.env.VITE_PORT || '5173,3000')
    .split(',')
    .map((token) => Number.parseInt(token.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0)
);

const RESERVED_BACKEND_PORTS = new Set(
  (process.env.LUCIDCODER_BACKEND_HOST_PORTS || '5000')
    .split(',')
    .map((token) => Number.parseInt(token.trim(), 10))
    .filter((port) => Number.isInteger(port) && port > 0)
);

if (!RESERVED_FRONTEND_PORTS.size) {
  RESERVED_FRONTEND_PORTS.add(5173);
}

if (!RESERVED_BACKEND_PORTS.size) {
  RESERVED_BACKEND_PORTS.add(5000);
}

const normalizePortCandidate = (value) => {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
};

const normalizePortBase = (value, fallback) => {
  const normalized = normalizePortCandidate(value);
  if (!normalized) {
    return fallback;
  }
  if (normalized < 1024 || normalized > 65535) {
    return fallback;
  }
  return normalized;
};

const buildPortOverrideOptions = (settings = {}) => {
  const overrides = {};
  const frontendBase = normalizePortCandidate(settings?.frontendPortBase);
  const backendBase = normalizePortCandidate(settings?.backendPortBase);

  if (frontendBase) {
    overrides.frontendPortBase = frontendBase;
  }
  if (backendBase) {
    overrides.backendPortBase = backendBase;
  }

  return overrides;
};

const isPortAvailable = (port) =>
  new Promise((resolve) => {
    const server = net.createServer();

    server.unref();

    server.once('error', () => {
      server.close(() => resolve(false));
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, '0.0.0.0');
  });

const findAvailablePort = async (preferredPort, fallbackBase, blockedPorts = RESERVED_FRONTEND_PORTS) => {
  const attempts = [];
  const cleanedPreferred = normalizePortCandidate(preferredPort);
  if (cleanedPreferred && !blockedPorts.has(cleanedPreferred)) {
    attempts.push(cleanedPreferred);
  }

  const base = fallbackBase || 6000;
  for (let offset = 0; offset < 2000; offset += 1) {
    const candidate = base + offset;
    if (blockedPorts.has(candidate)) {
      continue;
    }
    if (cleanedPreferred && candidate === cleanedPreferred) {
      continue;
    }
    attempts.push(candidate);
  }

  for (const candidate of attempts) {
    // eslint-disable-next-line no-await-in-loop
    const available = await isPortAvailable(candidate);
    if (available) {
      return candidate;
    }
  }

  throw new Error('Unable to find an available port');
};

const createProcessInfo = (type, childProcess, port) => {
  const now = new Date().toISOString();

  const processInfo = {
    pid: childProcess?.pid ?? null,
    port: port ?? null,
    type,
    status: childProcess ? 'running' : 'stopped',
    startedAt: childProcess ? now : null,
    endedAt: null,
    lastHeartbeat: childProcess ? now : null,
    logs: [],
    exitCode: null,
    signal: null,
    isStub: false
  };

  if (!childProcess) {
    return processInfo;
  }

  const pushLog = (stream, message) => {
    const trimmed = String(message).trim();
    if (!trimmed) {
      return;
    }

    processInfo.lastHeartbeat = new Date().toISOString();
    processInfo.logs.push({
      timestamp: processInfo.lastHeartbeat,
      stream,
      message: trimmed
    });

    if (processInfo.logs.length > MAX_LOG_LINES) {
      processInfo.logs.splice(0, processInfo.logs.length - MAX_LOG_LINES);
    }
  };

  const handleChunk = (stream) => (chunk) => {
    if (!chunk) return;
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      pushLog(stream, line);
    }
  };

  childProcess.stdout?.on?.('data', handleChunk('stdout'));
  childProcess.stderr?.on?.('data', handleChunk('stderr'));

  childProcess.on?.('error', (error) => {
    const code = Number.isInteger(error?.code) ? error.code : null;
    processInfo.status = 'error';
    processInfo.endedAt = new Date().toISOString();
    processInfo.exitCode = code;
    pushLog('error', error?.message || 'Process error');
  });

  childProcess.on?.('exit', (code, signal) => {
    processInfo.status = 'stopped';
    processInfo.endedAt = new Date().toISOString();
    processInfo.signal = signal ?? null;

    if (Number.isInteger(code)) {
      processInfo.exitCode = code;
    }
  });

  return processInfo;
};

const buildStubProcesses = (overrides = {}) => {
  const now = new Date().toISOString();
  return {
    frontend: {
      pid: overrides.frontendPid ?? 10001,
      port: overrides.frontendPort ?? 5173,
      type: 'frontend',
      status: overrides.frontendStatus ?? 'running',
      startedAt: overrides.frontendStartedAt ?? now,
      lastHeartbeat: overrides.frontendLastHeartbeat ?? now,
      logs: overrides.frontendLogs ?? [],
      isStub: true
    },
    backend: {
      pid: overrides.backendPid ?? 10002,
      port: overrides.backendPort ?? 3000,
      type: 'backend',
      status: overrides.backendStatus ?? 'running',
      startedAt: overrides.backendStartedAt ?? now,
      lastHeartbeat: overrides.backendLastHeartbeat ?? now,
      logs: overrides.backendLogs ?? [],
      isStub: true
    }
  };
};

// Utility functions
const sanitizeProjectName = (name) => {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-');
};

const ensureDirectory = async (dirPath) => {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
};

const writeFile = async (filePath, content) => {
  await ensureDirectory(path.dirname(filePath));
  
  // Handle different content types
  if (content === undefined || content === null) {
    throw new Error(`Content is undefined for file: ${filePath}`);
  }
  
  if (typeof content === 'object') {
    content = JSON.stringify(content, null, 2);
  } else if (typeof content !== 'string') {
    content = String(content);
  }
  
  await fs.writeFile(filePath, content);
};

const pathExists = async (targetPath) => {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
};

const initializeGitRepository = async (projectPath, gitOptions = {}) => {
  if (!projectPath) {
    throw new Error('Project path is required to initialize git.');
  }

  const defaultBranch = (gitOptions.defaultBranch || 'main').trim() || 'main';
  console.log('🔧 Initializing git repository...');

  await ensureGitRepository(projectPath, { defaultBranch });

  const remoteUrl = typeof gitOptions.remoteUrl === 'string' ? gitOptions.remoteUrl.trim() : '';
  if (remoteUrl) {
    try {
      await runGitCommand(projectPath, ['remote', 'add', 'origin', remoteUrl]);
    } catch (remoteError) {
      if (!/already exists/i.test(remoteError.message || '')) {
        console.error('❌ Failed to configure git remote:', remoteError.message);
        throw new Error(remoteError.message || 'Failed to configure git remote');
      }
    }
  }

  await configureGitUser(projectPath, {
    name: gitOptions.username,
    email: gitOptions.email || (gitOptions.username ? `${gitOptions.username}@users.noreply.github.com` : undefined)
  });

  await ensureInitialCommit(projectPath, 'Initial commit');

  return { initialized: true, branch: defaultBranch, remote: remoteUrl || null };
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

const generateMainProjectFiles = async (projectPath, config) => {
  const { name, description, frontend, backend } = config;

  const frontendTemplate = templates.frontend?.[frontend.framework]?.[frontend.language];
  const backendTemplate = templates.backend?.[backend.framework]?.[backend.language];

  const frontendPackageJson = frontendTemplate?.packageJson ? frontendTemplate.packageJson(sanitizeProjectName(name)) : null;
  const backendPackageJson = backendTemplate?.packageJson ? backendTemplate.packageJson(sanitizeProjectName(name)) : null;

  const hasFrontendE2E = Boolean(frontendPackageJson?.scripts?.['test:e2e']);
  const hasFrontendPlaywright = Boolean(frontendPackageJson?.devDependencies?.['@playwright/test']);
  const hasBackendE2E = Boolean(backendPackageJson?.scripts?.['test:e2e']);

  // README.md
  const readmeContent = `# ${name}

${description || 'A full-stack web application'}

## Project Structure

- \`frontend/\` - ${frontend.framework} (${frontend.language}) frontend application
- \`backend/\` - ${backend.framework} (${backend.language}) backend API

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
${backend.language === 'python' ? '- Python (v3.8 or higher)' : ''}

### Installation

1. Install frontend dependencies:
   \`\`\`bash
   cd frontend
   npm install
   \`\`\`

2. Install backend dependencies:
   \`\`\`bash
   cd backend
   ${backend.language === 'python' ? 'pip install -r requirements.txt' : 'npm install'}
   \`\`\`

### Development

1. Start the backend server:
   \`\`\`bash
   cd backend
   ${backend.language === 'python' ? 'python app.py' : 'npm run dev'}
   \`\`\`

2. Start the frontend development server:
   \`\`\`bash
   cd frontend
   npm run dev
   \`\`\`

The frontend will be available at http://localhost:5173 and the backend at http://localhost:${backend.language === 'python' ? '5000' : '3000'}.

## Testing

### Frontend

- Run unit tests:
  \`\`\`bash
  cd frontend
  npm test
  \`\`\`

- Run coverage:
  \`\`\`bash
  cd frontend
  npm run test:coverage
  \`\`\`

${hasFrontendE2E ? `- Run end-to-end tests:
  \`\`\`bash
  cd frontend
  npm run test:e2e
  \`\`\`

${hasFrontendPlaywright ? `- One-time Playwright browser install (required before the first E2E run):
  \`\`\`bash
  cd frontend
  npx playwright install
  \`\`\`
` : ''}` : ''}
${hasBackendE2E ? `### Backend (Express)

- Run unit tests:
  \`\`\`bash
  cd backend
  npm test
  \`\`\`

- Run end-to-end tests:
  \`\`\`bash
  cd backend
  npm run test:e2e
  \`\`\`
` : ''}
${backend.language === 'python' ? `### Backend (Flask)

- Run unit tests:
  \`\`\`bash
  cd backend
  pytest
  \`\`\`

- Run coverage:
  \`\`\`bash
  cd backend
  pytest --cov
  \`\`\`

- Run end-to-end (marked) tests:
  \`\`\`bash
  cd backend
  pytest -m e2e
  \`\`\`
` : ''}

## Features

- Modern ${frontend.framework} frontend
- ${backend.framework} backend API
- CORS enabled for development
- Hot reload for both frontend and backend
- Environment configuration

## License

MIT
`;

  await writeFile(path.join(projectPath, 'README.md'), readmeContent);

  // .gitignore
  const gitignoreContent = `# Dependencies
node_modules/
__pycache__/
*.pyc
*.pyo
*.pyd
.Python
env/
venv/
.venv/

# Build outputs
dist/
build/
.next/

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*
*.log

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Temporary files
*.tmp
*.temp
.cache/

# Database
*.db
*.sqlite
*.sqlite3
`;

  await writeFile(path.join(projectPath, '.gitignore'), gitignoreContent);
};

const generateFrontendFiles = async (frontendPath, config) => {
  const { name, language, framework } = config;

  if (!templates.frontend[framework] || !templates.frontend[framework][language]) {
    throw new Error(`Unsupported frontend combination: ${framework} with ${language}`);
  }

  const template = templates.frontend[framework][language];
  const isReact = framework === 'react';
  const isVue = framework === 'vue';

  // Create src directory and test directories
  await ensureDirectory(path.join(frontendPath, 'src'));
  await ensureDirectory(path.join(frontendPath, 'src', '__tests__'));
  await ensureDirectory(path.join(frontendPath, 'src', 'test'));
  await ensureDirectory(path.join(frontendPath, 'public'));

  // Package.json
  await writeFile(path.join(frontendPath, 'package.json'), template.packageJson(name));

  // Vite config
  if (template.viteConfig) {
    const configExt = language === 'typescript' ? 'ts' : 'js';
    await writeFile(path.join(frontendPath, `vite.config.${configExt}`), template.viteConfig);
  }

  // Vitest config for testing
  if (template.vitestConfig) {
    const configExt = language === 'typescript' ? 'ts' : 'js';
    await writeFile(path.join(frontendPath, `vitest.config.${configExt}`), template.vitestConfig);
  }

  // Index.html
  if (template.indexHtml) {
    await writeFile(path.join(frontendPath, 'index.html'), template.indexHtml(name));
  }

  // TypeScript config files
  if (language === 'typescript') {
    await writeFile(path.join(frontendPath, 'tsconfig.json'), template.tsConfig);
    await writeFile(path.join(frontendPath, 'tsconfig.node.json'), template.tsConfigNode);
  }

  // Source files
  if (isReact) {
    const ext = language === 'typescript' ? 'tsx' : 'jsx';
    const testExt = language === 'typescript' ? 'tsx' : 'jsx';
    const setupExt = language === 'typescript' ? 'ts' : 'js';
    
    await writeFile(path.join(frontendPath, 'src', `main.${ext}`), 
      language === 'typescript' ? template.mainTsx : template.mainJsx);
    await writeFile(path.join(frontendPath, 'src', `App.${ext}`), 
      language === 'typescript' ? template.appTsx(name) : template.appJsx(name));
    await writeFile(path.join(frontendPath, 'src', 'App.css'), template.appCss);
    await writeFile(path.join(frontendPath, 'src', 'index.css'), template.indexCss);
    
    // Test files
    await writeFile(path.join(frontendPath, 'src', 'test', `setup.${setupExt}`), 
      language === 'typescript' ? template.testSetupTs : template.testSetup);
    await writeFile(path.join(frontendPath, 'src', '__tests__', `App.test.${testExt}`), 
      language === 'typescript' ? template.appTestTsx(name) : template.appTestJsx(name));
    await writeFile(path.join(frontendPath, 'src', '__tests__', `utils.test.${setupExt}`), 
      language === 'typescript' ? template.utilsTestTs : template.utilsTestJs);

    if (template.playwrightConfig) {
      const configExt = language === 'typescript' ? 'ts' : 'js';
      await writeFile(path.join(frontendPath, `playwright.config.${configExt}`), template.playwrightConfig);
    }

    if (template.e2eTest) {
      await ensureDirectory(path.join(frontendPath, 'e2e'));
      await writeFile(path.join(frontendPath, 'e2e', 'app.spec.js'), template.e2eTest(name));
    }
  }

  if (isVue) {
    await writeFile(path.join(frontendPath, 'src', 'main.js'), template.mainJs);
    await writeFile(path.join(frontendPath, 'src', 'App.vue'), template.appVue(name));
    await writeFile(path.join(frontendPath, 'src', 'style.css'), template.styleCss);

    if (template.vitestConfig) {
      await writeFile(path.join(frontendPath, 'vitest.config.js'), template.vitestConfig);
    }

    if (template.testSetup) {
      await writeFile(path.join(frontendPath, 'src', 'test', 'setup.js'), template.testSetup);
    }

    if (template.appTestJs) {
      await writeFile(path.join(frontendPath, 'src', '__tests__', 'App.test.js'), template.appTestJs(name));
    }

    if (template.playwrightConfig) {
      await writeFile(path.join(frontendPath, 'playwright.config.js'), template.playwrightConfig);
    }

    if (template.e2eTest) {
      await ensureDirectory(path.join(frontendPath, 'e2e'));
      await writeFile(path.join(frontendPath, 'e2e', 'app.spec.js'), template.e2eTest(name));
    }
  }

  // Public assets
  await writeFile(path.join(frontendPath, 'public', 'vite.svg'), 
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><title>vite</title><path fill="#41d1ff" d="M29.8836 6.146L16.7418 29.6457c-.2714.4851-.9684.488-1.2439.0051L2.1177 6.1482c-.3051-.5351.1565-1.2078.7646-1.1169L16 7.5417l13.1179-2.5077c.6081-.0909 1.0697.5818.7657 1.1119z"/><path fill="#41d1ff" d="m22.2059 21.146-6.7605 12.0968c-.2714.4851-.9684.488-1.2439.0051L.8232 6.1482c-.3051-.5351.1565-1.2078.7646-1.1169L16 7.5417l13.1179-2.5077c.6081-.0909 1.0697.5818.7657 1.1119z" opacity=".5"/></svg>');
};

const generateBackendFiles = async (backendPath, config) => {
  const { name, language, framework } = config;

  if (!templates.backend[framework] || !templates.backend[framework][language]) {
    throw new Error(`Unsupported backend combination: ${framework} with ${language}`);
  }

  const template = templates.backend[framework][language];
  const isExpress = framework === 'express';
  const isFlask = framework === 'flask';

  if (isExpress) {
    // Create necessary directories
    await ensureDirectory(path.join(backendPath, 'routes'));
    if (language === 'typescript') {
      await ensureDirectory(path.join(backendPath, 'src'));
      await ensureDirectory(path.join(backendPath, 'src', '__tests__'));
      await ensureDirectory(path.join(backendPath, 'src', 'test'));
    } else {
      await ensureDirectory(path.join(backendPath, '__tests__'));
      await ensureDirectory(path.join(backendPath, 'test'));
    }

    // Package.json
    await writeFile(path.join(backendPath, 'package.json'), template.packageJson(name));

    // Server file
    if (language === 'typescript') {
      await writeFile(path.join(backendPath, 'src', 'server.ts'), template.serverTs(name));
      await writeFile(path.join(backendPath, 'tsconfig.json'), template.tsConfig);
    } else {
      await writeFile(path.join(backendPath, 'server.js'), template.serverJs(name));
    }

    // Environment file
    await writeFile(path.join(backendPath, '.env.example'), template.envExample);
    await writeFile(path.join(backendPath, '.env'), template.envExample);

    if (language === 'javascript' && template.babelConfig) {
      await writeFile(path.join(backendPath, 'babel.config.cjs'), template.babelConfig);
    }
    
  // Test configuration and files
  if (language === 'typescript') {
    await writeFile(path.join(backendPath, 'jest.config.ts'), template.jestConfigTs);
    await writeFile(path.join(backendPath, 'src', 'test', 'setup.ts'), template.setupTestsTs);
    await writeFile(path.join(backendPath, 'src', '__tests__', 'app.test.ts'), template.appTestTs(name));
    await writeFile(path.join(backendPath, 'src', '__tests__', 'api.test.ts'), template.apiTestTs(name));
    await writeFile(path.join(backendPath, 'src', '__tests__', 'server.test.ts'), template.serverTestTs(name));
    await writeFile(path.join(backendPath, 'src', '__tests__', 'routes.test.ts'), template.routesTestTs);

      if (template.e2eHttpTestTs) {
        await writeFile(path.join(backendPath, 'src', '__tests__', 'e2e.http.test.ts'), template.e2eHttpTestTs(name));
      }
  } else {
    await writeFile(path.join(backendPath, 'jest.config.js'), template.jestConfig);
    await writeFile(path.join(backendPath, 'test', 'setup.js'), template.setupTests);
    await writeFile(path.join(backendPath, '__tests__', 'app.test.js'), template.appTestJs(name));
    await writeFile(path.join(backendPath, '__tests__', 'api.test.js'), template.apiTestJs(name));
    await writeFile(path.join(backendPath, '__tests__', 'server.test.js'), template.serverTestJs(name));
      await writeFile(path.join(backendPath, '__tests__', 'routes.test.js'), template.routesTestJs);

      if (template.e2eHttpTestJs) {
        await writeFile(path.join(backendPath, '__tests__', 'e2e.http.test.js'), template.e2eHttpTestJs(name));
      }
    }
  }

  if (isFlask) {
    // Python Flask setup
    await writeFile(path.join(backendPath, 'requirements.txt'), template.requirementsTxt);
    await writeFile(path.join(backendPath, 'app.py'), template.appPy(name));
    await writeFile(path.join(backendPath, '.env.example'), template.envExample);
    await writeFile(path.join(backendPath, '.env'), template.envExample);

    if (template.pytestIni) {
      await writeFile(path.join(backendPath, 'pytest.ini'), template.pytestIni);
    }

    if (template.testAppPy) {
      await ensureDirectory(path.join(backendPath, 'tests'));
      await writeFile(path.join(backendPath, 'tests', 'test_app.py'), template.testAppPy(name));
    }
  }
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
    return {
      success: true,
      processes: buildStubProcesses({
        frontendPort,
        backendPort
      })
    };
  }

  const processes = {
    frontend: null,
    backend: null
  };

  try {
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

    // Give backend a moment to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Start frontend
    console.log('🚀 Starting frontend development server...');
    const frontendProcess = spawn('npm', ['run', 'dev', '--', '--port', String(frontendPort)], { 
      cwd: frontendPath, 
      stdio: 'pipe',
      shell: true 
    });
    processes.frontend = createProcessInfo('frontend', frontendProcess, frontendPort);

    console.log('✅ Project started successfully');
    console.log(`Frontend: http://localhost:${processes.frontend.port}`);
    console.log(`Backend: http://localhost:${processes.backend.port}`);

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
  snapshotReservedPorts: () => ({
    frontend: Array.from(RESERVED_FRONTEND_PORTS),
    backend: Array.from(RESERVED_BACKEND_PORTS)
  })
};