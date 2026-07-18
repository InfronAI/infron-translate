import { describe, expect, it } from 'vitest'
import {
  lensTranslationSigOf,
  pageTranslationSigOf,
} from '../../src/content/lens-controller'
import { DEFAULT_SETTINGS } from '../../src/shared/settings-defaults'

describe('LensController setting boundaries', () => {
  it('does not rebuild translations for automatic-mode toggles', () => {
    const changed = {
      ...DEFAULT_SETTINGS,
      autoTranslate: !DEFAULT_SETTINGS.autoTranslate,
      autoPageTranslation: !DEFAULT_SETTINGS.autoPageTranslation,
    }

    expect(lensTranslationSigOf(changed, false)).toBe(
      lensTranslationSigOf(DEFAULT_SETTINGS, false),
    )
    expect(pageTranslationSigOf(changed, false)).toBe(
      pageTranslationSigOf(DEFAULT_SETTINGS, false),
    )
  })

  it('keeps full-page engine changes isolated from lens translations', () => {
    const pageChanged = { ...DEFAULT_SETTINGS, pageTranslationEngine: 'external' as const }

    expect(pageTranslationSigOf(pageChanged, true)).not.toBe(
      pageTranslationSigOf(DEFAULT_SETTINGS, true),
    )
    expect(lensTranslationSigOf(pageChanged, true)).toBe(
      lensTranslationSigOf(DEFAULT_SETTINGS, true),
    )
  })
})
