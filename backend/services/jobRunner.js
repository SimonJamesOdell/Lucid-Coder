import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import { appendRunEvent, createRun, updateRun } from './runStore.js';

const MAX_LOG_ENTRIES = 500;
const jobs = new Map();

const COVERAGE_THRESHOLDS = Object.freeze({
  lines: 100,
  statements: 100,
  functions: 100,
  branches: 100
});

const TEST_SUMMARY_START_REGEX = /^\s*(Test Suites:|Test Files\s+)/i;
const TEST_SUMMARY_LINE_REGEX = /^\s*(Test Suites:|Tests:|Tests\s+|Snapshots:|Time:|Ran all test suites\.|Test Files\s+|Start at\s+|Duration\s+)/i;
const MAX_TEST_SUMMARY_LINES = 6;
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const COVERAGE_ALL_FILES_REGEX = /^\s*All files\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|\s*([0-9.]+)\s*\|/i;

const isTestJobType = (type) => typeof type === 'string' && type.endsWith(':test');

const stripAnsi = (value) => String(value || '').replace(ANSI_REGEX, '');

const normalizeTestSummaryLine = (line) => stripAnsi(line).replace(/\s+/g, ' ').trim();

const appendTestSummaryLines = (job, message) => {
  if (!job || !isTestJobType(job.type) || !message) {
    return;
  }

  const lines = String(message).split(/\r?\n/);
  const matched = [];

  for (const line of lines) {
    const trimmed = stripAnsi(line).trimEnd();
    if (!trimmed) {
      continue;
    }
    if (TEST_SUMMARY_LINE_REGEX.test(trimmed)) {
      matched.push(trimmed);
    }
  }

  if (matched.length === 0) {
    return;
  }

  const existingSummary = job.summary && typeof job.summary === 'object' ? job.summary : {};
  const existingLines = Array.isArray(existingSummary.testSummaryLines)
    ? existingSummary.testSummaryLines
    : [];
  const normalizedExisting = new Set(existingLines.map(normalizeTestSummaryLine));

  const combined = [...existingLines];
  for (const line of matched) {
    const normalized = normalizeTestSummaryLine(line);
    if (!normalized || normalizedExisting.has(normalized)) {
      continue;
    }
    normalizedExisting.add(normalized);
    combined.push(line);
  }

  if (combined.length > MAX_TEST_SUMMARY_LINES) {
    combined.splice(MAX_TEST_SUMMARY_LINES);
  }

  job.summary = {
    ...existingSummary,
    testSummaryLines: combined
  };
};

const getCoverageSummaryPath = (cwd) => path.join(cwd, 'coverage', 'coverage-summary.json');

const readCoverageTotals = async (cwd) => {
  if (!cwd) {
    return null;
  }

  const summaryPath = getCoverageSummaryPath(cwd);
  const raw = await fs.readFile(summaryPath, 'utf8');
  const parsed = JSON.parse(raw);
  const total = parsed?.total && typeof parsed.total === 'object' ? parsed.total : null;
  if (!total) {
    return null;
  }

  const totals = {
    lines: Number(total?.lines?.pct),
    statements: Number(total?.statements?.pct),
    functions: Number(total?.functions?.pct),
    branches: Number(total?.branches?.pct)
  };

  const invalid = Object.values(totals).some((value) => !Number.isFinite(value));
  if (invalid) {
    return null;
  }

  return totals;
};

const parseCoverageTotalsFromLogs = (logs = []) => {
  if (!Array.isArray(logs) || logs.length === 0) {
    return null;
  }

  for (const entry of logs) {
    const message = stripAnsi(entry?.message || '');
    if (!message) {
      continue;
    }

    const lines = message.split(/\r?\n/);
    for (const line of lines) {
      const match = String(line || '').trimEnd().match(COVERAGE_ALL_FILES_REGEX);
      if (!match) {
        continue;
      }

      const totals = {
        statements: Number(match[1]),
        branches: Number(match[2]),
        functions: Number(match[3]),
        lines: Number(match[4])
      };

      const invalid = Object.values(totals).some((value) => !Number.isFinite(value));
      if (invalid) {
        continue;
      }

      return totals;
    }
  }

  return null;
};

