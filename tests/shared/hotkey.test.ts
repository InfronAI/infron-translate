import { describe, it, expect } from 'vitest'
import {
  matchesHotkey,
  formatHotkeyLabel,
  hotkeyFromKeyboardEvent,
  hotkeysEqual,
  codeToKeyLabel,
} from '../../src/shared/hotkey'
import { DEFAULT_SETTINGS } from '../../src/shared/settings-defaults'

describe('matchesHotkey', () => {
  const hk = {
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    code: 'KeyK',
  }

  it('matches a configured chord', () => {
    expect(
      matchesHotkey(
        { code: 'KeyK', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false },
        hk,
      ),
    ).toBe(true)
  })

  it('rejects wrong key', () => {
    expect(
      matchesHotkey(
        { code: 'KeyJ', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false },
        hk,
      ),
    ).toBe(false)
  })

  it('rejects missing modifier', () => {
    expect(
      matchesHotkey(
        { code: 'KeyK', altKey: false, shiftKey: true, ctrlKey: false, metaKey: false },
        hk,
      ),
    ).toBe(false)
  })
})

describe('formatHotkeyLabel', () => {
  it('uses Option for alt', () => {
    expect(
      formatHotkeyLabel({
        altKey: true,
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
        code: 'KeyK',
      }),
    ).toBe('Option+Shift+K')
  })

  it('includes Ctrl and Meta when set', () => {
    expect(
      formatHotkeyLabel({
        altKey: false,
        shiftKey: false,
        ctrlKey: true,
        metaKey: true,
        code: 'KeyK',
      }),
    ).toBe('Ctrl+⌘+K')
  })

  it('formats the default full-page translation hotkey', () => {
    expect(formatHotkeyLabel(DEFAULT_SETTINGS.pageTranslationHotkey)).toBe('Option+Shift+;')
  })
})

describe('hotkeysEqual', () => {
  it('compares the full chord', () => {
    const first = {
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      code: 'KeyL',
    }
    expect(hotkeysEqual(first, { ...first })).toBe(true)
    expect(hotkeysEqual(first, DEFAULT_SETTINGS.pageTranslationHotkey)).toBe(false)
  })
})

describe('codeToKeyLabel', () => {
  it('maps Key and Digit codes', () => {
    expect(codeToKeyLabel('KeyA')).toBe('A')
    expect(codeToKeyLabel('Digit3')).toBe('3')
  })
})

describe('hotkeyFromKeyboardEvent', () => {
  it('ignores pure modifier keys', () => {
    expect(
      hotkeyFromKeyboardEvent({
        code: 'ShiftLeft',
        altKey: false,
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
      }),
    ).toBeNull()
  })

  it('captures chord with letter', () => {
    expect(
      hotkeyFromKeyboardEvent({
        code: 'KeyL',
        altKey: true,
        shiftKey: true,
        ctrlKey: false,
        metaKey: false,
      }),
    ).toEqual({
      code: 'KeyL',
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
    })
  })
})
