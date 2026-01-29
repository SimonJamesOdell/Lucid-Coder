import { normalizePathForCompare } from './workspacePathUtils.js';
import { extractUncoveredLines } from './coverageUtils.js';
import { getChangedSourceFilesForWorkspace } from './changedFilesForWorkspace.js';

export const readNodeWorkspaceCoverage = async ({
  path,
  workspace,
  changedPaths,
  nodeWorkspaceNames,
  readJsonIfExists
}) => {
  const summaryPath = path.join(workspace.cwd, 'coverage', 'coverage-summary.json');
  const coverageSummaryJson = await readJsonIfExists(summaryPath);

  let coverageSummary = null;
  const totals = coverageSummaryJson?.total;
  if (totals) {
    coverageSummary = {
      lines: totals.lines?.pct,
      statements: totals.statements?.pct,
      functions: totals.functions?.pct,
      branches: totals.branches?.pct
    };
  }

  const uncoveredLines = [];

  const changedForWorkspace = getChangedSourceFilesForWorkspace({
    changedPaths,
    workspaceName: workspace.name,
    nodeWorkspaceNames
  });

  if (changedForWorkspace.length) {
    const finalPath = path.join(workspace.cwd, 'coverage', 'coverage-final.json');
    const finalCoverage = await readJsonIfExists(finalPath);
    if (finalCoverage && typeof finalCoverage === 'object') {
      const byFile = new Map();
      for (const key of Object.keys(finalCoverage)) {
        const normalized = normalizePathForCompare(key);
        const entry = finalCoverage[key];
        if (entry && typeof entry === 'object') {
          byFile.set(normalized, entry);
        }
      }

      const resolveCoverageEntry = (relativePath) => {
        const normalized = normalizePathForCompare(relativePath);
        if (byFile.has(normalized)) {
          return byFile.get(normalized);
        }
        for (const [key, entry] of byFile.entries()) {
          if (key.endsWith(`/${normalized}`)) {
            return entry;
          }
        }
        return null;
      };

      for (const relativePath of changedForWorkspace) {
        const entry = resolveCoverageEntry(relativePath);
        const lines = extractUncoveredLines(entry);
        if (lines.length) {
          uncoveredLines.push({ workspace: workspace.name, file: relativePath, lines });
        }
      }
    }
  }

  return { coverageSummaryJson, coverageSummary, uncoveredLines };
};
