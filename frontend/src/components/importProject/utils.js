export const FRONTEND_LANGUAGES = ['javascript', 'typescript'];

export const BACKEND_LANGUAGES = ['javascript', 'typescript', 'python', 'java', 'csharp', 'go', 'rust', 'php', 'ruby', 'swift'];

const FRONTEND_FRAMEWORKS = {
  javascript: ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vite'],
  typescript: ['react', 'vue', 'angular', 'svelte', 'nextjs', 'nuxtjs', 'vite']
};

const BACKEND_FRAMEWORKS = {
  javascript: ['express', 'nestjs', 'fastify', 'koa', 'hapi'],
  typescript: ['express', 'nestjs', 'fastify', 'koa', 'hapi'],
  python: ['django', 'flask', 'fastapi', 'pyramid', 'tornado'],
  java: ['spring', 'springboot', 'hibernate', 'struts', 'jsf'],
  csharp: ['aspnet', 'aspnetcore', 'mvc', 'webapi', 'blazor'],
  go: ['gin', 'echo', 'fiber', 'gorilla', 'chi'],
  rust: ['actix', 'warp', 'rocket', 'axum', 'tide'],
  php: ['laravel', 'symfony', 'codeigniter', 'zend', 'cakephp'],
  ruby: ['rails', 'sinatra', 'padrino', 'hanami', 'grape'],
  swift: ['vapor', 'perfect', 'kitura', 'swiftnio']
};

const SUPPORTED_IMPORT_TABS = ['local', 'git'];

export const resolveFrontendFrameworks = (language) => FRONTEND_FRAMEWORKS[language] || ['none'];

export const resolveBackendFrameworks = (language) => BACKEND_FRAMEWORKS[language] || ['none'];

export const sanitizeImportTab = (tab) => (SUPPORTED_IMPORT_TABS.includes(tab) ? tab : 'local');

export const guessProjectName = (value) => {
  if (!value || typeof value !== 'string') {
    return '';
  }
  const cleaned = value.trim().replace(/[?#].*$/, '');
  if (!cleaned) {
    return '';
  }
  const segments = cleaned.split(/[\\/]/).filter(Boolean);
  let candidate = '';
  if (segments.length > 0) {
    candidate = segments[segments.length - 1];
  }
  if (candidate.includes(':')) {
    const afterColon = candidate.split(':').pop();
    if (!afterColon) {
      return '';
    }
    candidate = afterColon;
  }
  return candidate.replace(/\.git$/i, '');
};
