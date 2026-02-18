import { describe, test, expect } from 'vitest'
import { parseClarificationOptions } from '../components/chatPanel/chatPanelUtils'

describe('chatPanelUtils coverage branches', () => {
  test('returns empty options for non-string questions', () => {
    expect(parseClarificationOptions(null)).toEqual([])
    expect(parseClarificationOptions(42)).toEqual([])
  })

  test('returns empty options when parsed options are outside allowed bounds', () => {
    expect(parseClarificationOptions('Options: onlyone')).toEqual([])
    expect(parseClarificationOptions('Options: a / b / c / d / e / f')).toEqual([])
  })
})
