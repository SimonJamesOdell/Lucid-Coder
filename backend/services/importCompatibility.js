import fs from 'fs/promises';
import path from 'path';

const DEFAULT_CROSS_ENV_VERSION = '^7.0.3';

const safeString = (value) => (typeof value === 'string' ? value.trim() : '');

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

const writeJsonFile = async (filePath, data) => {
  const json = JSON.stringify(data, null, 2) + '\n';
  await fs.writeFile(filePath, json, 'utf-8');
};

const getDependencyMap = (pkg = {}) => ({
  ...(pkg.dependencies || {}),
  ...(pkg.devDependencies || {})
});

const hasDependency = (deps, name) => Object.prototype.hasOwnProperty.call(deps, name);

const resolveFrontendPackageJson = async (projectPath) => {
  const frontendPath = path.join(projectPath, 'frontend', 'package.json');
  const rootPath = path.join(projectPath, 'package.json');

  if (await fileExists(frontendPath)) {
    return frontendPath;
  }

  if (await fileExists(rootPath)) {
    return rootPath;
  }

  return null;
};

const buildStructurePlan = async (projectPath) => {
  const frontendDir = path.join(projectPath, 'frontend');
  const backendDir = path.join(projectPath, 'backend');
  const rootPackageJson = path.join(projectPath, 'package.json');

  const hasFrontendDir = await dirExists(frontendDir);
  if (hasFrontendDir) {
    return { needsMove: false, reason: 'frontend directory already exists' };
  }

  const hasBackendDir = await dirExists(backendDir);
  if (hasBackendDir) {
    return { needsMove: false, reason: 'backend directory exists' };
  }

  if (!(await fileExists(rootPackageJson))) {
    return { needsMove: false, reason: 'root package.json not found' };
  }

  return {
    needsMove: true,
    reason: 'frontend files are at project root'
  };
};

const moveEntry = async (sourcePath, destPath) => {
  try {
    await fs.rename(sourcePath, destPath);
    return;
  } catch (error) {
    if (error?.code !== 'EXDEV') {
      throw error;
    }
  }

  const stats = await fs.stat(sourcePath);
  if (stats.isDirectory()) {
    await fs.cp(sourcePath, destPath, { recursive: true });
    await fs.rm(sourcePath, { recursive: true, force: true });
    return;
  }

  await fs.copyFile(sourcePath, destPath);
  await fs.rm(sourcePath, { force: true });
};

export const applyProjectStructure = async (projectPath) => {
  const plan = await buildStructurePlan(projectPath);
  if (!plan.needsMove) {
    return { applied: false, plan };
  }

  const frontendDir = path.join(projectPath, 'frontend');
  await fs.mkdir(frontendDir, { recursive: true });

  const entries = await fs.readdir(projectPath, { withFileTypes: true });
  const skipped = new Set(['frontend', 'backend', 'node_modules', '.git']);

  for (const entry of entries) {
    if (skipped.has(entry.name)) {
      continue;
    }

    const sourcePath = path.join(projectPath, entry.name);
    const destPath = path.join(frontendDir, entry.name);
    await moveEntry(sourcePath, destPath);
  }

  return { applied: true, plan };
};

const normalizeScript = (value) => safeString(value);

const appendArgIfMissing = (script, flag, value) => {
  if (!script) {
    return script;
  }
  const pattern = new RegExp(`\\B${flag}(=|\\s)`, 'i');
  if (pattern.test(script)) {
    return script;
  }
  return `${script} ${flag} ${value}`.trim();
};

const ensurePrefix = (script, prefix) => {
  const trimmed = normalizeScript(script);
  if (!trimmed) {
    return `${prefix}`.trim();
  }
  if (trimmed.startsWith(prefix)) {
    return trimmed;
  }
  return `${prefix} ${trimmed}`.trim();
};

const injectHostIntoCrossEnv = (script) => {
  const trimmed = normalizeScript(script);
  if (!trimmed) {
    return trimmed;
  }
  const match = trimmed.match(/^cross-env\s+/i);
  if (!match) {
    return ensurePrefix(trimmed, 'cross-env HOST=0.0.0.0');
  }
  const prefixLength = match[0].length;
  return `${match[0]}HOST=0.0.0.0 ${trimmed.slice(prefixLength)}`.trim();
};

const detectFramework = ({ deps, scripts }) => {
  const scriptValues = Object.values(scripts || {}).map((value) => safeString(value));

  if (hasDependency(deps, 'next') || scriptValues.some((value) => value.includes('next dev'))) {
    return 'next';
  }

  if (
    hasDependency(deps, 'react-scripts') ||
    hasDependency(deps, '@craco/craco') ||
    scriptValues.some((value) => value.includes('react-scripts start')) ||
    scriptValues.some((value) => value.includes('craco start'))
  ) {
    return 'cra';
  }

  if (hasDependency(deps, 'vite') || scriptValues.some((value) => value.includes('vite'))) {
    return 'vite';
  }

  return 'unknown';
};

