import React from 'react';
import { stripAnsi } from '../../utils/ansi';

export const TEST_JOB_TYPES = [
  {
    type: 'frontend:test',
    label: 'Frontend Tests',
    description: 'Run Vitest + RTL suites to validate UI flows.'
  },
  {
    type: 'backend:test',
    label: 'Backend Tests',
    description: 'Execute API and service tests to keep the server healthy.'
  }
];

export const DEFAULT_TEST_FIX_ATTEMPTS = 3;
let autofixMaxAttemptsOverride = null;

export const getAutofixMaxAttempts = () => (
  Number.isFinite(autofixMaxAttemptsOverride)
    ? autofixMaxAttemptsOverride
    : DEFAULT_TEST_FIX_ATTEMPTS
);

export const setAutofixMaxAttemptsOverride = (override) => {
  autofixMaxAttemptsOverride = Number.isFinite(override) ? override : null;
};

export const resetAutofixMaxAttemptsOverride = () => {
  autofixMaxAttemptsOverride = null;
};

export const isAutofixHalted = () => {
  /* c8 ignore next 3 */
  if (typeof window === 'undefined') {
    return false;
  }
  return window.__lucidcoderAutofixHalted === true;
};

export const statusLabel = (status) => {
  if (!status) {
    return 'Idle';
  }
  return {
    queued: 'Queued',
    starting: 'Starting',
    pending: 'Pending',
    running: 'Running',
    succeeded: 'Passed',
    failed: 'Failed',
    cancelled: 'Cancelled'
  }[status] || status;
};

export const isJobActive = (job) => job && (job.status === 'queued' || job.status === 'starting' || job.status === 'pending' || job.status === 'running');
export const isJobFinal = (job) => job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled');
export const isCoverageGateFailed = (job) => {
  const coverage = job?.summary?.coverage;
  if (!coverage) {
    return false;
  }
  if (coverage.passed === false) {
    return true;
  }
  if (coverage.changedFiles?.passed === false) {
    return true;
  }
  const totals = coverage.totals;
  if (totals && typeof totals === 'object') {
    const fields = ['lines', 'statements', 'functions', 'branches'];
    const belowThreshold = fields.some((field) => {
      const value = Number(totals[field]);
      return Number.isFinite(value) && value < 100;
    });
    if (belowThreshold) {
      return true;
    }
  }
  return false;
};

const TEST_FIX_PARENT_PROMPT = 'Fix failing tests';
const MAX_AUTOFIX_LOG_LINES = 200;
const MAX_AUTOFIX_LOG_CHARS = 20000;
const MAX_FAILURE_REPORT_LINES = 80;
const MAX_FAILURE_REPORT_CHARS = 4000;
const FAILURE_LINE_REGEX = /(\bFAIL\b|AssertionError|TypeError|ReferenceError|SyntaxError|Error:|Expected|Received|toThrow|Unhandled|RangeError|Cannot read|is not a function)/i;
const FAIL_LINE_REGEX = /^FAIL\s+/i;

const collectRecentLogLines = (job) => {
  const logs = Array.isArray(job?.logs) ? job.logs : [];
  if (logs.length === 0) {
    return { lines: [], truncated: false };
  }

  const recent = logs.slice(-MAX_AUTOFIX_LOG_LINES);
  const lines = [];
  let truncated = logs.length > recent.length;
  let remainingChars = MAX_AUTOFIX_LOG_CHARS;

  for (const entry of recent) {
    const timestamp = typeof entry?.timestamp === 'string' && entry.timestamp.trim() ? `[${entry.timestamp.trim()}] ` : '';
    const message = stripAnsi(entry?.message || '').trimEnd();
    const combined = `${timestamp}${message}`.trimEnd();
    if (!combined) {
      continue;
    }

    const cost = combined.length + 1;
    if (cost > remainingChars) {
      truncated = true;
      break;
    }

    lines.push(combined);
    remainingChars -= cost;
    if (remainingChars <= 0) {
      truncated = true;
      break;
    }
  }

  if (truncated && lines[lines.length - 1] !== '/* ...logs truncated... */') {
    lines.push('/* ...logs truncated... */');
  }

  return { lines, truncated };
};

