const SNAPSHOT_MAX_FILES = 200;
const SNAPSHOT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'coverage-tmp',
  '.cache',
  '.next',
  '.turbo',
  '.vite',
  '.idea',
  '.vscode'
]);
const SNAPSHOT_IGNORED_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  '.DS_Store'
]);

const createCollectProjectFileList = ({ fs, path }) => async (rootPath, limit = SNAPSHOT_MAX_FILES) => {
  const results = [];
  const queue = [''];

  while (queue.length && results.length < limit) {
    const relative = queue.shift();
    const absolute = path.join(rootPath, relative);
    let entries = [];

    try {
      entries = await fs.readdir(absolute, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= limit) break;
      const entryName = entry.name;
      if (SNAPSHOT_IGNORED_FILES.has(entryName)) {
        continue;
      }
      const relPath = path.posix
        .join(relative.replace(/\\/g, '/'), entryName)
        .replace(/^\//, '');
      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORED_DIRS.has(entryName)) {
          continue;
        }
        results.push(`${relPath}/`);
        queue.push(path.join(relative, entryName));
      } else {
        results.push(relPath);
      }
    }
  }

  return results;
};

const createBuildPlannerProjectSnapshot = ({ getProject, path, readTextFile, truncateSection, collectProjectFileList }) =>
  async (projectId) => {
    const project = await getProject(projectId).catch(() => null);
    if (!project?.path) {
      return '';
    }

    const projectRoot = project.path;
    const sections = [];

    const pushFileSection = async (label, relativePath, limit = 2000) => {
      const content = await readTextFile(path.join(projectRoot, relativePath));
      if (content) {
        sections.push(`${label} (${relativePath}):\n${truncateSection(content, limit)}`);
      }
    };

    await pushFileSection('README', 'README.md', 1800);
    await pushFileSection('Root package.json', 'package.json', 1800);
    await pushFileSection('Frontend package.json', path.join('frontend', 'package.json'), 1800);
    await pushFileSection('Backend package.json', path.join('backend', 'package.json'), 1800);

    const commonFrontendEntries = [
      path.join('frontend', 'src', 'App.jsx'),
      path.join('frontend', 'src', 'App.tsx'),
      path.join('frontend', 'src', 'App.js'),
      path.join('frontend', 'src', 'main.jsx'),
      path.join('frontend', 'src', 'main.tsx'),
      path.join('frontend', 'src', 'main.js'),
      path.join('frontend', 'src', 'index.jsx'),
      path.join('frontend', 'src', 'index.tsx'),
      path.join('frontend', 'src', 'index.js')
    ];

    for (const entry of commonFrontendEntries) {
      await pushFileSection('Frontend entry', entry, 1400);
    }

    const fileList = await collectProjectFileList(projectRoot, SNAPSHOT_MAX_FILES);
    if (fileList.length > 0) {
      sections.push(`Project file list (truncated):\n${fileList.join('\n')}`);
    }

    return sections.join('\n\n');
  };

export { createBuildPlannerProjectSnapshot, createCollectProjectFileList };
