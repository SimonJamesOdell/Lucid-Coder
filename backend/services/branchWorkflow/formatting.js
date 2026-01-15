const DEFAULT_COMMIT_HISTORY_LIMIT = 25;
const MAX_COMMIT_HISTORY_LIMIT = 200;

export const MAX_FILE_DIFF_CHARS = 2000;
export const MAX_AGGREGATE_DIFF_CHARS = 12000;

export const parseJsonColumn = (value, fallback = null) => {
  if (!value) {
    return fallback;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const withStatusCode = (error, statusCode = 400) => {
  error.statusCode = statusCode;
  return error;
};

export const parseStagedFiles = (value) => parseJsonColumn(value, []);

export const summarizeStagedChanges = (stagedFiles = []) => {
  if (!Array.isArray(stagedFiles) || stagedFiles.length === 0) {
    return 'staged changes';
  }
  if (stagedFiles.length === 1) {
    return stagedFiles[0].path || 'staged changes';
  }
  return `${stagedFiles.length} files`;
};

export const trimDiff = (diffText, limit = MAX_FILE_DIFF_CHARS) => {
  if (!diffText) {
    return '';
  }
  if (diffText.length <= limit) {
    return diffText;
  }
  return `${diffText.slice(0, limit)}\n…diff truncated…`;
};

const templateTokenHandlers = {
  summary: (context) => context.summary || '',
  branch: (context) => context.branch || '',
  branchname: (context) => context.branch || '',
  filecount: (context) => context.fileCount || ''
};

export const interpolateCommitTemplate = (template, context = {}) => (
  String(template || '').replace(/\{([a-z]+)\}/gi, (match, token) => {
    const handler = templateTokenHandlers[token.toLowerCase()];
    return handler ? handler(context) : match;
  })
);

export const buildCommitMessage = ({
  requestedMessage,
  gitSettings,
  branchName,
  stagedFiles
} = {}) => {
  const explicit = typeof requestedMessage === 'string' ? requestedMessage.trim() : '';
  if (explicit) {
    return explicit;
  }

  const summary = summarizeStagedChanges(stagedFiles);
  if (gitSettings?.useCommitTemplate && gitSettings.commitTemplate) {
    return interpolateCommitTemplate(gitSettings.commitTemplate, {
      summary,
      branch: branchName,
      fileCount: String(stagedFiles?.length || 0)
    }) || summary;
  }

  return `chore(${branchName || 'workspace'}): update ${summary}`;
};

export const normalizeCommitLimit = (value) => {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    return DEFAULT_COMMIT_HISTORY_LIMIT;
  }
  return Math.min(Math.max(numeric, 1), MAX_COMMIT_HISTORY_LIMIT);
};

export const parseGitLog = (stdout = '') => stdout
  .split('\x1e')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [sha, authorName, authorEmail, authoredAt, subject, parents = ''] = entry.split('\x1f');
    const parentShas = parents
      .split(' ')
      .map((value) => value.trim())
      .filter(Boolean);
    const parentCount = parentShas.length;
    return {
      sha,
      shortSha: sha?.slice(0, 7) || '',
      message: subject || '',
      author: {
        name: authorName || 'Unknown',
        email: authorEmail || ''
      },
      authoredAt: authoredAt || null,
      parentShas,
      parentCount,
      canRevert: parentCount > 0,
      isInitialCommit: parentCount === 0
    };
  });