const extractFailureReport = (job) => {
  const logs = Array.isArray(job?.logs) ? job.logs : [];
  if (logs.length === 0) {
    return '';
  }

  const lines = [];
  let remainingChars = MAX_FAILURE_REPORT_CHARS;

  const pushLine = (value) => {
    if (!value || remainingChars <= 0) {
      return;
    }
    const cost = value.length + 1;
    if (cost > remainingChars) {
      return;
    }
    lines.push(value);
    remainingChars -= cost;
  };

  for (const entry of logs.slice(-MAX_AUTOFIX_LOG_LINES)) {
    const message = stripAnsi(entry?.message || '').trimEnd();
    if (!message) {
      continue;
    }
    const split = message.split(/\r?\n/);
    for (let i = 0; i < split.length; i += 1) {
      const line = split[i].trimEnd();
      if (!line) {
        continue;
      }
      const matches = FAILURE_LINE_REGEX.test(line);
      if (matches) {
        pushLine(line);
        for (let j = 1; j <= 3 && i + j < split.length; j += 1) {
          pushLine(split[i + j].trimEnd());
        }
      }
      if (lines.length >= MAX_FAILURE_REPORT_LINES || remainingChars <= 0) {
        break;
      }
    }
    if (lines.length >= MAX_FAILURE_REPORT_LINES || remainingChars <= 0) {
      break;
    }
  }

  if (lines.length === 0) {
    const fallback = logs.slice(-6)
      .map((entry) => stripAnsi(entry?.message || '').trimEnd())
      .filter(Boolean);
    fallback.forEach((line) => pushLine(line));
  }

  if (lines.length === 0) {
    return '';
  }

  return lines.slice(0, MAX_FAILURE_REPORT_LINES).join('\n');
};

export const extractFailureReportForTestId = (job, testId) => {
  if (!testId) {
    return '';
  }

  const logs = Array.isArray(job?.logs) ? job.logs : [];
  if (logs.length === 0) {
    return '';
  }

  const lines = [];
  let remainingChars = MAX_FAILURE_REPORT_CHARS;
  let collecting = false;

  const pushLine = (value) => {
    if (!value || remainingChars <= 0) {
      return;
    }
    const cost = value.length + 1;
    if (cost > remainingChars) {
      return;
    }
    lines.push(value);
    remainingChars -= cost;
  };

  for (const entry of logs.slice(-MAX_AUTOFIX_LOG_LINES)) {
    const message = stripAnsi(entry?.message || '').trimEnd();
    if (!message) {
      continue;
    }

    const split = message.split(/\r?\n/);
    for (const rawLine of split) {
      const line = rawLine.trimEnd();
      if (!line) {
        continue;
      }

      const isFailLine = FAIL_LINE_REGEX.test(line);
      if (isFailLine && !line.includes(testId) && collecting) {
        collecting = false;
      }

      if (line.includes(testId) && (isFailLine || FAILURE_LINE_REGEX.test(line))) {
        collecting = true;
        pushLine(line);
        continue;
      }

      if (collecting) {
        if (/^⎯|^=+/.test(line)) {
          collecting = false;
          continue;
        }
        pushLine(line);
      }

      if (lines.length >= MAX_FAILURE_REPORT_LINES || remainingChars <= 0) {
        break;
      }
    }

    if (lines.length >= MAX_FAILURE_REPORT_LINES || remainingChars <= 0) {
      break;
    }
  }

  return lines.join('\n');
};

