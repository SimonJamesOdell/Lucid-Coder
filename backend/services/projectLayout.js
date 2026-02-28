import fs from 'fs/promises';
import path from 'path';

const fileExists = async (targetPath) => {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const readScripts = async (packageJsonPath) => {
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

const resolveRootFrontendScriptExists = (scripts = {}) => {
  const devScript = typeof scripts.dev === 'string' ? scripts.dev.trim() : '';
  return Boolean(devScript);
};

export const resolveProjectLayout = async (projectPath) => {
  const frontendPath = path.join(projectPath, 'frontend');
  const backendPath = path.join(projectPath, 'backend');
  const rootPackageJsonPath = path.join(projectPath, 'package.json');
  const frontendPackageJsonPath = path.join(frontendPath, 'package.json');
  const backendPackageJsonPath = path.join(backendPath, 'package.json');

  const rootPackageJsonExists = await fileExists(rootPackageJsonPath);
  const frontendPackageJsonExists = await fileExists(frontendPackageJsonPath);
  const backendPackageJsonExists = await fileExists(backendPackageJsonPath);

  const backendRequirementsPath = path.join(backendPath, 'requirements.txt');
  const rootRequirementsPath = path.join(projectPath, 'requirements.txt');
  const backendRequirementsExists = await fileExists(backendRequirementsPath);
  const rootRequirementsExists = await fileExists(rootRequirementsPath);

  const rootScripts = rootPackageJsonExists ? await readScripts(rootPackageJsonPath) : {};
  const rootBackendScriptName = resolveBackendScriptName(rootScripts);
  const hasRootBackendScript = Boolean(rootBackendScriptName);
  const hasRootFrontendScript = resolveRootFrontendScriptExists(rootScripts);

  const frontendWorkspacePath = frontendPackageJsonExists
    ? frontendPath
    : (rootPackageJsonExists && hasRootFrontendScript ? projectPath : null);
  const frontendWorkspaceManifestPath = frontendPackageJsonExists
    ? frontendPackageJsonPath
    : (frontendWorkspacePath ? rootPackageJsonPath : null);

  const backendWorkspacePath = (backendPackageJsonExists || backendRequirementsExists)
    ? backendPath
    : (hasRootBackendScript ? projectPath : null);
  const backendWorkspaceManifestPath = backendPackageJsonExists
    ? backendPackageJsonPath
    : (backendWorkspacePath && rootPackageJsonExists ? rootPackageJsonPath : null);
  const hasBackendRequirements = backendRequirementsExists
    || (backendWorkspacePath === projectPath && rootRequirementsExists);

  return {
    projectPath,
    frontendPath,
    backendPath,
    rootPackageJsonPath,
    frontendPackageJsonPath,
    backendPackageJsonPath,
    rootScripts,
    rootBackendScriptName,
    hasRootBackendScript,
    hasRootFrontendScript,
    frontendWorkspacePath,
    frontendWorkspaceManifestPath,
    backendWorkspacePath,
    backendWorkspaceManifestPath,
    hasBackendRequirements
  };
};
