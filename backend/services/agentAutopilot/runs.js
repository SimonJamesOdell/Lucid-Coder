const asArray = (value) => (Array.isArray(value) ? value : []);

const coerceString = (value) => (typeof value === 'string' ? value : '');

const FAILURE_PATTERNS = [/\bfail(?:ed|ure)?\b/i, /\berror\b/i, /\bexception\b/i];
const VITEST_FAIL_REGEX = /^FAIL\s+(.+)$/i;
const PYTEST_FAIL_REGEX = /^FAILED\s+(.+?)\s+-\s+(.+)$/i;
const TEST_PATH_SEGMENT_REGEX = /\s+>\s+/;

const parseFailureFromLogLine = (workspace, text) => {
  const normalizedText = text.replace(/^\s*(?:stdout|stderr)\s*:\s*/i, '');

  const vitestMatch = normalizedText.match(VITEST_FAIL_REGEX);
  if (vitestMatch) {
    const raw = coerceString(vitestMatch[1]).trim();
    if (!raw) {
      return null;
    }
    const segments = raw.split(TEST_PATH_SEGMENT_REGEX).map((segment) => segment.trim()).filter(Boolean);
    const name = segments.length ? segments[segments.length - 1] : raw;
    return {
      workspace,
      name,
      message: raw.length > 280 ? raw.slice(0, 280) : raw
    };
  }

  const pytestMatch = normalizedText.match(PYTEST_FAIL_REGEX);
  if (pytestMatch) {
    const name = coerceString(pytestMatch[1]).trim() || 'pytest failure';
    const message = coerceString(pytestMatch[2]).trim();
    return {
      workspace,
      name,
      message: message.length > 280 ? message.slice(0, 280) : message
    };
  }

  if (/^\s*AssertionError\b/i.test(normalizedText) || /^\s*TypeError\b/i.test(normalizedText) || /^\s*Error:\s+/i.test(normalizedText)) {
    return {
      workspace,
      name: 'error',
      message: normalizedText.slice(0, 280)
    };
  }

  return null;
};

const formatCoverageLineRefs = (coverage) => {
  if (!coverage || typeof coverage !== 'object') {
    return '';
  }

  const uncovered = Array.isArray(coverage.uncoveredLines) ? coverage.uncoveredLines : [];
  if (!uncovered.length) {
    return '';
  }

  const lines = ['Coverage gaps (line references):'];
  for (const entry of uncovered) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const workspace = coerceString(entry.workspace);
    const file = coerceString(entry.file);
    const rawLines = Array.isArray(entry.lines) ? entry.lines : [];
    const lineNums = rawLines.filter((line) => Number.isFinite(Number(line))).map((line) => Number(line));
    if (!file || lineNums.length === 0) {
      continue;
    }
    const limited = lineNums.slice(0, 12);
    const suffix = lineNums.length > limited.length ? ', ...' : '';
    const location = workspace ? `${workspace}/${file}` : file;
    lines.push(`- ${location}: ${limited.join(', ')}${suffix}`);
  }

  if (lines.length === 1) {
    return '';
  }

  lines.push('Instruction: add or adjust tests to execute the exact lines above so coverage reaches 100%.');
  return lines.join('\n');
};

export const splitLogsByStream = (workspaceRuns = []) => {
  return asArray(workspaceRuns).map((run) => {
    const stdout = [];
    const stderr = [];
    const other = [];

    const logs = asArray(run?.logs);
    for (const entry of logs) {
      if (entry && typeof entry === 'object') {
        const stream = (entry.stream || '').toLowerCase();
        const message = coerceString(entry.message);
        if (stream === 'stderr') {
          stderr.push(message);
        } else if (stream === 'stdout') {
          stdout.push(message);
        } else {
          other.push(message);
        }
        continue;
      }

      const line = coerceString(entry);
      if (!line) {
        continue;
      }
      if (line.toLowerCase().startsWith('stderr:')) {
        stderr.push(line.slice(7).trim());
      } else if (line.toLowerCase().startsWith('stdout:')) {
        stdout.push(line.slice(7).trim());
      } else {
        other.push(line);
      }
    }

    return {
      workspace: run?.workspace || null,
      stdout,
      stderr,
      other
    };
  });
};

export const summarizeWorkspaceRunsForPayload = (workspaceRuns = []) => {
  return asArray(workspaceRuns).map((run) => {
    const trimmedLogs = asArray(run?.logs).slice(-20);
    return {
      workspace: run?.workspace || null,
      kind: run?.kind || null,
      status: run?.status || null,
      exitCode: Number.isFinite(run?.exitCode) ? run.exitCode : null,
      durationMs: Number.isFinite(run?.durationMs) ? run.durationMs : null,
      coverage: run?.coverage || null,
      logs: trimmedLogs,
      streams: splitLogsByStream([run])[0]
    };
  });
};