const isCoverageOnlyFailure = (job, failureReport, failingIds) => {
  if (Array.isArray(failingIds) && failingIds.length > 0) {
    return false;
  }

  const report = failureReport ? String(failureReport) : '';
  const hasFailureMarker = /(\bFAIL\b|AssertionError|TypeError|ReferenceError|SyntaxError|Error:)/i.test(report);
  if (hasFailureMarker) {
    return false;
  }

  const hasTestFailureSummary = /(Test Suites:|Tests:)\s*.*\bfailed\b/i.test(report);
  if (hasTestFailureSummary) {
    return false;
  }

  if (isCoverageGateFailed(job)) {
    return true;
  }

  return /(Coverage gate failed|Uncovered Line #s|\bcoverage\b)/i.test(report);
};

export const buildFailingTestsPrompt = ({ label, failureReport, failingIds }) => {
  const labelText = typeof label === 'string' && label.trim() ? label.trim() : 'test suite';
  const ids = Array.isArray(failingIds) ? failingIds.filter(Boolean) : [];
  const header = `Fix failing tests in ${labelText}.`;
  if (ids.length === 0 && !failureReport) {
    return header;
  }

  const lines = [header];
  if (ids.length > 0) {
    lines.push('', `Failing tests: ${ids.join(', ')}`);
  }
  if (failureReport) {
    lines.push('', 'Failure output:', String(failureReport));
  }
  return lines.join('\n');
};

export const buildCoverageMetadata = ({ label = null, kind = null, uncoveredEntry = null } = {}) => ({
  acceptanceCriteria: ['Coverage gate passes for this suite'],
  suppressClarifyingQuestions: true,
  ...(label || kind ? { coverageTarget: { label: label || null, kind: kind || null } } : {}),
  ...(uncoveredEntry ? { uncoveredLines: [uncoveredEntry] } : {})
});

export const normalizeTruncatedCoverageFile = (file, entryKind) => {
  if (!file || !file.includes('...')) {
    return file;
  }
  if (file.endsWith('ght.config.js') && entryKind === 'frontend') {
    return 'vite.config.js';
  }
  return file;
};

export const formatCoveragePath = (entry, entryKind) => {
  const file = normalizeTruncatedCoverageFile(
    typeof entry?.file === 'string' ? entry.file.trim() : '',
    entryKind
  );
  const workspace = typeof entry?.workspace === 'string' ? entry.workspace.trim() : '';
  if (!workspace) {
    return file;
  }
  if (!file) {
    return workspace;
  }
  if (file.startsWith(`${workspace}/`)) {
    return file;
  }
  return `${workspace}/${file}`;
};

export const formatUncoveredLineSummary = (uncoveredLines) => {
  if (!Array.isArray(uncoveredLines) || uncoveredLines.length === 0) {
    return '';
  }

  const segments = [];
  for (const entry of uncoveredLines) {
    if (segments.length >= 3) {
      break;
    }
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const workspace = typeof entry.workspace === 'string' ? entry.workspace.trim() : '';
    const file = typeof entry.file === 'string' ? entry.file.trim() : '';
    const normalizedFile = [workspace, file].filter(Boolean).join('/');
    if (!normalizedFile) {
      continue;
    }
    const lines = Array.isArray(entry.lines)
      ? entry.lines.map((value) => Number(value)).filter(Number.isFinite)
      : [];
    if (lines.length > 0) {
      const preview = lines.slice(0, 8).join(', ');
      const suffix = lines.length > 8 ? ', …' : '';
      segments.push(`${normalizedFile} (${preview}${suffix})`);
    } else {
      segments.push(normalizedFile);
    }
  }

  return segments.join('; ');
};

export const parseCoverageLineRanges = (value) => {
  if (!value || typeof value !== 'string') {
    return [];
  }

  const ranges = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  const lines = [];
  for (const range of ranges) {
    const match = range.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      continue;
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }
    const min = Math.min(start, end);
    const max = Math.max(start, end);
    for (let line = min; line <= max; line += 1) {
      lines.push(line);
      if (lines.length >= 50) {
        return lines;
      }
    }
  }

  return lines;
};

const CONFIG_COVERAGE_EXCLUDE_REGEX = /(?:^|\/)(?:vite|vitest|jest)\.config\.(?:(?:c|m)?js|(?:c|m)?ts)$/i;

export const shouldExcludeCoverageFile = (value) => {
  if (!value) {
    return false;
  }
  return CONFIG_COVERAGE_EXCLUDE_REGEX.test(String(value));
};

