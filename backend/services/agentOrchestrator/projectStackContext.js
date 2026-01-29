const createReadJsonFile = (fs) => async (filePath) => {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const createReadTextFile = (fs) => async (filePath) => {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
};

const normalizeDeps = (pkg) => ({
  ...(pkg?.dependencies || {}),
  ...(pkg?.devDependencies || {})
});

const detectFrontendFramework = (pkg) => {
  const deps = normalizeDeps(pkg);
  if (deps.react || deps['react-dom']) return 'react';
  if (deps.next) return 'nextjs';
  if (deps.vue) return 'vue';
  if (deps.nuxt) return 'nuxt';
  if (deps['@angular/core']) return 'angular';
  if (deps.svelte || deps['@sveltejs/kit']) return 'svelte';
  if (deps['solid-js']) return 'solid';
  if (deps.gatsby) return 'gatsby';
  if (deps.astro) return 'astro';
  return '';
};

const detectBackendFramework = (pkg) => {
  const deps = normalizeDeps(pkg);
  if (deps.express) return 'express';
  if (deps.fastify) return 'fastify';
  if (deps.koa) return 'koa';
  if (deps['@nestjs/core']) return 'nestjs';
  if (deps['@hapi/hapi']) return 'hapi';
  if (deps['@adonisjs/core']) return 'adonisjs';
  return '';
};

const detectPythonFramework = (requirementsText = '') => {
  const normalized = requirementsText.toLowerCase();
  if (/(^|\n)flask\b/.test(normalized)) return 'flask';
  if (/(^|\n)django\b/.test(normalized)) return 'django';
  if (/(^|\n)fastapi\b/.test(normalized)) return 'fastapi';
  if (/(^|\n)quart\b/.test(normalized)) return 'quart';
  return '';
};

const createResolveProjectStackContext = ({ getProject, path, readJsonFile, readTextFile }) => async (projectId) => {
  const project = await getProject(projectId).catch(() => null);
  if (!project) {
    return null;
  }

  const projectPath = typeof project.path === 'string' && project.path.trim() ? project.path.trim() : '';

  let frontendFramework = project.frontend_framework || project.framework || '';
  let backendFramework = project.backend_framework || '';
  let frontendLanguage = project.frontend_language || project.language || '';
  let backendLanguage = project.backend_language || '';

  if (projectPath) {
    const frontendPackage = await readJsonFile(path.join(projectPath, 'frontend', 'package.json'));
    if (!frontendFramework) {
      frontendFramework = detectFrontendFramework(frontendPackage);
    }
    if (!frontendLanguage && frontendPackage) {
      frontendLanguage = 'javascript';
    }

    const backendPackage = await readJsonFile(path.join(projectPath, 'backend', 'package.json'));
    if (!backendFramework) {
      backendFramework = detectBackendFramework(backendPackage);
    }
    if (!backendLanguage && backendPackage) {
      backendLanguage = 'javascript';
    }

    if (!backendFramework || !backendLanguage) {
      const requirementsText = await readTextFile(path.join(projectPath, 'backend', 'requirements.txt'));
      const pythonFramework = detectPythonFramework(requirementsText);
      if (pythonFramework) {
        backendFramework = backendFramework || pythonFramework;
        backendLanguage = backendLanguage || 'python';
      }
    }
  }

  const normalizeValue = (value) => (typeof value === 'string' ? value.trim() : '');
  const summary = [
    `frontend: ${normalizeValue(frontendFramework) || 'unknown'} (${normalizeValue(frontendLanguage) || 'unknown'})`,
    `backend: ${normalizeValue(backendFramework) || 'unknown'} (${normalizeValue(backendLanguage) || 'unknown'})`
  ];

  if (projectPath) {
    summary.push(`path: ${projectPath}`);
  }

  return summary.join('\n');
};

const truncateSection = (value = '', limit = 2000) => {
  if (!value) {
    return '';
  }
  return value.length > limit ? `${value.slice(0, limit)}\n…truncated…` : value;
};

export {
  createReadJsonFile,
  createReadTextFile,
  createResolveProjectStackContext,
  detectBackendFramework,
  detectFrontendFramework,
  detectPythonFramework,
  normalizeDeps,
  truncateSection
};
