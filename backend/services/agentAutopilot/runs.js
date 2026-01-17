const asArray = (value) => (Array.isArray(value) ? value : []);

const coerceString = (value) => (typeof value === 'string' ? value : '');

const FAILURE_PATTERNS = [/\bfail(?:ed|ure)?\b/i, /\berror\b/i, /\bexception\b/i];

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

  for (const run of asArray(workspaceRuns)) {
    const workspace = run?.workspace || 'workspace';
    const tests = asArray(run?.tests);
    for (const test of tests) {
      if (!test || typeof test !== 'object') {
        continue;
      }
      const status = (test.status || '').toLowerCase();
      if (status === 'failed' || status === 'fail') {
        failures.push({
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
        if (FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
          failures.push({ workspace, name: 'log', message: text.slice(0, 280) });
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

export default {
  extractFailingTestsFromWorkspaceRuns,
  splitLogsByStream,
  summarizeTestRunForPrompt,
  summarizeWorkspaceRunsForPayload
};