export const extractUncoveredEntriesFromCoverageLogs = (job, kind) => {
  const logs = Array.isArray(job?.logs) ? job.logs : [];
  if (logs.length === 0) {
    return [];
  }

  const entries = [];
  const lines = logs
    .map((entry) => stripAnsi(entry?.message || '').trimEnd())
    .filter(Boolean);

  let inTable = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    if (/Uncovered Line #s/i.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) {
      continue;
    }
    if (/^-{3,}/.test(line)) {
      continue;
    }
    if (!line.includes('|')) {
      inTable = false;
      continue;
    }

    const parts = line.split('|').map((part) => part.trim());
    if (parts.length < 6) {
      continue;
    }

    const file = parts[0];
    if (shouldExcludeCoverageFile(file)) {
      continue;
    }
    const uncovered = parts[parts.length - 1];
    const uncoveredLines = parseCoverageLineRanges(uncovered);
    if (!file || uncoveredLines.length === 0) {
      continue;
    }

    const hasPath = file.includes('/') || file.includes('\\');
    const normalizedFile = hasPath
      ? file.replace(/\\/g, '/')
      : kind === 'frontend'
        ? `src/${file}`
        : file;

    entries.push({
      workspace: kind === 'backend' ? 'backend' : 'frontend',
      file: normalizedFile,
      lines: uncoveredLines
    });
  }

  return entries;
};


export const buildJobFailureContext = ({ label, job, kind }) => {
  if (!job) {
    return null;
  }

  const logBundle = collectRecentLogLines(job);
  const failureReport = extractFailureReport(job);
  const args = Array.isArray(job?.args) ? job.args.filter((value) => typeof value === 'string' && value.trim().length > 0) : null;
  const errorText = typeof job?.error === 'string' && job.error.trim().length > 0
    ? job.error.trim()
    : typeof job?.summary?.error === 'string'
      ? job.summary.error.trim()
      : null;

  const testFailures = extractFailingTestIdsFromJob(job);

  return {
    label,
    kind,
    type: typeof job?.type === 'string' ? job.type : null,
    jobId: job?.id || null,
    status: typeof job?.status === 'string' ? job.status : null,
    createdAt: job?.createdAt || null,
    startedAt: job?.startedAt || null,
    completedAt: job?.completedAt || null,
    duration: formatDurationSeconds(job),
    command: typeof job?.command === 'string' ? job.command : null,
    args,
    cwd: typeof job?.cwd === 'string' ? job.cwd : null,
    error: errorText,
    summary: job?.summary || null,
    coverage: job?.summary?.coverage || null,
    uncoveredLines: job?.summary?.coverage?.uncoveredLines || null,
    testFailures,
    failureReport: failureReport || null,
    recentLogs: logBundle.lines,
    logsTruncated: logBundle.truncated,
    totalLogEntries: Array.isArray(job?.logs) ? job.logs.length : 0
  };
};

export const buildTestFailureContext = (entries) => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  const jobs = entries
    .map((entry) => buildJobFailureContext(entry))
    .filter(Boolean);

  if (jobs.length === 0) {
    return null;
  }

  return {
    generatedAt: new Date().toISOString(),
    jobs
  };
};

export const extractFailingTestIdsFromJob = (job) => {
  const logs = Array.isArray(job?.logs) ? job.logs : [];
  const ids = new Set();
  const slice = logs.slice(-200);

  for (const entry of slice) {
    const message = stripAnsi(entry?.message || '');
    if (!message) {
      continue;
    }

    const lines = String(message).split(/\r?\n/);
    for (const line of lines) {
      const trimmed = String(line || '').trim();
      if (!trimmed) {
        continue;
      }

      const failMatch = trimmed.match(/^FAIL\s+(.+)$/i);
      if (failMatch?.[1]) {
        const id = failMatch[1].trim();
        if (id) {
          ids.add(id);
        }
      }
    }
  }

  return Array.from(ids);
};

export const collectChildPrompt = (rawChildPrompts, childPromptMetadata, text, metadata = null) => {
  const prompt = String(text).trim();
  if (!prompt) {
    return false;
  }
  rawChildPrompts.push(prompt);
  if (metadata && typeof metadata === 'object') {
    childPromptMetadata[prompt] = metadata;
  }
  return true;
};

let formatUncoveredLineSummaryOverride = null;