const evaluateCoverageGate = async (job, { assumeSucceeded = false } = {}) => {
  if (!job || !isTestJobType(job.type)) {
    return;
  }
  if (!assumeSucceeded && job.status !== JOB_STATUS.SUCCEEDED) {
    return;
  }

  let totals = null;
  try {
    totals = await readCoverageTotals(job.cwd);
  } catch {
    totals = null;
  }

  if (!totals) {
    totals = parseCoverageTotalsFromLogs(job.logs);
  }

  if (!totals) {
    const message = 'Coverage gate failed: coverage summary not found.';
    const existingSummary = job.summary && typeof job.summary === 'object' ? job.summary : {};
    job.summary = {
      ...existingSummary,
      coverage: {
        passed: false,
        totals: null,
        thresholds: { ...COVERAGE_THRESHOLDS },
        message
      },
      error: message
    };
    job.status = JOB_STATUS.FAILED;
    return;
  }

  const passed =
    totals.lines >= COVERAGE_THRESHOLDS.lines &&
    totals.statements >= COVERAGE_THRESHOLDS.statements &&
    totals.functions >= COVERAGE_THRESHOLDS.functions &&
    totals.branches >= COVERAGE_THRESHOLDS.branches;

  const message = passed
    ? 'Coverage gate passed.'
    : 'Coverage gate failed: coverage below 100%.';

  const existingSummary = job.summary && typeof job.summary === 'object' ? job.summary : {};
  job.summary = {
    ...existingSummary,
    coverage: {
      passed,
      totals,
      thresholds: { ...COVERAGE_THRESHOLDS },
      message
    },
    error: passed ? null : message
  };

  job.status = passed ? JOB_STATUS.SUCCEEDED : JOB_STATUS.FAILED;
};

export const jobEvents = new EventEmitter();

export const JOB_STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
};

const isTerminalStatus = (status) =>
  status === JOB_STATUS.SUCCEEDED ||
  status === JOB_STATUS.FAILED ||
  status === JOB_STATUS.CANCELLED;

const now = () => new Date().toISOString();

const mapJobStatusToRunStatus = (jobStatus) => {
  if (jobStatus === JOB_STATUS.SUCCEEDED) return 'completed';
  if (jobStatus === JOB_STATUS.FAILED) return 'failed';
  if (jobStatus === JOB_STATUS.CANCELLED) return 'cancelled';
  if (jobStatus === JOB_STATUS.RUNNING) return 'running';
  return 'pending';
};

const enqueueRunEvent = (job, event) => {
  if (!job || !event) {
    return;
  }

  const normalized = {
    ...event,
    meta: {
      ...(event.meta && typeof event.meta === 'object' ? event.meta : null),
      jobId: job.id,
      jobType: job.type
    }
  };

  if (job.runId) {
    appendRunEvent(job.runId, normalized).catch(() => {});
    return;
  }

  if (!Array.isArray(job.pendingRunEvents)) {
    job.pendingRunEvents = [];
  }
  job.pendingRunEvents.push(normalized);
};

const enqueueRunUpdate = (job, updates) => {
  if (!job || !updates) {
    return;
  }

  if (job.runId) {
    updateRun(job.runId, updates).catch(() => {});
    return;
  }

  job.pendingRunUpdates = {
    ...(job.pendingRunUpdates && typeof job.pendingRunUpdates === 'object' ? job.pendingRunUpdates : {}),
    ...updates
  };
};

const flushPendingRunWork = async (job) => {
  if (!job?.runId) {
    return;
  }

  const pendingUpdates = job.pendingRunUpdates;
  job.pendingRunUpdates = null;
  if (pendingUpdates && Object.keys(pendingUpdates).length) {
    try {
      await updateRun(job.runId, pendingUpdates);
    } catch {
      // Best-effort.
    }
  }

  const pendingEvents = Array.isArray(job.pendingRunEvents) ? job.pendingRunEvents : [];
  job.pendingRunEvents = [];

  for (const evt of pendingEvents) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await appendRunEvent(job.runId, evt);
    } catch {
      // Best-effort.
    }
  }
};

const pushLog = (job, stream, chunk) => {
  if (!chunk) {
    return;
  }
  const message = chunk.toString('utf8');
  if (!message.trim()) {
    return;
  }
  const timestamp = now();
  const entry = { stream, message: message.trimEnd(), timestamp };
  job.logs.push(entry);
  if (job.logs.length > MAX_LOG_ENTRIES) {
    job.logs.splice(0, job.logs.length - MAX_LOG_ENTRIES);
  }

  appendTestSummaryLines(job, entry.message);

  emitJobLog(job, entry);

  enqueueRunEvent(job, {
    type: 'job:log',
    timestamp,
    message: entry.message,
    payload: { stream }
  });
};

