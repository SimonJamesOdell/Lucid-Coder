import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';

const MAX_LOG_ENTRIES = 500;
const jobs = new Map();

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

  emitJobLog(job, entry);
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
    logs: []
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

  if (child.stdout) {
    child.stdout.on('data', (chunk) => pushLog(job, 'stdout', chunk));
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk) => pushLog(job, 'stderr', chunk));
  }

  child.on('error', (error) => {
    pushLog(job, 'stderr', Buffer.from(error.message));
    job.status = JOB_STATUS.FAILED;
    job.completedAt = now();
    delete job.process;

    emitJobUpdated(job);
  });

  child.on('exit', (code, signal) => {
    job.exitCode = code;
    job.signal = signal || null;

    // If a job was cancelled, keep it cancelled even if the process eventually exits
    // with a success/failure code.
    if (job.status !== JOB_STATUS.CANCELLED) {
      job.status = code === 0 ? JOB_STATUS.SUCCEEDED : JOB_STATUS.FAILED;
      job.completedAt = now();
    }

    delete job.process;

    emitJobUpdated(job);
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
      pushLog(job, 'stderr', Buffer.from(error.message));
    }
  }

  job.status = JOB_STATUS.CANCELLED;
  job.completedAt = now();
  delete job.process;

  emitJobUpdated(job);

  return sanitizeJob(job);
};

export const getAllJobs = () => [...jobs.values()].map(sanitizeJob);

// Exposed for testing to ensure isolated job state between runs.
export const __testing = {
  clearJobs: () => jobs.clear(),
  resetJobEvents: () => jobEvents.removeAllListeners(),
  terminatePid
};