export const setFormatUncoveredLineSummaryOverride = (override) => {
  formatUncoveredLineSummaryOverride = typeof override === 'function' ? override : null;
};

export const resetFormatUncoveredLineSummaryOverride = () => {
  formatUncoveredLineSummaryOverride = null;
};

const getUncoveredLineSummary = (entries) => {
  if (typeof formatUncoveredLineSummaryOverride === 'function') {
    const overrideResult = formatUncoveredLineSummaryOverride(entries);
    if (overrideResult !== undefined) {
      return overrideResult;
    }
  }
  return formatUncoveredLineSummary(entries);
};

export const buildTestFixPlan = ({ jobs, previousCoverageTargets = null }) => {
  const rawChildPrompts = [];
  const childPromptMetadata = {};
  const addChild = (text, metadata = null) => {
    collectChildPrompt(rawChildPrompts, childPromptMetadata, text, metadata);
  };

  // Track which file:line pairs were already attempted to avoid duplicate
  // coverage goals across autofix rounds.
  const prevTargets = previousCoverageTargets instanceof Set ? previousCoverageTargets : new Set();
  const newCoverageTargets = new Set();

  const buildTestFixMetadata = ({ testId = null, label = null, kind = null, failureReport = null } = {}) => {
    const acceptanceCriteria = [];
    if (testId) {
      acceptanceCriteria.push(`Failing test passes: ${testId}`);
    } else if (label) {
      acceptanceCriteria.push(`${label} pass without failures`);
    }

    return {
      ...(acceptanceCriteria.length > 0 ? { acceptanceCriteria } : {}),
      suppressClarifyingQuestions: true,
      testFailure: {
        id: testId,
        label: label || null,
        kind: kind || null
      },
      ...(failureReport ? { failureReport } : {})
    };
  };

  const failingJobs = jobs
    .map(({ label, job, kind }) => ({ label, job, kind }))
    .filter(({ job }) => job?.status === 'failed' || isCoverageGateFailed(job));

  for (const { label, job, kind } of failingJobs) {
    const coverageFailed = isCoverageGateFailed(job);
    const ids = extractFailingTestIdsFromJob(job);
    const failureReport = ids.length > 0
      ? extractFailureReportForTestId(job, ids[0]) || extractFailureReport(job)
      : extractFailureReport(job);
    const hasFailingTests = ids.length > 0 || (job?.status === 'failed' && !coverageFailed);
    const coverageOnly = isCoverageOnlyFailure(job, failureReport, ids);

    if (hasFailingTests && !coverageOnly) {
      const prompt = buildFailingTestsPrompt({ label, failureReport, failingIds: ids });
      addChild(prompt, buildTestFixMetadata({ testId: ids[0] || null, label, kind, failureReport: failureReport || null }));
    }

    if (coverageFailed && !hasFailingTests) {
      const labelText = typeof label === 'string' && label.trim() ? label.trim() : 'test suite';
      const coverageMessage = buildCoverageGateMessage(job?.summary);
      let uncoveredEntries = Array.isArray(job?.summary?.coverage?.uncoveredLines)
        ? job.summary.coverage.uncoveredLines.filter(Boolean)
        : [];
      const hasTruncatedPaths = uncoveredEntries.some((entry) => typeof entry?.file === 'string' && entry.file.includes('...'));
      if (uncoveredEntries.length === 0 || hasTruncatedPaths) {
        const logEntries = extractUncoveredEntriesFromCoverageLogs(job, kind);
        if (logEntries.length > 0) {
          uncoveredEntries = logEntries;
        }
      }

      const normalizedEntries = uncoveredEntries
        .map((entry) => {
          const workspaceName = typeof entry?.workspace === 'string' ? entry.workspace.trim() : '';
          const normalizedFile = normalizeTruncatedCoverageFile(
            typeof entry?.file === 'string' ? entry.file.trim() : '',
            kind
          );
          const filePath = formatCoveragePath({ ...entry, file: normalizedFile }, kind);
          return {
            entry,
            workspaceName,
            normalizedFile,
            filePath,
            lines: Array.isArray(entry?.lines)
              ? entry.lines.map((value) => Number(value)).filter(Number.isFinite)
              : []
          };
        })
        .filter((entry) => entry.filePath && !shouldExcludeCoverageFile(entry.filePath));

      const groupedEntries = new Map();
      for (const entry of normalizedEntries) {
        const key = entry.filePath;
        const existing = groupedEntries.get(key);
        if (!existing) {
          groupedEntries.set(key, { ...entry });
          continue;
        }
        const merged = new Set([...(existing.lines), ...(entry.lines)]);
        existing.lines = Array.from(merged).sort((a, b) => a - b);
      }

      for (const entry of groupedEntries.values()) {
        const lines = entry.lines;
        if (lines.length === 0) {
          const summary = getUncoveredLineSummary([entry.entry]);
          if (!summary) {
            continue;
          }
          const coveragePrompt = `Add tests to cover uncovered lines in ${summary}. ${coverageMessage} Update existing test files for this area and avoid adding duplicate coverage-only tests.`;
          addChild(coveragePrompt, buildCoverageMetadata({ label: labelText, kind, uncoveredEntry: entry.entry }));
          continue;
        }

        // Filter out lines that were already targeted in a previous autofix round.
        const freshLines = prevTargets.size > 0
          ? lines.filter((line) => !prevTargets.has(`${entry.filePath}:${line}`))
          : lines;

        if (freshLines.length === 0) {
          continue;
        }

        // Record new targets for the caller to track.
        for (const line of freshLines) {
          newCoverageTargets.add(`${entry.filePath}:${line}`);
        }

        // Batch all uncovered lines for the same file into a single goal
        // instead of creating one goal per line.
        const MAX_LINES_PER_COVERAGE_GOAL = 20;
        const fileForMetadata = entry.workspaceName && entry.normalizedFile.startsWith(`${entry.workspaceName}/`)
          ? entry.normalizedFile.slice(entry.workspaceName.length + 1)
          : entry.normalizedFile;

        for (let chunkStart = 0; chunkStart < freshLines.length; chunkStart += MAX_LINES_PER_COVERAGE_GOAL) {
          const chunk = freshLines.slice(chunkStart, chunkStart + MAX_LINES_PER_COVERAGE_GOAL);
          const lineList = chunk.join(', ');
          const coveragePrompt = chunk.length === 1
            ? `Add tests to cover uncovered line ${chunk[0]} in ${entry.filePath}. ${coverageMessage} Update existing test files for this area and avoid adding duplicate coverage-only tests.`
            : `Add tests to cover uncovered lines ${lineList} in ${entry.filePath}. ${coverageMessage} Update existing test files for this area and avoid adding duplicate coverage-only tests.`;
          const batchEntry = {
            ...entry.entry,
            file: fileForMetadata,
            lines: chunk
          };
          addChild(coveragePrompt, buildCoverageMetadata({ label: labelText, kind, uncoveredEntry: batchEntry }));
        }
      }
    }
  }

  const childPrompts = Array.from(new Set(rawChildPrompts)).filter(Boolean);
  const trimmedMetadata = childPrompts.reduce((acc, prompt) => {
    if (childPromptMetadata[prompt]) {
      acc[prompt] = childPromptMetadata[prompt];
    }
    return acc;
  }, {});

  return {
    prompt: TEST_FIX_PARENT_PROMPT,
    childPrompts,
    childPromptMetadata: trimmedMetadata,
    failureContext: null,
    coverageTargets: newCoverageTargets
  };
};