const sanitizeJob = (job) => {
  if (!job) {
    return null;
  }
  const { process, ...rest } = job;
  return {
    ...rest,
    logs: [...rest.logs]
  };
};

const terminatePid = (
  pid,
  platform = process.platform,
  deps = { spawn, kill: process.kill }
) => {
  if (!pid) {
    return;
  }

  if (platform === 'win32') {
    deps.spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    return;
  }

  deps.kill(pid, 'SIGTERM');
};

const emitJobCreated = (job) => {
  try {
    jobEvents.emit('job:created', sanitizeJob(job));
  } catch {
    // Ignore emitter failures.
  }
};

const emitJobUpdated = (job) => {
  try {
    jobEvents.emit('job:updated', sanitizeJob(job));
  } catch {
    // Ignore emitter failures.
  }
};

const emitJobLog = (job, entry) => {
  try {
    jobEvents.emit('job:log', {
      projectId: job?.projectId,
      jobId: job?.id,
      entry
    });
  } catch {
    // Ignore emitter failures.
  }
};

export const listJobsForProject = (projectId) => {
  const normalizedId = Number(projectId);
  return [...jobs.values()]
    .filter((job) => job.projectId === normalizedId)
    .map(sanitizeJob);
};

export const getJob = (jobId) => sanitizeJob(jobs.get(jobId));

export const waitForJobCompletion = (jobId, { timeoutMs = 10 * 60 * 1000 } = {}) => {
  if (!jobId) {
    return Promise.reject(new Error('jobId is required'));
  }

  const existing = jobs.get(jobId);
  if (!existing) {
    return Promise.reject(new Error('Job not found'));
  }

  if (isTerminalStatus(existing.status)) {
    return Promise.resolve(sanitizeJob(existing));
  }

  const normalizedTimeout = Number.isFinite(timeoutMs) ? timeoutMs : 10 * 60 * 1000;

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      jobEvents.removeListener('job:updated', onUpdate);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    };

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const onUpdate = (updatedJob) => {
      if (!updatedJob || updatedJob.id !== jobId) {
        return;
      }
      if (isTerminalStatus(updatedJob.status)) {
        finish(updatedJob);
      }
    };

    jobEvents.on('job:updated', onUpdate);

    const timeoutHandle = setTimeout(() => {
      const latest = getJob(jobId);
      if (latest && isTerminalStatus(latest.status)) {
        finish(latest);
        return;
      }
      finish(null, Object.assign(new Error('Timed out waiting for job completion'), { jobId }));
    }, Math.max(normalizedTimeout, 0));
  });
};

