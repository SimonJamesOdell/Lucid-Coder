import { isRelevantSourceFile, normalizePathForCompare } from './workspacePathUtils.js';

export const getChangedSourceFilesForWorkspace = ({ changedPaths, workspaceName, nodeWorkspaceNames }) => {
  const normalizedWorkspacePrefix = `${normalizePathForCompare(workspaceName)}/`;
  const paths = Array.isArray(changedPaths) ? changedPaths : [];
  const workspaceNames = Array.isArray(nodeWorkspaceNames) ? nodeWorkspaceNames : [];

  return paths
    .map(normalizePathForCompare)
    .filter((value) => {
      if (workspaceNames.length <= 1) {
        return true;
      }
      return value.startsWith(normalizedWorkspacePrefix);
    })
    .map((value) => (value.startsWith(normalizedWorkspacePrefix) ? value.slice(normalizedWorkspacePrefix.length) : value))
    .filter(isRelevantSourceFile);
};
