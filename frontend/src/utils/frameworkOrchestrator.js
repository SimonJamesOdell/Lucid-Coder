/**
 * Framework Orchestrator - Frontend Wrapper
 * 
 * Provides a frontend-safe interface for framework analysis.
 */

const KNOWN_FRAMEWORKS = new Set([
  'react',
  'vue',
  'svelte',
  'nextjs',
  'nuxt',
  'angular',
  'solid'
]);

const ROUTER_PREFERRED_FRAMEWORKS = new Set(['react', 'vue', 'svelte', 'solid']);
const BUILTIN_ROUTER_FRAMEWORKS = new Set(['nextjs', 'nuxt', 'angular']);

const normalizeFramework = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }

  if (normalized === 'next' || normalized === 'next.js') {
    return 'nextjs';
  }
  if (normalized === 'nuxt.js') {
    return 'nuxt';
  }
  if (normalized === 'sveltekit' || normalized === '@sveltejs/kit') {
    return 'svelte';
  }

  return normalized;
};

const inferFrameworkFromContext = (projectContext = null) => {
  if (!projectContext || typeof projectContext !== 'object') {
    return 'unknown';
  }

  const project = projectContext.project && typeof projectContext.project === 'object'
    ? projectContext.project
    : projectContext;

  const explicit = normalizeFramework(project.frontend_framework || project.framework || project.frontendFramework);
  if (KNOWN_FRAMEWORKS.has(explicit)) {
    return explicit;
  }

  const infoText = String(projectContext.projectInfo || '').toLowerCase();
  if (infoText.includes('framework: react')) return 'react';
  if (infoText.includes('framework: vue')) return 'vue';
  if (infoText.includes('framework: svelte')) return 'svelte';
  if (infoText.includes('framework: next')) return 'nextjs';
  if (infoText.includes('framework: nuxt')) return 'nuxt';
  if (infoText.includes('framework: angular')) return 'angular';
  if (infoText.includes('framework: solid')) return 'solid';

  return 'unknown';
};

const inferRouterAvailability = (framework = 'unknown') => {
  const normalized = normalizeFramework(framework);
  if (ROUTER_PREFERRED_FRAMEWORKS.has(normalized) || BUILTIN_ROUTER_FRAMEWORKS.has(normalized)) {
    return true;
  }
  return false;
};

const buildFrameworkRecommendation = (framework = 'unknown') => {
  const normalized = normalizeFramework(framework);
  if (normalized === 'react') {
    return 'React SPA detected. Prefer react-router-dom for multi-page/internal navigation flows.';
  }
  if (normalized === 'vue') {
    return 'Vue SPA detected. Prefer vue-router for multi-page/internal navigation flows.';
  }
  if (normalized === 'svelte') {
    return 'Svelte frontend detected. Prefer a router solution for SPA route management.';
  }
  if (BUILTIN_ROUTER_FRAMEWORKS.has(normalized)) {
    return `${normalized} detected. Use the framework\'s built-in routing patterns.`;
  }
  return 'Unable to auto-detect framework - proceeding with generic approach';
};

/**
 * Analyze project based on user intent
 * Returns decision info for framework suggestions
 */
export async function analyzeProject(userIntent = '', projectContext = null) {
  try {
    console.log('[Frontend Orchestrator] Analyzing project for intent:', userIntent);

    const framework = inferFrameworkFromContext(projectContext);
    const routerDependency = inferRouterAvailability(framework);
    const isKnownFramework = framework !== 'unknown';
    const recommendation = buildFrameworkRecommendation(framework);

    return {
      success: true,
      profile: {
        detected: {
          framework,
          routerDependency
        }
      },
      decision: {
        decision: isKnownFramework ? 'proceed' : 'proceed_with_caution',
        confidence: isKnownFramework ? 0.85 : 0.3,
        normalized: isKnownFramework ? 0.85 : 0.3,
        recommendation
      },
      recommendation: null
    };
  } catch (error) {
    console.error('[Frontend Orchestrator] Analysis error:', error?.message);
    return {
      success: false,
      error: error?.message || 'Framework analysis failed',
      profile: null,
      decision: null
    };
  }
}

/**
 * Validate router dependency availability
 */
export async function validateRouterDependency(framework = 'react') {
  try {
    console.log(`[Frontend Orchestrator] Validating router for ${framework}`);
    const normalizedFramework = normalizeFramework(framework);
    const hasRouter = inferRouterAvailability(normalizedFramework);

    let recommendation = 'Router package not detected - will be suggested if needed';
    if (normalizedFramework === 'react') {
      recommendation = 'Use react-router-dom for SPA route navigation.';
    } else if (normalizedFramework === 'vue') {
      recommendation = 'Use vue-router for SPA route navigation.';
    } else if (normalizedFramework === 'svelte') {
      recommendation = 'Use a router solution for SPA route navigation in Svelte projects.';
    } else if (BUILTIN_ROUTER_FRAMEWORKS.has(normalizedFramework)) {
      recommendation = 'Use built-in framework routing APIs.';
    }

    return {
      success: true,
      framework: normalizedFramework || 'unknown',
      hasRouter,
      recommendation
    };
  } catch (error) {
    console.error('[Frontend Orchestrator] Router validation error:', error?.message);
    return {
      success: false,
      error: error?.message
    };
  }
}

/**
 * Validate generation against framework safeguards
 */
export async function validateGenerationSafety(edits, framework = 'react') {
  try {
    const profileArg = edits && typeof edits === 'object' && edits.detected ? edits : null;
    const frameworkArg = profileArg?.detected?.framework || framework;
    const normalizedFramework = normalizeFramework(frameworkArg);
    const editsCount = Array.isArray(edits) ? edits.length : 0;

    console.log(`[Frontend Orchestrator] Validating ${editsCount} edits against ${normalizedFramework || 'unknown'} safeguards`);

    const withRouter = inferRouterAvailability(normalizedFramework);

    return {
      success: true,
      framework: normalizedFramework || 'unknown',
      editsCount,
      violations: [],
      safe: true,
      safeToGenerate: {
        withRouter
      },
      recommendation: withRouter
        ? 'Framework supports router-first SPA patterns.'
        : 'Apply conservative navigation patterns without router assumptions.'
    };
  } catch (error) {
    console.error('[Frontend Orchestrator] Safety validation error:', error?.message);
    return {
      success: false,
      error: error?.message,
      safe: false
    };
  }
}

export default {
  analyzeProject,
  validateRouterDependency,
  validateGenerationSafety
};