export const formatDurationSeconds = (job) => {
  if (!job?.startedAt) {
    return null;
  }
  const end = job.completedAt || new Date().toISOString();
  const seconds = (new Date(end) - new Date(job.startedAt)) / 1000;
  if (Number.isNaN(seconds)) {
    return null;
  }
  return `${seconds.toFixed(1)}s`;
};

const LOG_HIGHLIGHT_REGEX = /\b\d+(?:\.\d+)?s\b|[✓✔]|[✗✘✖]|\bpass(?:ed)?\b|\bfail(?:ed|ure)?\b|\d+\s+(?:tests?\s+)?passed|\d+\s+(?:tests?\s+)?failed/gi;
let classifyLogTokenOverride = null;

export const classifyLogToken = (token = '') => {
  if (typeof classifyLogTokenOverride === 'function') {
    const overrideResult = classifyLogTokenOverride(token);
    if (overrideResult !== undefined) {
      return overrideResult;
    }
  }

  const normalized = token.toLowerCase();
  if (/^([✓✔])$/.test(token) || /\bpass(?:ed)?\b/.test(normalized) || /\d+\s+(?:tests?\s+)?passed/.test(normalized)) {
    return 'pass';
  }
  if (/^([✗✘✖])$/.test(token) || /\bfail(?:ed|ure)?\b/.test(normalized) || /\d+\s+(?:tests?\s+)?failed/.test(normalized)) {
    return 'fail';
  }
  if (/\b\d+(?:\.\d+)?s\b/i.test(token)) {
    return 'duration';
  }
  return null;
};

