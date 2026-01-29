const MAX_JOB_LOG_LINES_PER_JOB = 60;
const MAX_TOTAL_JOB_LOG_LINES = 200;

const buildAutopilotJobLogLines = (jobs = []) => {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    return [];
  }

  const lines = [];
  let totalLines = 0;

  jobs.forEach((job, jobIndex) => {
    if (!job || job.type !== 'test-run' || !Array.isArray(job.logs) || job.logs.length === 0) {
      return;
    }

    const logSlice = job.logs.slice(-MAX_JOB_LOG_LINES_PER_JOB);
    if (logSlice.length === 0) {
      return;
    }

    lines.push({
      key: `job-${jobIndex}-header`,
      text: `${job.displayName || 'Test Run'} • ${job.status || 'pending'}`,
      variant: 'header'
    });

    logSlice.forEach((entry, entryIdx) => {
      if (totalLines >= MAX_TOTAL_JOB_LOG_LINES) {
        return;
      }
      totalLines += 1;
      lines.push({
        key: `job-${jobIndex}-log-${entryIdx}`,
        text: entry?.message || '',
        stream: entry?.stream || 'stdout'
      });
    });
  });

  return lines;
};

export { buildAutopilotJobLogLines };
