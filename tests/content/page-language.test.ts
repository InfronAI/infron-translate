import { describe, expect, it } from 'vitest'
import {
  detectPageSourceLanguage,
  isLikelyEnglishText,
  isLikelySourceLanguage,
} from '../../src/content/page-language'

describe('page language detection', () => {
  function doc(lang: string, text: string): Document {
    return {
      documentElement: { lang },
      querySelector: () => null,
      body: { innerText: text, textContent: text },
    } as unknown as Document
  }

  it('trusts a declared BCP 47 language before text heuristics', () => {
    expect(isLikelySourceLanguage('en', 'en-US', '短中文')).toBe(true)
    expect(isLikelySourceLanguage('en', 'zh-CN', 'This page is written in English.')).toBe(false)
  })

  it('recognizes an English prose sample without a declared language', () => {
    const text =
      'The browser can translate this page on the device, and the original text will remain visible for people who want to compare both languages.'
    expect(isLikelyEnglishText(text)).toBe(true)
    expect(isLikelySourceLanguage('en', '', text)).toBe(true)
  })

  it('rejects short labels and non-English prose', () => {
    expect(isLikelyEnglishText('Home Explore Profile')).toBe(false)
    expect(
      isLikelyEnglishText('这是一个用于验证页面语言检测逻辑的中文段落，不应该被判断为英文页面。'),
    ).toBe(false)
  })

  it('detects declared page language', () => {
    expect(
      detectPageSourceLanguage(
        doc('fr-FR', 'This visible text should not override the declared language.'),
      ),
    ).toBe('fr')
  })

  it('detects common page scripts and falls back to auto', () => {
    expect(
      detectPageSourceLanguage(
        doc('', '这是一个用于验证页面语言自动检测逻辑的中文段落。'.repeat(4)),
      ),
    ).toBe('zh')

    expect(detectPageSourceLanguage(doc('', 'Home Explore Profile'))).toBe('auto')
  })
})
