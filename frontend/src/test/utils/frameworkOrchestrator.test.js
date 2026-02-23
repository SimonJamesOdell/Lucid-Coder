import { describe, test, expect, vi, afterEach } from 'vitest'
import * as orchestrator from '../../utils/frameworkOrchestrator'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('frameworkOrchestrator frontend wrapper', () => {
  test('analyzeProject infers framework context and returns router-aware defaults', async () => {
    const result = await orchestrator.analyzeProject('Add navbar', {
      project: {
        framework: 'react'
      }
    })

    expect(result.success).toBe(true)
    expect(result.profile?.detected?.framework).toBe('react')
    expect(result.profile?.detected?.routerDependency).toBe(true)
    expect(result.decision?.decision).toBe('proceed')
  })

  test('analyzeProject returns cautious defaults when framework cannot be inferred', async () => {
    const result = await orchestrator.analyzeProject('Add navbar')

    expect(result.success).toBe(true)
    expect(result.profile?.detected?.framework).toBe('unknown')
    expect(result.profile?.detected?.routerDependency).toBe(false)
    expect(result.decision?.decision).toBe('proceed_with_caution')
  })

  test('analyzeProject normalizes framework aliases and uses built-in router recommendation', async () => {
    const result = await orchestrator.analyzeProject('Add routes', {
      project: {
        framework: 'next.js'
      }
    })

    expect(result.success).toBe(true)
    expect(result.profile?.detected?.framework).toBe('nextjs')
    expect(result.profile?.detected?.routerDependency).toBe(true)
    expect(result.decision?.recommendation).toContain("built-in routing")
  })

  test('analyzeProject infers framework from projectInfo when explicit framework is unknown', async () => {
    const result = await orchestrator.analyzeProject('Add routes', {
      project: {
        framework: 'custom-framework'
      },
      projectInfo: 'Stack\nFramework: Vue\nLanguage: JavaScript'
    })

    expect(result.success).toBe(true)
    expect(result.profile?.detected?.framework).toBe('vue')
    expect(result.profile?.detected?.routerDependency).toBe(true)
    expect(result.decision?.recommendation).toContain('vue-router')
  })

  test('analyzeProject supports top-level context objects and sveltekit alias', async () => {
    const result = await orchestrator.analyzeProject('Add routes', {
      frontendFramework: '@sveltejs/kit'
    })

    expect(result.success).toBe(true)
    expect(result.profile?.detected?.framework).toBe('svelte')
    expect(result.profile?.detected?.routerDependency).toBe(true)
  })

  test('analyzeProject normalizes nuxt.js and sveltekit aliases from explicit framework fields', async () => {
    const nuxt = await orchestrator.analyzeProject('Add routes', {
      project: {
        framework: 'nuxt.js'
      }
    })

    const sveltekit = await orchestrator.analyzeProject('Add routes', {
      project: {
        framework: 'sveltekit'
      }
    })

    expect(nuxt.profile?.detected?.framework).toBe('nuxt')
    expect(nuxt.profile?.detected?.routerDependency).toBe(true)
    expect(sveltekit.profile?.detected?.framework).toBe('svelte')
  })

  test('analyzeProject infers additional frameworks from projectInfo markers', async () => {
    const solid = await orchestrator.analyzeProject('Add routes', {
      projectInfo: 'framework: solid'
    })
    const angular = await orchestrator.analyzeProject('Add routes', {
      projectInfo: 'framework: angular'
    })

    expect(solid.profile?.detected?.framework).toBe('solid')
    expect(angular.profile?.detected?.framework).toBe('angular')
    expect(angular.decision?.recommendation).toContain('built-in routing')
  })

  test('analyzeProject infers svelte from projectInfo when explicit framework is absent', async () => {
    const result = await orchestrator.analyzeProject('Add navigation', {
      projectInfo: 'Project\nFramework: Svelte\nLanguage: JavaScript'
    })

    expect(result.success).toBe(true)
    expect(result.profile?.detected?.framework).toBe('svelte')
    expect(result.profile?.detected?.routerDependency).toBe(true)
  })

  test('analyzeProject handles object context with unknown explicit framework and no projectInfo marker', async () => {
    const result = await orchestrator.analyzeProject('Add navigation', {
      project: { framework: 'custom-framework' }
    })

    expect(result.success).toBe(true)
    expect(result.profile?.detected?.framework).toBe('unknown')
    expect(result.decision?.decision).toBe('proceed_with_caution')
  })

  test('analyzeProject infers nextjs and nuxt from projectInfo markers', async () => {
    const next = await orchestrator.analyzeProject('Add routes', {
      projectInfo: 'framework: next'
    })
    const nuxt = await orchestrator.analyzeProject('Add routes', {
      projectInfo: 'framework: nuxt'
    })

    expect(next.profile?.detected?.framework).toBe('nextjs')
    expect(next.profile?.detected?.routerDependency).toBe(true)
    expect(nuxt.profile?.detected?.framework).toBe('nuxt')
    expect(nuxt.profile?.detected?.routerDependency).toBe(true)
  })

  test('analyzeProject falls back to unknown when projectInfo has no framework marker', async () => {
    const result = await orchestrator.analyzeProject('Add routes', {
      project: {
        framework: 'custom-framework'
      },
      projectInfo: 'Stack\nLanguage: JavaScript\nBuild: Vite'
    })

    expect(result.success).toBe(true)
    expect(result.profile?.detected?.framework).toBe('unknown')
    expect(result.decision?.decision).toBe('proceed_with_caution')
  })

  test('analyzeProject catch branch returns error payload', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('log failed')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await orchestrator.analyzeProject('Add navbar')

    expect(result.success).toBe(false)
    expect(result.error).toBe('log failed')
    expect(errorSpy).toHaveBeenCalled()
  })

  test('analyzeProject catch branch uses default message when thrown value has no message', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw { code: 'NO_MESSAGE' }
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await orchestrator.analyzeProject('Add navbar')

    expect(result.success).toBe(false)
    expect(result.error).toBe('Framework analysis failed')
  })

  test('validateRouterDependency returns success payload', async () => {
    const result = await orchestrator.validateRouterDependency('react')

    expect(result).toEqual(expect.objectContaining({
      success: true,
      framework: 'react',
      hasRouter: true
    }))
  })

  test('validateRouterDependency returns framework-specific recommendations across branches', async () => {
    const vue = await orchestrator.validateRouterDependency('vue')
    const svelte = await orchestrator.validateRouterDependency('svelte')
    const angular = await orchestrator.validateRouterDependency('angular')
    const unknown = await orchestrator.validateRouterDependency('ember')

    expect(vue.recommendation).toContain('vue-router')
    expect(svelte.recommendation).toContain('Svelte')
    expect(angular.recommendation).toContain('built-in framework routing')
    expect(unknown.hasRouter).toBe(false)
    expect(unknown.recommendation).toContain('not detected')
  })

  test('validateRouterDependency falls back framework value to unknown for empty inputs', async () => {
    const result = await orchestrator.validateRouterDependency('')

    expect(result.success).toBe(true)
    expect(result.framework).toBe('unknown')
    expect(result.hasRouter).toBe(false)
  })

  test('validateRouterDependency catch branch returns error payload', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('router log failed')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await orchestrator.validateRouterDependency('react')

    expect(result.success).toBe(false)
    expect(result.error).toBe('router log failed')
    expect(errorSpy).toHaveBeenCalled()
  })

  test('validateGenerationSafety returns success payload', async () => {
    const result = await orchestrator.validateGenerationSafety(
      { detected: { framework: 'react', routerDependency: true } },
      { decision: 'proceed' }
    )

    expect(result).toEqual(expect.objectContaining({
      success: true,
      framework: 'react',
      safe: true,
      editsCount: 0,
      safeToGenerate: expect.objectContaining({ withRouter: true })
    }))
  })

  test('validateGenerationSafety tracks array edits and conservative no-router recommendation', async () => {
    const result = await orchestrator.validateGenerationSafety(
      [{ file: 'src/App.jsx' }, { file: 'src/main.jsx' }],
      'unknown-framework'
    )

    expect(result.success).toBe(true)
    expect(result.framework).toBe('unknown-framework')
    expect(result.editsCount).toBe(2)
    expect(result.safeToGenerate.withRouter).toBe(false)
    expect(result.recommendation).toContain('conservative navigation patterns')
  })

  test('validateGenerationSafety uses unknown fallback label when normalized framework is empty', async () => {
    const result = await orchestrator.validateGenerationSafety([], '')

    expect(result.success).toBe(true)
    expect(result.framework).toBe('unknown')
    expect(result.editsCount).toBe(0)
    expect(result.safeToGenerate.withRouter).toBe(false)
  })

  test('validateGenerationSafety catch branch returns error payload', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {
      throw new Error('safety log failed')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await orchestrator.validateGenerationSafety([], 'react')

    expect(result.success).toBe(false)
    expect(result.error).toBe('safety log failed')
    expect(result.safe).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
  })

  test('default export exposes wrapper methods', () => {
    expect(orchestrator.default).toEqual(expect.objectContaining({
      analyzeProject: orchestrator.analyzeProject,
      validateRouterDependency: orchestrator.validateRouterDependency,
      validateGenerationSafety: orchestrator.validateGenerationSafety
    }))
  })
})
