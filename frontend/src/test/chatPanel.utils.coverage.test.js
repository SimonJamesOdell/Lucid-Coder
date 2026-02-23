import { describe, test, expect } from 'vitest'
import { formatAgentStepMessage, parseClarificationOptions } from '../components/chatPanel/chatPanelUtils'

describe('chatPanelUtils coverage branches', () => {
  test('formats action branches for read_file and non-read_file actions', () => {
    expect(
      formatAgentStepMessage({ type: 'action', action: 'read_file', target: 'README.md', reason: 'debugging' })
    ).toBe('Agent is reading README.md (debugging).')

    expect(
      formatAgentStepMessage({ type: 'action', action: 'read_file', target: 'README.md' })
    ).toBe('Agent is reading README.md.')

    expect(
      formatAgentStepMessage({ type: 'action', action: 'read_file' })
    ).toBe('Agent is reading a file.')

    expect(
      formatAgentStepMessage({ type: 'action', action: 'run_tests' })
    ).toBe('Agent is performing action: run_tests.')
  })

  test('formats observation branches and invalid inputs', () => {
    expect(
      formatAgentStepMessage({ type: 'observation', action: 'read_file', error: 'Permission denied', target: 'secrets.txt' })
    ).toBe('Agent could not read secrets.txt: Permission denied')

    expect(
      formatAgentStepMessage({ type: 'observation', action: 'read_file', error: 'Permission denied' })
    ).toBe('Agent could not read file: Permission denied')

    expect(
      formatAgentStepMessage({ type: 'observation', action: 'read_file' })
    ).toBeNull()

    expect(
      formatAgentStepMessage({ type: 'observation', error: 'Boom' })
    ).toBe('Agent observation error: Boom')

    expect(
      formatAgentStepMessage({ type: 'observation', summary: 'All good' })
    ).toBe('Agent observation: All good')

    expect(
      formatAgentStepMessage({ type: 'observation' })
    ).toBe('Agent observation: No details provided.')

    expect(formatAgentStepMessage(null)).toBeNull()
    expect(formatAgentStepMessage('bad')).toBeNull()
    expect(formatAgentStepMessage({ type: 'unknown' })).toBeNull()
  })

  test('returns empty options for non-string questions', () => {
    expect(parseClarificationOptions(null)).toEqual([])
    expect(parseClarificationOptions(42)).toEqual([])
  })

  test('returns empty options when parsed options are outside allowed bounds', () => {
    expect(parseClarificationOptions('Options: onlyone')).toEqual([])
    expect(parseClarificationOptions('Options: a / b / c / d / e / f')).toEqual([])
  })
})
