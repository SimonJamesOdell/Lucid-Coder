import { normalizePathForCompare } from './workspacePathUtils.js';
import { extractUncoveredLines } from './coverageUtils.js';
import { getChangedSourceFilesForWorkspace } from './changedFilesForWorkspace.js';

const CONFIG_COVERAGE_EXCLUDE_REGEX = /(?:^|\/)(?:vite|vitest|jest)\.config\.(?:(?:c|m)?js|(?:c|m)?ts)$/i;

const shouldExcludeCoveragePath = (value) => {
  if (!value) {
    return false;
  }
  const normalized = normalizePathForCompare(value);
  return CONFIG_COVERAGE_EXCLUDE_REGEX.test(normalized);
};

export const readNodeWorkspaceCoverage = async ({
  path,
  workspace,
  changedPaths,
  nodeWorkspaceNames,
  readJsonIfExists,
  includeAllFiles = false,
  maxFiles = 20,
  maxLinesPerFile = 25
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

  const pushUncoveredLines = (filePath, lines) => {
    if (!filePath || !lines.length) {
      return;
    }
    uncoveredLines.push({
      workspace: workspace.name,
      file: filePath,
      lines: lines.slice(0, maxLinesPerFile)
    });
  };

  if (changedForWorkspace.length || includeAllFiles) {
    const finalPath = path.join(workspace.cwd, 'coverage', 'coverage-final.json');
    const finalCoverage = await readJsonIfExists(finalPath);
    if (finalCoverage && typeof finalCoverage === 'object') {
      const byFile = new Map();
      for (const key of Object.keys(finalCoverage)) {
        const normalized = normalizePathForCompare(key);
        const entry = finalCoverage[key];
        if (entry && typeof entry === 'object') {
          byFile.set(normalized, { entry, originalPath: key });
        }
      }

      const resolveCoverageEntry = (relativePath) => {
        const normalized = normalizePathForCompare(relativePath);
        if (byFile.has(normalized)) {
          return byFile.get(normalized).entry;
        }
        for (const [key, value] of byFile.entries()) {
          if (key.endsWith(`/${normalized}`)) {
            return value.entry;
          }
        }
        return null;
      };

      if (includeAllFiles) {
        for (const value of byFile.values()) {
          if (uncoveredLines.length >= maxFiles) {
            break;
          }
          const relativePath = normalizePathForCompare(path.relative(workspace.cwd, value.originalPath));
          if (!relativePath || relativePath.startsWith('..')) {
            continue;
          }
          if (shouldExcludeCoveragePath(relativePath)) {
            continue;
          }
          const lines = extractUncoveredLines(value.entry);
          pushUncoveredLines(relativePath, lines);
        }
      } else {
        for (const relativePath of changedForWorkspace) {
          if (shouldExcludeCoveragePath(relativePath)) {
            continue;
          }
          const entry = resolveCoverageEntry(relativePath);
          const lines = extractUncoveredLines(entry);
          pushUncoveredLines(relativePath, lines);
        }
      }
    }
  }

  return { coverageSummaryJson, coverageSummary, uncoveredLines };
};

export const __testExports__ = {
  shouldExcludeCoveragePath
};
