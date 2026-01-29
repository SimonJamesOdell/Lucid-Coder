import { normalizePathForCompare } from './workspacePathUtils.js';
import { getChangedSourceFilesForWorkspace } from './changedFilesForWorkspace.js';

export const buildChangedFilesGateForWorkspace = ({
  workspaceName,
  workspaceCoverageSummary,
  changedPaths,
  changedFileThresholds,
  enforceChangedFileCoverage,
  nodeWorkspaceNames
}) => {
  const gate = {
    workspace: workspaceName,
    thresholds: changedFileThresholds,
    passed: true,
    missing: [],
    totals: null,
    skipped: false,
    reason: null
  };

  if (!enforceChangedFileCoverage) {
    gate.skipped = true;
    gate.reason = 'disabled';
    return gate;
  }

  const fileKeys = workspaceCoverageSummary && typeof workspaceCoverageSummary === 'object'
    ? Object.keys(workspaceCoverageSummary).filter((key) => key && key !== 'total')
    : [];

  if (fileKeys.length === 0) {
    gate.skipped = true;
    gate.reason = 'per_file_coverage_unavailable';
    return gate;
  }

  const changedForWorkspace = getChangedSourceFilesForWorkspace({
    changedPaths,
    workspaceName,
    nodeWorkspaceNames
  });

  if (changedForWorkspace.length === 0) {
    return gate;
  }

  const byFile = new Map();
  for (const key of fileKeys) {
    const normalized = normalizePathForCompare(key);
    const entry = workspaceCoverageSummary[key];
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
      if (key === normalized || key.endsWith(`/${normalized}`)) {
        return entry;
      }
    }
    return null;
  };

  let totals = {
    lines: 100,
    statements: 100,
    functions: 100,
    branches: 100
  };
  for (const relativePath of changedForWorkspace) {
    const entry = resolveCoverageEntry(relativePath);
    if (!entry) {
      gate.missing.push(`${workspaceName}/${relativePath}`);
      continue;
    }

    const linesPct = Number(entry?.lines?.pct);
    const statementsPct = Number(entry?.statements?.pct);
    const functionsPct = Number(entry?.functions?.pct);
    const branchesPct = Number(entry?.branches?.pct);

    if (
      !Number.isFinite(linesPct) ||
      !Number.isFinite(statementsPct) ||
      !Number.isFinite(functionsPct) ||
      !Number.isFinite(branchesPct)
    ) {
      gate.missing.push(`${workspaceName}/${relativePath}`);
      continue;
    }

    totals = {
      lines: Math.min(totals.lines, linesPct),
      statements: Math.min(totals.statements, statementsPct),
      functions: Math.min(totals.functions, functionsPct),
      branches: Math.min(totals.branches, branchesPct)
    };
  }

  gate.totals = totals;
  gate.passed =
    gate.missing.length === 0 &&
    totals.lines >= changedFileThresholds.lines &&
    totals.statements >= changedFileThresholds.statements &&
    totals.functions >= changedFileThresholds.functions &&
    totals.branches >= changedFileThresholds.branches;

  return gate;
};
