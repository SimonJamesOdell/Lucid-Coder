export const DEFAULT_EXPANDED_FOLDERS = ['src', 'public'];
export const DEFAULT_EXPLORER_WIDTH = 260;
export const MIN_EXPLORER_WIDTH = 180;
export const MAX_EXPLORER_WIDTH = 520;

export const clampExplorerWidth = (value) => {
  if (!Number.isFinite(value)) {
    return DEFAULT_EXPLORER_WIDTH;
  }
  return Math.min(Math.max(value, MIN_EXPLORER_WIDTH), MAX_EXPLORER_WIDTH);
};

const LANGUAGE_MAP = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  json: 'json',
  html: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  py: 'python',
  java: 'java',
  cpp: 'cpp',
  c: 'c',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  md: 'markdown',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell'
};

export const getLanguageFromFile = (file) => {
  if (!file) return 'plaintext';

  const ext = file.name.split('.').pop()?.toLowerCase();
  return LANGUAGE_MAP[ext] || 'plaintext';
};