const buildCompatibilityPlan = ({ pkg, packageJsonPath }) => {
  const scripts = { ...(pkg.scripts || {}) };
  const deps = getDependencyMap(pkg);
  const framework = detectFramework({ deps, scripts });
  const changes = [];
  let needsCrossEnv = false;

  const currentDev = normalizeScript(scripts.dev);

  if (framework === 'vite') {
    const nextDev = currentDev
      ? appendArgIfMissing(currentDev, '--host', '0.0.0.0')
      : 'vite --host 0.0.0.0';

    if (nextDev && nextDev !== currentDev) {
      changes.push({
        type: 'script',
        key: 'scripts.dev',
        before: currentDev || null,
        after: nextDev,
        description: 'Bind Vite dev server to 0.0.0.0'
      });
    }
  }

  if (framework === 'next') {
    const nextDev = currentDev
      ? appendArgIfMissing(currentDev, '-H', '0.0.0.0')
      : 'next dev -H 0.0.0.0';

    if (nextDev && nextDev !== currentDev) {
      changes.push({
        type: 'script',
        key: 'scripts.dev',
        before: currentDev || null,
        after: nextDev,
        description: 'Bind Next.js dev server to 0.0.0.0'
      });
    }
  }

  if (framework === 'cra') {
    const usesCraco = hasDependency(deps, '@craco/craco') || currentDev.includes('craco start');
    const baseCmd = usesCraco ? 'craco start' : 'react-scripts start';
    const hasHostEnv = /\bHOST=/.test(currentDev);

    if (!currentDev) {
      const nextDev = `cross-env HOST=0.0.0.0 ${baseCmd}`.trim();
      changes.push({
        type: 'script',
        key: 'scripts.dev',
        before: null,
        after: nextDev,
        description: 'Add CRA dev script with HOST=0.0.0.0'
      });
      needsCrossEnv = true;
    } else if (currentDev.includes(baseCmd) && !hasHostEnv) {
      const nextDev = injectHostIntoCrossEnv(currentDev);
      changes.push({
        type: 'script',
        key: 'scripts.dev',
        before: currentDev,
        after: nextDev,
        description: 'Ensure CRA dev script binds HOST=0.0.0.0'
      });
      needsCrossEnv = true;
    }

    const hasCrossEnv = hasDependency(deps, 'cross-env');
    if (needsCrossEnv && !hasCrossEnv) {
      changes.push({
        type: 'dependency',
        key: 'devDependencies.cross-env',
        before: pkg.devDependencies?.['cross-env'] || null,
        after: DEFAULT_CROSS_ENV_VERSION,
        description: 'Add cross-env for HOST binding'
      });
    }
  }

  return {
    framework,
    packageJsonPath,
    changes,
    needsChanges: changes.length > 0
  };
};

export const scanCompatibility = async (projectPath) => {
  const packageJsonPath = await resolveFrontendPackageJson(projectPath);
  const structurePlan = await buildStructurePlan(projectPath);
  if (!packageJsonPath) {
    return {
      supported: false,
      needsChanges: false,
      framework: 'unknown',
      reason: 'No package.json found',
      changes: [],
      structure: structurePlan
    };
  }

  const pkg = await readJsonFile(packageJsonPath);
  const plan = buildCompatibilityPlan({ pkg, packageJsonPath });

  return {
    supported: plan.framework !== 'unknown',
    needsChanges: plan.needsChanges,
    framework: plan.framework,
    changes: plan.changes,
    packageJsonPath: plan.packageJsonPath,
    structure: structurePlan
  };
};

export const applyCompatibility = async (projectPath) => {
  const scan = await scanCompatibility(projectPath);
  if (!scan.needsChanges || !scan.packageJsonPath) {
    return { applied: false, plan: scan };
  }

  const pkg = await readJsonFile(scan.packageJsonPath);
  const scripts = { ...(pkg.scripts || {}) };
  const devDependencies = { ...(pkg.devDependencies || {}) };

  for (const change of scan.changes) {
    if (change.type === 'script' && change.key === 'scripts.dev') {
      scripts.dev = change.after;
    }
    if (change.type === 'dependency' && change.key === 'devDependencies.cross-env') {
      devDependencies['cross-env'] = change.after;
    }
  }

  pkg.scripts = scripts;
  if (Object.keys(devDependencies).length > 0) {
    pkg.devDependencies = devDependencies;
  }

  await writeJsonFile(scan.packageJsonPath, pkg);

  return { applied: true, plan: scan };
};

export const __compatibilityInternals = {
  buildCompatibilityPlan,
  detectFramework,
  injectHostIntoCrossEnv,
  appendArgIfMissing,
  ensurePrefix,
  resolveFrontendPackageJson,
  buildStructurePlan
};
