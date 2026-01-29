export const normalizePathForCompare = (value) => String(value).replace(/\\/g, '/');

export const isRelevantSourceFile = (filePath) => {
  const normalized = normalizePathForCompare(filePath).toLowerCase();
  return (
    normalized.endsWith('.js') ||
    normalized.endsWith('.jsx') ||
    normalized.endsWith('.ts') ||
    normalized.endsWith('.tsx') ||
    normalized.endsWith('.mjs') ||
    normalized.endsWith('.cjs') ||
    normalized.endsWith('.vue')
  );
};
