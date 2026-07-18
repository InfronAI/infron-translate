import { describe, it, expect } from 'vitest'
import { parseTranslateBatchResult } from '../../src/shared/schema'

describe('parseTranslateBatchResult', () => {
  it('keeps only allowed ids', () => {
    const parsed = parseTranslateBatchResult(
      {
        items: [
          { id: 'a', translation: '甲' },
          { id: 'evil', translation: 'x' },
          { id: 'b', translation: '乙' },
        ],
      },
      new Set(['a', 'b']),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.items).toEqual([
        { id: 'a', translation: '甲' },
        { id: 'b', translation: '乙' },
      ])
    }
  })

  it('fails when items missing', () => {
    const parsed = parseTranslateBatchResult({}, new Set())
    expect(parsed.ok).toBe(false)
  })
})