export const setClassifyLogTokenOverride = (override) => {
  classifyLogTokenOverride = typeof override === 'function' ? override : null;
};

export const resetClassifyLogTokenOverride = () => {
  classifyLogTokenOverride = null;
};

export const formatLogMessage = (message = '') => {
  const clean = stripAnsi(message);
  if (!clean) {
    return clean;
  }

  const segments = [];
  let lastIndex = 0;

  clean.replace(LOG_HIGHLIGHT_REGEX, (match, offset) => {
    if (offset > lastIndex) {
      segments.push(clean.slice(lastIndex, offset));
    }
    const type = classifyLogToken(match);
    if (type) {
      segments.push({ text: match, type });
    } else {
      segments.push(match);
    }
    lastIndex = offset + match.length;
    return match;
  });

  if (lastIndex < clean.length) {
    segments.push(clean.slice(lastIndex));
  }

  return segments.map((segment, index) => {
    if (typeof segment === 'string') {
      return <React.Fragment key={`segment-${index}`}>{segment}</React.Fragment>;
    }
    return (
      <span key={`segment-${index}`} className={`log-highlight ${segment.type}`}>
        {segment.text}
      </span>
    );
  });
};

const SUMMARY_START_REGEX = /^\s*(Test Suites:|Test Files\s+)/i;
const SUMMARY_LINE_REGEX = /^\s*(Test Suites:|Tests:|Tests\s+|Snapshots:|Time:|Ran all test suites\.|Test Files\s+|Start at\s+|Duration\s+)/i;

const normalizeSummaryLine = (line) => stripAnsi(String(line || '')).replace(/\s+/g, ' ').trim();

export const extractTestSummaryLines = (logs) => {
  if (!Array.isArray(logs) || logs.length === 0) {
    return [];
  }

  const allLines = [];
  for (const entry of logs) {
    const message = stripAnsi(entry?.message || '').trimEnd();
    if (!message) {
      continue;
    }
    message.split(/\r?\n/).forEach((line) => {
      const trimmed = String(line || '').trimEnd();
      if (trimmed) {
        allLines.push(trimmed);
      }
    });
  }

  const startIndex = [...allLines].reverse().findIndex((line) => SUMMARY_START_REGEX.test(line));
  if (startIndex < 0) {
    return [];
  }

  const start = allLines.length - 1 - startIndex;
  const summaryLines = [];

  for (let i = start; i < allLines.length; i += 1) {
    const line = allLines[i];
    if (SUMMARY_LINE_REGEX.test(line)) {
      summaryLines.push(line);
    } else if (summaryLines.length > 0) {
      break;
    }
  }

  const deduped = Array.from(new Set(summaryLines));
  return deduped.slice(0, 6);
};

const renderLogLine = (line, key) => (
  <div className="log-line" key={key}>
    <pre className="log-message">{formatLogMessage(line)}</pre>
  </div>
);

const isSummaryLine = (line) => SUMMARY_LINE_REGEX.test(normalizeSummaryLine(line));

