export const dedupeCommitsBySha = (commits = []) => {
  if (!Array.isArray(commits) || commits.length === 0) {
    return [];
  }

  const seen = new Set();
  return commits.filter((commit) => {
    const sha = typeof commit?.sha === 'string' ? commit.sha : '';
    if (!sha) {
      return true;
    }
    if (seen.has(sha)) {
      return false;
    }
    seen.add(sha);
    return true;
  });
};

export const formatGateValue = (value) => {
  if (value == null) {
    return 'Unknown';
  }
  return String(value);
};

export const formatCoverageGateLabel = (summary) => {
  const coverage = summary?.coverage;
  const pct = coverage?.totals?.lines?.pct;
  const required = coverage?.thresholds?.lines;

  const hasPct = typeof pct === 'number' && Number.isFinite(pct);
  const hasRequired = typeof required === 'number' && Number.isFinite(required);

  if (!hasPct && !hasRequired) {
    return null;
  }

  const pctLabel = hasPct ? `${Math.round(pct)}%` : 'Unknown';
  const requiredLabel = hasRequired ? `${Math.round(required)}%` : 'Unknown';
  return `${pctLabel} / ${requiredLabel}`;
};

export const formatTimestamp = (value) => {
  if (!value) {
    return 'Unknown time';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return date.toLocaleString();
};
