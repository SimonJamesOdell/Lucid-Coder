import { normalizePathForCompare } from './workspacePathUtils.js';
import { pathExists } from './fsUtils.js';

export const discoverWorkspaces = async ({ projectRoot, fs, path }) => {
  const frontendPath = path.join(projectRoot, 'frontend');
  const backendPath = path.join(projectRoot, 'backend');

  const hasFrontend = await pathExists(fs, path.join(frontendPath, 'package.json'));
  const hasBackendPackage = await pathExists(fs, path.join(backendPath, 'package.json'));
  const hasBackendPython = !hasBackendPackage && (await pathExists(fs, path.join(backendPath, 'requirements.txt')));

  const workspaces = [];
  if (hasFrontend) workspaces.push({ name: 'frontend', cwd: frontendPath, kind: 'node' });
  if (hasBackendPackage) workspaces.push({ name: 'backend', cwd: backendPath, kind: 'node' });
  if (hasBackendPython) workspaces.push({ name: 'backend', cwd: backendPath, kind: 'python' });

  if (!workspaces.length) {
    // Fallback: try running at project root if no conventional workspaces exist.
    const rootHasPackage = await pathExists(fs, path.join(projectRoot, 'package.json'));
    if (rootHasPackage) {
      workspaces.push({ name: 'root', cwd: projectRoot, kind: 'node' });
    }
  }

  return {
    workspaces,
    nodeWorkspaceNames: workspaces
      .filter((workspace) => workspace.kind === 'node')
      .map((workspace) => workspace.name)
  };
};

export const selectWorkspacesForScope = ({ workspaces, workspaceScope, changedPaths }) => {
  const scope = typeof workspaceScope === 'string' ? workspaceScope : 'all';
  const allWorkspaces = Array.isArray(workspaces) ? workspaces : [];
  const paths = Array.isArray(changedPaths) ? changedPaths : [];

  let selectedWorkspaces = allWorkspaces;
  if (scope === 'changed' && allWorkspaces.length > 1 && paths.length > 0) {
    const normalizedChanged = paths.map(normalizePathForCompare);
    const workspaceNames = allWorkspaces.map((workspace) => String(workspace.name));

    const isPrefixedByWorkspace = (value) => workspaceNames.some((name) => value.startsWith(`${name}/`));
    const hasUnscopedChanges = normalizedChanged.some((value) => !isPrefixedByWorkspace(value));

    if (!hasUnscopedChanges) {
      const relevantNames = new Set(
        normalizedChanged
          .map((value) => workspaceNames.find((name) => value.startsWith(`${name}/`)))
          .filter(Boolean)
      );

      selectedWorkspaces = allWorkspaces.filter((workspace) => relevantNames.has(String(workspace.name)));
    }
  }

  return selectedWorkspaces;
};