export const extractFailingTestsFromWorkspaceRuns = (workspaceRuns = []) => {
  const failures = [];
  const dedupe = new Set();

  const pushFailure = (entry) => {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    const workspace = coerceString(entry.workspace) || 'workspace';
    const name = coerceString(entry.name) || 'unnamed test';
    const message = entry.message == null ? null : coerceString(entry.message);
    const key = `${workspace}::${name}::${message || ''}`;
    if (dedupe.has(key)) {
      return;
    }
    dedupe.add(key);
    failures.push({ workspace, name, message });
  };

  for (const run of asArray(workspaceRuns)) {
    const workspace = run?.workspace || 'workspace';
    const tests = asArray(run?.tests);
    for (const test of tests) {
      if (!test || typeof test !== 'object') {
        continue;
      }
      const status = (test.status || '').toLowerCase();
      if (status === 'failed' || status === 'fail') {
        pushFailure({
          workspace,
          name: test.name || test.title || 'unnamed test',
          message: test.error || test.message || null
        });
      }
    }

    if (failures.length >= 15) {
      break;
    }

    if (tests.length === 0) {
      const logs = asArray(run?.logs);
      for (const line of logs) {
        const text = coerceString(line);
        if (!text) {
          continue;
        }

        const parsedFailure = parseFailureFromLogLine(workspace, text);
        if (parsedFailure) {
          pushFailure(parsedFailure);
          if (failures.length >= 15) {
            break;
          }
          continue;
        }

        if (FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
          pushFailure({ workspace, name: 'log', message: text.slice(0, 280) });
          if (failures.length >= 15) {
            break;
          }
        }
      }
    }
  }

  return failures;
};

export const summarizeTestRunForPrompt = (run) => {
  if (!run || typeof run !== 'object') {
    return '';
  }

  const lines = [];
  const status = run.status || 'unknown';
  lines.push(`Status: ${status}`);

  const summary = run.summary && typeof run.summary === 'object' ? run.summary : null;
  if (summary) {
    const totals = [];
    if (Number.isFinite(summary.total)) {
      totals.push(`total=${summary.total}`);
    }
    if (Number.isFinite(summary.failed)) {
      totals.push(`failed=${summary.failed}`);
    }
    if (summary.coverage && typeof summary.coverage === 'object') {
      const coverage = summary.coverage;
      const coverageLines = [];
      if (coverage.totals) {
        const totalsObj = coverage.totals;
        coverageLines.push(`lines=${totalsObj.lines ?? 'n/a'}`);
        coverageLines.push(`statements=${totalsObj.statements ?? 'n/a'}`);
        coverageLines.push(`functions=${totalsObj.functions ?? 'n/a'}`);
        coverageLines.push(`branches=${totalsObj.branches ?? 'n/a'}`);
      }
      if (coverage.missing && coverage.missing.length) {
        coverageLines.push(`missing files: ${coverage.missing.join(', ')}`);
      }
      if (coverageLines.length) {
        totals.push(`coverage(${coverageLines.join(', ')})`);
      }
    }
    if (totals.length) {
      lines.push(`Summary: ${totals.join(' | ')}`);
    }

    const coverageRefs = formatCoverageLineRefs(summary.coverage);
    if (coverageRefs) {
      lines.push(coverageRefs);
    }
  }

  const failures = extractFailingTestsFromWorkspaceRuns(run.workspaceRuns || []);
  if (failures.length) {
    lines.push('Reported failures:');
    for (const failure of failures.slice(0, 5)) {
      const message = failure.message ? ` — ${failure.message}` : '';
      lines.push(`- [${failure.workspace}] ${failure.name}${message}`);
    }
  }

  return lines.join('\n');
};

export const buildFailureFingerprint = (run) => {
  if (!run || typeof run !== 'object') {
    return '';
  }

  const summary = run.summary && typeof run.summary === 'object' ? run.summary : {};
  const coverage = summary.coverage && typeof summary.coverage === 'object' ? summary.coverage : {};
  const totals = coverage.totals && typeof coverage.totals === 'object' ? coverage.totals : {};
  const failures = extractFailingTestsFromWorkspaceRuns(run.workspaceRuns || [])
    .slice(0, 8)
    .map((entry) => `${entry.workspace || 'workspace'}|${entry.name || 'test'}|${entry.message || ''}`);
  const workspaceStatuses = Array.isArray(run.workspaceRuns)
    ? run.workspaceRuns
        .map((workspaceRun) => {
          if (!workspaceRun || typeof workspaceRun !== 'object') {
            return null;
          }
          const workspace = workspaceRun.workspace || 'workspace';
          const status = workspaceRun.status || 'unknown';
          const exitCode = Number.isFinite(workspaceRun.exitCode) ? workspaceRun.exitCode : 'x';
          return `${workspace}:${status}:${exitCode}`;
        })
        .filter(Boolean)
    : [];
  const missingCoverage = Array.isArray(coverage.missing) ? coverage.missing.slice(0, 8) : [];
  const uncoveredLines = Array.isArray(coverage.uncoveredLines)
    ? coverage.uncoveredLines
        .slice(0, 8)
        .map((entry) => `${entry?.workspace || 'workspace'}/${entry?.file || ''}:${Array.isArray(entry?.lines) ? entry.lines.slice(0, 6).join(',') : ''}`)
    : [];

  return JSON.stringify({
    status: run.status || 'unknown',
    failed: Number.isFinite(summary.failed) ? summary.failed : null,
    totals: {
      lines: totals.lines ?? null,
      statements: totals.statements ?? null,
      functions: totals.functions ?? null,
      branches: totals.branches ?? null
    },
    failures,
    workspaceStatuses,
    missingCoverage,
    uncoveredLines
  });
};

export default {
  extractFailingTestsFromWorkspaceRuns,
  splitLogsByStream,
  summarizeTestRunForPrompt,
  summarizeWorkspaceRunsForPayload
};
