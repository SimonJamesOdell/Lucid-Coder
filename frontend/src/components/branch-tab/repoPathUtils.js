export const normalizeRepoPath = (value) => String(value ?? '')
  .replace(/\\/g, '/')
  .replace(/^\.\//, '')
  .trim();
