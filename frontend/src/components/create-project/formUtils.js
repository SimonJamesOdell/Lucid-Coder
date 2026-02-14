export const FRONTEND_LANGUAGES = ['javascript', 'typescript'];

export const BACKEND_LANGUAGES = ['javascript', 'typescript', 'python', 'java', 'csharp', 'go', 'rust', 'php', 'ruby', 'swift'];

export const FRONTEND_FRAMEWORKS = {
  javascript: ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vanilla'],
  typescript: ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vanilla']
};

export const BACKEND_FRAMEWORKS = {
  javascript: ['express', 'fastify', 'koa', 'nestjs', 'nextjs-api'],
  typescript: ['express', 'fastify', 'koa', 'nestjs', 'nextjs-api'],
  python: ['django', 'flask', 'fastapi', 'pyramid', 'tornado'],
  java: ['spring', 'springboot', 'quarkus', 'micronaut'],
  csharp: ['aspnetcore', 'webapi', 'minimal-api'],
  go: ['gin', 'echo', 'fiber', 'gorilla', 'chi'],
  rust: ['actix', 'warp', 'rocket', 'axum', 'tide'],
  php: ['laravel', 'symfony', 'codeigniter', 'slim'],
  ruby: ['rails', 'sinatra', 'grape'],
  swift: ['vapor', 'perfect', 'kitura']
};

export const deriveRepoName = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return '';
  }
  const cleaned = raw.replace(/\.git$/i, '');
  const lastSlash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf(':'), cleaned.lastIndexOf('\\'));
  const candidate = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
  return candidate.trim();
};

export const resolveFrontendFrameworkOptions = (language) => FRONTEND_FRAMEWORKS[language] || ['react'];

export const resolveBackendFrameworkOptions = (language) => BACKEND_FRAMEWORKS[language] || ['express'];

export const applyDetectedTechToProject = (prevProject, detected) => {
  if (!detected || typeof detected !== 'object') {
    return prevProject;
  }

  const nextFrontendLang = detected?.frontend?.language || prevProject.frontend.language;
  const nextBackendLang = detected?.backend?.language || prevProject.backend.language;

  const frontendOptions = FRONTEND_FRAMEWORKS[nextFrontendLang] || FRONTEND_FRAMEWORKS.javascript;
  const backendOptions = BACKEND_FRAMEWORKS[nextBackendLang] || BACKEND_FRAMEWORKS.javascript;

  const nextFrontendFramework = frontendOptions.includes(detected?.frontend?.framework)
    ? detected.frontend.framework
    : frontendOptions[0];

  const nextBackendFramework = backendOptions.includes(detected?.backend?.framework)
    ? detected.backend.framework
    : backendOptions[0];

  return {
    ...prevProject,
    frontend: {
      language: nextFrontendLang,
      framework: nextFrontendFramework
    },
    backend: {
      language: nextBackendLang,
      framework: nextBackendFramework
    }
  };
};

export const buildGitSummaryItems = ({
  gitWorkflowMode,
  gitCloudMode,
  gitRepoName,
  gitRemoteUrl,
  gitProvider,
  globalProvider
}) => {
  const isCloudWorkflowUi = gitWorkflowMode === 'global' || gitWorkflowMode === 'custom';
  const derivedRepoNameForSummary = isCloudWorkflowUi
    ? (gitCloudMode === 'create' ? gitRepoName.trim() : deriveRepoName(gitRemoteUrl))
    : '';
  const shouldShowGitSummary =
    isCloudWorkflowUi &&
    gitCloudMode === 'connect' &&
    Boolean(gitRemoteUrl.trim());

  return shouldShowGitSummary
    ? [
        { label: 'Repo name', value: derivedRepoNameForSummary || '(not set)' },
        { label: 'Remote', value: gitRemoteUrl.trim() },
        { label: 'Provider', value: (gitWorkflowMode === 'custom' ? gitProvider : (globalProvider || 'github')) }
      ]
    : [];
};
