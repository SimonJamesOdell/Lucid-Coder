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

export const DEFAULT_TEST_FIX_ATTEMPTS = Number.POSITIVE_INFINITY;
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

const TEST_FIX_PARENT_PROMPT = 'Fix failing tests';
const MAX_AUTOFIX_LOG_LINES = 200;
const MAX_AUTOFIX_LOG_CHARS = 20000;

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

export const buildJobFailureContext = ({ label, job, kind }) => {
  if (!job) {
    return null;
  }

  const logBundle = collectRecentLogLines(job);
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
    testFailures,
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

export const buildTestFixPlan = ({ jobs }) => {
  const rawChildPrompts = [];
  const addChild = (text) => {
    rawChildPrompts.push(String(text).trim());
  };

  const failingJobs = jobs
    .map(({ label, job, kind }) => ({ label, job, kind }))
    .filter(({ job }) => job?.status === 'failed');

  for (const { label, job, kind } of failingJobs) {
    const ids = extractFailingTestIdsFromJob(job);
    for (const id of ids) {
      addChild(`Fix failing test: ${id}`);
    }

    if (ids.length === 0) {
      if (kind === 'frontend') {
        addChild('Fix failing frontend tests');
      } else if (kind === 'backend') {
        addChild('Fix failing backend tests');
      } else {
        addChild(`Fix failing tests in ${label}`);
      }
    }
  }

  const childPrompts = Array.from(new Set(rawChildPrompts)).filter(Boolean);
  if (childPrompts.length === 0) {
    childPrompts.push('Investigate which tests are failing and fix them');
  }

  const failureContext = buildTestFailureContext(failingJobs);

  return {
    prompt: TEST_FIX_PARENT_PROMPT,
    childPrompts,
    failureContext
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

export const renderLogLines = (job) => {
  if (!job?.logs || job.logs.length === 0) {
    return (
      <div className="log-line log-line-empty" data-testid="test-job-empty-logs">
        No output yet. Logs stream live as the job runs.
      </div>
    );
  }

  const recent = job.logs.slice(-6);
  return recent.map((entry, index) => (
    <div className="log-line" key={`${entry.timestamp}-${index}`}>
      <pre className="log-message">{formatLogMessage(entry.message)}</pre>
    </div>
  ));
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
