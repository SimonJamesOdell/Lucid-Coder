import { describe, test, expect } from 'vitest'
import { ClarificationTracker } from '../../utils/ClarificationTracker'

describe('ClarificationTracker', () => {
  test('hashIntent handles keyword mappings and fallbacks', () => {
    expect(ClarificationTracker.hashIntent('Should we use react-router-dom?')).toBe('router_usage')
    expect(ClarificationTracker.hashIntent('Login + auth flow?')).toBe('auth_pattern')
    expect(ClarificationTracker.hashIntent('')).toBe('intent_empty')
    expect(ClarificationTracker.hashIntent(null)).toBe('intent_empty')
    expect(ClarificationTracker.hashIntent('tiny')).toMatch(/^intent_/)
  })

  test('records, retrieves, exports, imports and clears responses', () => {
    const tracker = new ClarificationTracker()

    expect(tracker.hasAsked('goal_1', 'router question')).toBe(false)

    tracker.record('goal_1', 'router question', 'Use router?', 'yes')

    expect(tracker.hasAsked('goal_1', 'router question')).toBe(true)
    expect(tracker.getAnswer('goal_1', 'router question')).toBe('yes')

    const all = tracker.getAll('goal_1')
    expect(all).toHaveLength(1)
    expect(all[0].question).toBe('Use router?')

    const exported = tracker.export()
    const imported = new ClarificationTracker()
    imported.import(exported)

    expect(imported.getAnswer('goal_1', 'router question')).toBe('yes')

    imported.clear('goal_1')
    expect(imported.getAll('goal_1')).toEqual([])

    tracker.clear()
    expect(tracker.getAll('goal_1')).toEqual([])
  })

  test('returns null/empty values for missing categories', () => {
    const tracker = new ClarificationTracker()

    expect(tracker.getAnswer('missing', 'unknown')).toBeNull()
    expect(tracker.getAll('missing')).toEqual([])
  })

  test('returns null when category exists but the intent hash is not found', () => {
    const tracker = new ClarificationTracker()
    tracker.record('goal_1', 'router question', 'Use router?', 'yes')

    expect(tracker.getAnswer('goal_1', 'different intent')).toBeNull()
  })

  test('import keeps existing session id when incoming session id is missing', () => {
    const tracker = new ClarificationTracker()
    const originalSessionId = tracker.sessionId

    tracker.import({ responses: undefined })

    expect(tracker.sessionId).toBe(originalSessionId)
    expect(tracker.getAll('missing')).toEqual([])
  })

  test('import applies provided session id and restores category entries', () => {
    const tracker = new ClarificationTracker()

    tracker.import({
      sessionId: 'restored-session',
      responses: {
        goal_2: {
          router_usage: {
            question: 'Use router?',
            answer: 'no',
            timestamp: 1,
            intent: 'router question'
          }
        }
      }
    })

    expect(tracker.sessionId).toBe('restored-session')
    expect(tracker.getAnswer('goal_2', 'router question')).toBe('no')
  })

  test('builds duplicate prevention report entries', () => {
    const tracker = new ClarificationTracker()
    tracker.record('navbar', 'router question', 'Use router?', 'yes')

    const report = tracker.getDuplicatePrevention()

    expect(report.sessionId).toBeTruthy()
    expect(report.categories).toContain('navbar')
    expect(report.totalAsked).toBe(1)
    expect(report.questionsTracked[0].intentHash).toBe(ClarificationTracker.hashIntent('router question'))
    expect(report.questionsTracked[0].preventsDuplicate).toContain('Future questions matching')
  })

  test('returns an empty duplicate prevention report when no questions were recorded', () => {
    const tracker = new ClarificationTracker()
    const report = tracker.getDuplicatePrevention()

    expect(report.totalAsked).toBe(0)
    expect(report.questionsTracked).toEqual([])
  })

  test('summarizes duplicate prevention across multiple categories', () => {
    const tracker = new ClarificationTracker()
    tracker.record('navbar', 'router question', 'Use router?', 'yes')
    tracker.record('auth', 'login flow', 'Need auth?', 'required')

    const report = tracker.getDuplicatePrevention()

    expect(report.totalAsked).toBe(2)
    expect(report.categories).toEqual(expect.arrayContaining(['navbar', 'auth']))
    expect(report.questionsTracked).toHaveLength(2)
  })

})
