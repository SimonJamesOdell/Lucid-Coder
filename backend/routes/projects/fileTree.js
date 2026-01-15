import path from 'path';

const DEFAULT_IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '.vscode',
  '.idea'
]);

const DEFAULT_IGNORED_FILES = new Set([
  '.DS_Store',
  'Thumbs.db',
  '.env.local',
  '.env.development.local',
  '.env.test.local',
  '.env.production.local'
]);

const DEFAULT_EXTENSION_LANGUAGE_MAP = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.vue': 'vue',
  '.py': 'python',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.html': 'html',
  '.json': 'json',
  '.md': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.xml': 'xml',
  '.svg': 'svg',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.ico': 'image'
};

const shouldSkipHiddenEntry = (name) =>
  name.startsWith('.') && !name.match(/^\.(gitignore|env\.example|editorconfig|prettierrc|eslintrc)$/);

export async function buildFileTree(dirPath, relativePath = '', { getFsModule } = {}) {
  if (typeof getFsModule !== 'function') {
    throw new Error('getFsModule must be provided');
  }

  const fs = await getFsModule();
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  const tree = [];

  for (const entry of entries) {
    if (shouldSkipHiddenEntry(entry.name)) {
      continue;
    }

    if (entry.isDirectory() && DEFAULT_IGNORED_DIRS.has(entry.name)) {
      continue;
    }

    if (entry.isFile() && DEFAULT_IGNORED_FILES.has(entry.name)) {
      continue;
    }

    const itemPath = path.join(dirPath, entry.name);
    const itemRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const children = await buildFileTree(itemPath, itemRelativePath, { getFsModule });
      tree.push({
        name: entry.name,
        type: 'folder',
        path: itemRelativePath,
        children
      });
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      tree.push({
        name: entry.name,
        type: 'file',
        path: itemRelativePath,
        language: DEFAULT_EXTENSION_LANGUAGE_MAP[ext] || 'text'
      });
    }
  }

  tree.sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name);
    }
    return a.type === 'folder' ? -1 : 1;
  });

  return tree;
}
