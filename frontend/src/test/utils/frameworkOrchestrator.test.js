import { describe, test, expect, vi, afterEach } from 'vitest'
import * as orchestrator from '../../utils/frameworkOrchestrator'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('frameworkOrchestrator frontend wrapper', () => {
  test('analyzeProject returns safe default shape', async () => {
    const result = await orchestrator.analyzeProject('Add navbar')

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
      hasRouter: false
    }))
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
    const result = await orchestrator.validateGenerationSafety([{ path: 'src/App.jsx' }], 'react')

    expect(result).toEqual(expect.objectContaining({
      success: true,
      framework: 'react',
      safe: true,
      editsCount: 1
    }))
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