export const renderLogLines = (job) => {
  if (!job?.logs || job.logs.length === 0) {
    return (
      <div className="log-line log-line-empty" data-testid="test-job-empty-logs">
        No output yet. Logs stream live as the job runs.
      </div>
    );
  }

  const recent = job.logs.slice(-6);
  const recentLines = recent
    .map((entry) => stripAnsi(entry?.message || '').trimEnd())
    .filter(Boolean);
  const normalizedRecent = recentLines.map(normalizeSummaryLine);
  const summaryFromLogs = extractTestSummaryLines(job.logs);
  const summaryFromJob = Array.isArray(job?.summary?.testSummaryLines)
    ? job.summary.testSummaryLines
    : [];
  const summarySource = summaryFromLogs.length ? summaryFromLogs : summaryFromJob;
  const summaryLines = Array.from(new Map(
    summarySource
      .map((line) => [normalizeSummaryLine(line), line])
      .filter(([normalized]) => normalized)
  ).values());

  const rendered = recent
    .filter((entry) => !isSummaryLine(entry?.message || ''))
    .map((entry, index) => (
    <div className="log-line" key={`${entry.timestamp}-${index}`}>
      <pre className="log-message">{formatLogMessage(entry.message)}</pre>
    </div>
  ));

  if (summaryLines.length > 0) {
    rendered.push(renderLogLine('Summary:', 'summary-label'));
    summaryLines.forEach((line, idx) => {
      rendered.push(renderLogLine(line, `summary-${idx}`));
    });
  }

  if (isCoverageGateFailed(job)) {
    const rawMessage = typeof job?.summary?.coverage?.message === 'string'
      ? job.summary.coverage.message.trim()
      : '';
    const coverageMessage = rawMessage || 'Coverage gate failed: coverage below 100%.';
    rendered.push(
      <div className="log-line" key="coverage-gate-failed">
        <pre className="log-message">
          <span className="log-highlight fail">{coverageMessage}</span>
        </pre>
      </div>
    );
  }

  return rendered;
};

export const buildProofFailureMessage = (testRun) => {
  const errorText = typeof testRun?.error === 'string' ? testRun.error.trim() : '';
  if (errorText) {
    return errorText;
  }

  const coverageGatePassed = testRun?.summary?.coverage?.passed;
  const changedFilesGatePassed = testRun?.summary?.coverage?.changedFiles?.passed;
  if (coverageGatePassed === false || changedFilesGatePassed === false) {
    const uncovered = testRun?.summary?.coverage?.uncoveredLines;
    if (Array.isArray(uncovered) && uncovered.length) {
      const first = uncovered[0] || {};
      const workspace = typeof first.workspace === 'string' ? first.workspace.trim() : '';
      const file = typeof first.file === 'string' ? first.file.trim() : '';
      const normalizedFile = [workspace, file].filter(Boolean).join('/');
      const lines = Array.isArray(first.lines)
        ? first.lines.map((value) => Number(value)).filter(Number.isFinite)
        : [];

      if (normalizedFile && lines.length) {
        const preview = lines.slice(0, 6).join(', ');
        const suffix = lines.length > 6 ? ', …' : '';
        return `Coverage gate failed: uncovered lines in ${normalizedFile} (${preview}${suffix}).`;
      }

      if (normalizedFile) {
        return `Coverage gate failed: uncovered lines in ${normalizedFile}.`;
      }
    }

    return 'Branch workflow tests failed the coverage gate. Fix coverage and try again.';
  }

  const failingWorkspace = Array.isArray(testRun?.workspaceRuns)
    ? testRun.workspaceRuns.find((run) => run && run.status && run.status !== 'succeeded')
    : null;

  if (failingWorkspace?.workspace) {
    return `Branch workflow tests failed in ${failingWorkspace.workspace}.`;
  }

  return 'Branch workflow tests failed. Fix failing tests and try again.';
};

export const buildCoverageGateMessage = (summary) => {
  const baseMessage = typeof summary?.coverage?.message === 'string'
    ? summary.coverage.message
    : summary?.coverage
      ? buildProofFailureMessage({ summary })
      : 'Coverage gate failed.';
  const normalized = typeof baseMessage === 'string' && baseMessage.trim()
    ? baseMessage
    : 'Coverage gate failed.';
  return `${normalized} Add tests to reach 100% coverage.`;
};
