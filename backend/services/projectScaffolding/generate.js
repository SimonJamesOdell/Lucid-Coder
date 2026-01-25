import path from 'path';
import { templates } from './templates.js';
import { ensureDirectory, sanitizeProjectName, writeFile } from './files.js';

const DEFAULT_PROJECT_VERSION = '0.1.0';

export const generateMainProjectFiles = async (projectPath, config) => {
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

Version: ${DEFAULT_PROJECT_VERSION}

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

## Versioning & Changelog

- Keep release notes in CHANGELOG.md (the workflow can create an "Unreleased" section automatically when needed).
- The project version is tracked in the VERSION file and mirrored into frontend/backend package.json (when present).
- You can manually bump + roll the changelog with:
  \`node tools/bump-version.mjs ${DEFAULT_PROJECT_VERSION}\`

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

  // VERSION
  await writeFile(path.join(projectPath, 'VERSION'), `${DEFAULT_PROJECT_VERSION}\n`);

  // CHANGELOG.md
  const changelogContent = `# Changelog

## ${DEFAULT_PROJECT_VERSION} (${new Date().toISOString().slice(0, 10)})

- Project scaffold created.
`;
  await writeFile(path.join(projectPath, 'CHANGELOG.md'), changelogContent);

  // tools/bump-version.mjs
  await ensureDirectory(path.join(projectPath, 'tools'));
  const bumpScript = `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd());

const usage = () => {
  console.log('Usage: node tools/bump-version.mjs <newVersion> [--dry-run]');
  console.log('Example: node tools/bump-version.mjs 0.1.1');
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const newVersion = args.find((arg) => !arg.startsWith('-'));

if (!newVersion || newVersion === '--help' || newVersion === '-h') {
  usage();
  process.exit(newVersion ? 0 : 1);
}

if (!/^\\d+\\.\\d+\\.\\d+$/.test(newVersion)) {
  console.error('Invalid version:', newVersion);
  console.error('Expected semver like 0.1.1');
  process.exit(1);
}

const updates = [];
const detectEol = (text) => (text.includes('\\r\\n') ? '\\r\\n' : '\\n');
const withEol = (text, eol) => (eol === '\\r\\n' ? text.replace(/\\r?\\n/g, '\\r\\n') : text.replace(/\\r\\n/g, '\\n'));

const updateFile = (relativePath, transform, { ensureTrailingNewline = false } = {}) => {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    return;
  }
  const prev = readFileSync(absolutePath, 'utf8');
  const eol = detectEol(prev);
  const next = transform(prev);
  if (next === prev) {
    return;
  }
  const normalized = withEol(next, eol);
  const finalText = ensureTrailingNewline && !normalized.endsWith(eol) ? normalized + eol : normalized;
  if (!dryRun) {
    writeFileSync(absolutePath, finalText, 'utf8');
  }
  updates.push(relativePath);
};

const updateJsonVersion = (relativePath) => {
  updateFile(
    relativePath,
    (prev) => {
      const eol = detectEol(prev);
      const parsed = JSON.parse(prev);
      const next = { ...parsed, version: newVersion };
      return withEol(JSON.stringify(next, null, 2) + '\\n', eol);
    },
    { ensureTrailingNewline: true }
  );
};

const rollChangelog = (text) => {
  const eol = detectEol(text);
  const normalized = withEol(text, '\\n');
  const match = normalized.match(/^##\\s+Unreleased\\s*$/im);
  if (!match || match.index == null) {
    return text;
  }
  const start = match.index + match[0].length;
  const rest = normalized.slice(start);
  const nextHeading = rest.search(/^##\\s+/m);
  const body = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).replace(/^\n+/, '');
  const entries = body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => /^-\\s+\\S+/.test(line.trim()));
  if (!entries.length) {
    return text;
  }
  const tail = nextHeading === -1 ? '' : rest.slice(nextHeading);
  const date = new Date().toISOString().slice(0, 10);
  const injected = '\n\n## ' + newVersion + ' (' + date + ')\n\n' + entries.join('\n') + '\n';
  const clearedUnreleased = '\n\n- (Add notes for your next merge here)\n';
  const rebuilt = normalized.slice(0, match.index) + match[0] + clearedUnreleased + injected + tail.replace(/^\n+/, '\n');
  return withEol(rebuilt, eol);
};

updateFile('VERSION', () => newVersion + '\n', { ensureTrailingNewline: true });
updateFile('CHANGELOG.md', (text) => rollChangelog(text), { ensureTrailingNewline: true });
updateJsonVersion('frontend/package.json');
updateJsonVersion('backend/package.json');

console.log((dryRun ? 'Would bump' : 'Bumped') + ' version to ' + newVersion);
if (updates.length) {
  console.log((dryRun ? 'Would update' : 'Updated') + ':');
  for (const file of updates) {
    console.log('- ' + file);
  }
} else {
  console.log('No files changed.');
}
`;
  await writeFile(path.join(projectPath, 'tools', 'bump-version.mjs'), bumpScript);

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

export const generateFrontendFiles = async (frontendPath, config) => {
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

export const generateBackendFiles = async (backendPath, config) => {
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

export { templates };