export const startJob = (config) => {
  const {
    projectId,
    type,
    displayName,
    command,
    args = [],
    cwd,
    env = {}
  } = config;

  if (!projectId || !type || !command || !cwd) {
    throw new Error('Missing required job configuration');
  }

  const id = randomUUID();
  const job = {
    id,
    projectId: Number(projectId),
    type,
    displayName: displayName || type,
    command,
    args,
    cwd,
    env,
    status: JOB_STATUS.PENDING,
    createdAt: now(),
    startedAt: null,
    completedAt: null,
    exitCode: null,
    signal: null,
    logs: [],
    runId: null,
    pendingRunEvents: [],
    pendingRunUpdates: null
  };

  jobs.set(id, job);

  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
    windowsHide: true
  });

  job.process = child;
  job.status = JOB_STATUS.RUNNING;
  job.startedAt = now();

  emitJobCreated(job);

  enqueueRunEvent(job, {
    type: 'job:created',
    timestamp: job.startedAt,
    message: `Job started: ${job.displayName}`,
    payload: {
      command: job.command,
      args: job.args,
      cwd: job.cwd,
      type: job.type,
      displayName: job.displayName
    }
  });

  createRun({
    projectId: job.projectId,
    kind: 'job',
    status: mapJobStatusToRunStatus(job.status),
    sessionId: job.id,
    statusMessage: job.displayName,
    metadata: {
      jobId: job.id,
      type: job.type,
      displayName: job.displayName,
      command: job.command,
      args: job.args,
      cwd: job.cwd
    },
    startedAt: job.startedAt
  })
    .then((created) => {
      if (!created?.id) {
        return;
      }
      job.runId = created.id;
      return flushPendingRunWork(job);
    })
    .catch(() => {
      // Best-effort only.
    });

  if (child.stdout) {
    child.stdout.on('data', (chunk) => pushLog(job, 'stdout', chunk));
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => pushLog(job, 'stderr', chunk));
  }

  child.on('error', (error) => {
    const errorMessage =
      error && typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : 'Job failed';

    pushLog(job, 'stderr', Buffer.from(errorMessage));
    job.status = JOB_STATUS.FAILED;
    job.completedAt = now();
    delete job.process;

    enqueueRunUpdate(job, {
      status: mapJobStatusToRunStatus(job.status),
      statusMessage: 'Job failed',
      error: errorMessage,
      finishedAt: job.completedAt
    });
    enqueueRunEvent(job, {
      type: 'job:failed',
      timestamp: job.completedAt,
      message: errorMessage,
      payload: { status: mapJobStatusToRunStatus(job.status) }
    });

    emitJobUpdated(job);
  });

  child.on('exit', (code, signal) => {
    job.exitCode = code;
    job.signal = signal || null;
    const isTestJob = isTestJobType(job.type);

    // If a job was cancelled, keep it cancelled even if the process eventually exits
    // with a success/failure code.
    if (job.status !== JOB_STATUS.CANCELLED) {
      job.completedAt = now();
      job.status = isTestJob ? JOB_STATUS.RUNNING : code === 0 ? JOB_STATUS.SUCCEEDED : JOB_STATUS.FAILED;
    }

    delete job.process;

    const finalize = async () => {
      if (job.status === JOB_STATUS.CANCELLED) {
        return;
      }

      const baseStatus = code === 0 ? JOB_STATUS.SUCCEEDED : JOB_STATUS.FAILED;
      if (baseStatus === JOB_STATUS.FAILED || !isTestJobType(job.type)) {
        job.status = baseStatus;
        return;
      }

      await evaluateCoverageGate(job, { assumeSucceeded: true });
    };

    finalize()
      .catch(() => {})
      .finally(() => {
        const runStatus = mapJobStatusToRunStatus(job.status);
        enqueueRunUpdate(job, {
          status: runStatus,
          statusMessage: job.status === JOB_STATUS.SUCCEEDED ? 'Job succeeded' : job.status === JOB_STATUS.CANCELLED ? 'Job cancelled' : 'Job failed',
          finishedAt: job.completedAt
        });
        enqueueRunEvent(job, {
          type: 'job:completed',
          timestamp: job.completedAt,
          message: `Job ${runStatus}`,
          payload: { status: runStatus, exitCode: code ?? null, signal: signal || null }
        });

        emitJobUpdated(job);
      });
  });

  return sanitizeJob(job);
};

export const cancelJob = (jobId) => {
  const job = jobs.get(jobId);
  if (!job) {
    return null;
  }

  if (job.status === JOB_STATUS.SUCCEEDED || job.status === JOB_STATUS.FAILED || job.status === JOB_STATUS.CANCELLED) {
    return sanitizeJob(job);
  }

  if (job.process && job.process.pid) {
    try {
      const pid = job.process.pid;

      // On Windows, spawned processes commonly run under a shell (cmd.exe). Killing
      // just the shell pid often leaves the child process tree running.
      terminatePid(pid, process.platform, { spawn, kill: process.kill });
    } catch (error) {
      const errorMessage =
        error && typeof error.message === 'string' && error.message.length > 0
          ? error.message
          : 'Job failed';
      pushLog(job, 'stderr', Buffer.from(errorMessage));
    }
  }

  job.status = JOB_STATUS.CANCELLED;
  job.completedAt = now();
  delete job.process;

  enqueueRunUpdate(job, {
    status: mapJobStatusToRunStatus(job.status),
    statusMessage: 'Job cancelled',
    finishedAt: job.completedAt
  });
  enqueueRunEvent(job, {
    type: 'job:cancelled',
    timestamp: job.completedAt,
    message: 'Job cancelled',
    payload: { status: mapJobStatusToRunStatus(job.status) }
  });

  emitJobUpdated(job);

  return sanitizeJob(job);
};

export const getAllJobs = () => [...jobs.values()].map(sanitizeJob);

// Exposed for testing to ensure isolated job state between runs.
export const __testing = {
  clearJobs: () => jobs.clear(),
  resetJobEvents: () => jobEvents.removeAllListeners(),
  getRawJob: (jobId) => jobs.get(jobId),
  terminatePid,
  mapJobStatusToRunStatus,
  appendTestSummaryLines,
  parseCoverageTotalsFromLogs,
  readCoverageTotals,
  evaluateCoverageGate,
  enqueueRunEvent,
  enqueueRunUpdate,
  flushPendingRunWork
};
