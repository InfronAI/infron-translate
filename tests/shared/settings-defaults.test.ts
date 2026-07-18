import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  isConfigured,
  missingConfigFields,
  apiBaseUrlError,
} from '../../src/shared/settings-defaults'

describe('DEFAULT_SETTINGS', () => {
  it('defaults to cn full-page translation with automatic page mode off', () => {
    expect(DEFAULT_SETTINGS.sourceLang).toBe('auto')
    expect(DEFAULT_SETTINGS.targetLang).toBe('cn')
    expect(DEFAULT_SETTINGS.pageTranslationEngine).toBe('browser')
    expect(DEFAULT_SETTINGS.translationDisplayMode).toBe('bilingual')
    expect(DEFAULT_SETTINGS.autoPageTranslation).toBe(false)
    expect(DEFAULT_SETTINGS.pageTranslationFontSizePx).toBe(14)
    expect(DEFAULT_SETTINGS.pageTranslationUseCustomColor).toBe(false)
    expect(DEFAULT_SETTINGS.pageTranslationUseBackground).toBe(false)
    expect(DEFAULT_SETTINGS.minTextLength).toBe(10)
    expect(DEFAULT_SETTINGS.batchCharLimit).toBe(6000)
    expect(DEFAULT_SETTINGS.pausedHostnames).toEqual([])
  })
})

describe('mergeSettings', () => {
  it('fills missing fields from defaults', () => {
    const merged = mergeSettings({ apiKey: 'sk-test' })
    expect(merged.apiKey).toBe('sk-test')
    expect(merged.pageTranslationEngine).toBe('browser')
    expect(merged.translationDisplayMode).toBe('bilingual')
    expect(merged.autoPageTranslation).toBe(false)
    expect(merged.sourceLang).toBe('auto')
    expect(merged.pageTranslationFontSizePx).toBe(14)
    expect(merged.model).toBe(DEFAULT_SETTINGS.model)
  })

  it('preserves pausedHostnames when provided', () => {
    const merged = mergeSettings({ pausedHostnames: ['example.com'] })
    expect(merged.pausedHostnames).toEqual(['example.com'])
  })

  it('accepts only known full-page translation engines from storage', () => {
    expect(mergeSettings({ pageTranslationEngine: 'external' }).pageTranslationEngine).toBe(
      'external',
    )
    expect(mergeSettings({ pageTranslationEngine: 'browser' }).pageTranslationEngine).toBe(
      'browser',
    )
    expect(mergeSettings({ pageTranslationEngine: 'fallback' }).pageTranslationEngine).toBe(
      'browser',
    )
  })

  it('accepts only known translation display modes from storage', () => {
    expect(mergeSettings({ translationDisplayMode: 'bilingual' }).translationDisplayMode).toBe(
      'bilingual',
    )
    expect(
      mergeSettings({ translationDisplayMode: 'translation-only' }).translationDisplayMode,
    ).toBe('translation-only')
    expect(mergeSettings({ translationDisplayMode: 'hidden' }).translationDisplayMode).toBe(
      'bilingual',
    )
  })

  it('validates the global automatic full-page setting', () => {
    expect(mergeSettings({ autoPageTranslation: true }).autoPageTranslation).toBe(true)
    expect(mergeSettings({ autoPageTranslation: 'yes' }).autoPageTranslation).toBe(false)
  })

  it('coerces non-string fields from storage', () => {
    const merged = mergeSettings({
      baseURL: 123 as unknown as string,
      apiKey: null as unknown as string,
      model: undefined,
    })
    expect(merged.baseURL).toBe('123')
    expect(merged.apiKey).toBe('')
    expect(merged.model).toBe(DEFAULT_SETTINGS.model)
  })

  it('preserves a manual source language from storage', () => {
    expect(mergeSettings({ sourceLang: 'ja' }).sourceLang).toBe('ja')
  })

  it('migrates legacy zh language settings to cn', () => {
    const merged = mergeSettings({ sourceLang: 'zh', targetLang: 'zh' })
    expect(merged.sourceLang).toBe('cn')
    expect(merged.targetLang).toBe('cn')
  })

  it('validates full-page translation appearance settings', () => {
    const merged = mergeSettings({
      pageTranslationFontSizePx: 100,
      pageTranslationTextColor: 'red',
      pageTranslationBackgroundColor: '#123456',
      pageTranslationBold: true,
      pageTranslationItalic: true,
      pageTranslationUnderline: true,
    })
    expect(merged.pageTranslationFontSizePx).toBe(32)
    expect(merged.pageTranslationTextColor).toBe(DEFAULT_SETTINGS.pageTranslationTextColor)
    expect(merged.pageTranslationBackgroundColor).toBe('#123456')
    expect(merged.pageTranslationBold).toBe(true)
    expect(merged.pageTranslationItalic).toBe(true)
    expect(merged.pageTranslationUnderline).toBe(true)
  })
})

describe('isConfigured', () => {
  it('requires baseURL, apiKey, and model', () => {
    expect(isConfigured(DEFAULT_SETTINGS)).toBe(false)
    expect(
      isConfigured({
        ...DEFAULT_SETTINGS,
        apiKey: 'sk-x',
      }),
    ).toBe(true)
    expect(missingConfigFields(DEFAULT_SETTINGS)).toContain('API Key')
  })
})

describe('apiBaseUrlError', () => {
  it('requires TLS for remote endpoints and permits loopback HTTP', () => {
    expect(apiBaseUrlError('https://api.example.com/v1')).toBeNull()
    expect(apiBaseUrlError('http://localhost:11434/v1')).toBeNull()
    expect(apiBaseUrlError('http://127.0.0.1:8080/v1')).toBeNull()
    expect(apiBaseUrlError('http://api.example.com/v1')).toBe('远程 Base URL 必须使用 HTTPS')
    expect(apiBaseUrlError('not a url')).toBe('Base URL 格式无效')
  })
})
