import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  groupPageBlocks,
  isPageTranslationCandidate,
  isPageUiTranslationCandidate,
  PageTranslator,
  pageTranslationHost,
} from '../../src/content/page-translator'
import type { ExtractedBlock } from '../../src/content/extract'

function block(id: string, text: string, top: number, order: number): ExtractedBlock {
  const el = {
    isConnected: true,
    getBoundingClientRect: () => ({
      width: 400,
      height: 30,
      top,
      left: 0,
      bottom: top + 30,
      right: 400,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }),
    compareDocumentPosition: (other: Element) =>
      order < (other as Element & { __order: number }).__order ? 4 : 2,
    __order: order,
  } as unknown as Element
  return { id, text, tag: 'p', el }
}

function candidateElement(
  text: string,
  tagName = 'span',
  ancestors: Array<{ tagName: string; role?: string; text?: string }> = [],
): Element {
  const self: { tagName: string; role?: string; text?: string } = { tagName, text }
  const chain = [self, ...ancestors]
  return {
    tagName: tagName.toUpperCase(),
    textContent: text,
    children: [],
    querySelectorAll: () => [],
    getAttribute: (name: string) => (name === 'role' ? null : null),
    closest: (selector: string) => {
      for (const item of chain) {
        const matches = selector.split(',').some((part) => {
          const value = part.trim()
          if (value === item.tagName) return true
          const role = value.match(/^\[role="(.+)"\]$/)?.[1]
          return role !== undefined && role === item.role
        })
        if (matches) return { textContent: item.text ?? text }
      }
      return null
    },
  } as unknown as Element
}

afterEach(() => vi.unstubAllGlobals())

class MockStyle {
  height = ''
  maxHeight = ''
  minHeight = ''
  overflow = ''
  overflowX = ''
  overflowY = ''
  contain = ''
  private readonly values = new Map<string, string>()

  setProperty(name: string, value: string): void {
    this.values.set(name, value)
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? ''
  }

  removeProperty(name: string): void {
    this.values.delete(name)
  }
}

class MockElement {
  tagName: string
  textContent: string
  isConnected = true
  parentElement: MockElement | null = null
  children: MockElement[] = []
  childNodes: unknown[] = []
  style = new MockStyle()
  attrs = new Map<string, string>()
  computed = {
    display: 'block',
    position: 'static',
    overflow: 'visible',
    overflowX: 'visible',
    overflowY: 'visible',
    height: 'auto',
    maxHeight: 'none',
    visibility: 'visible',
    opacity: '1',
  }
  clientHeight = 100
  scrollHeight = 100
  clientWidth = 300
  scrollWidth = 300

  constructor(tagName: string, text = '') {
    this.tagName = tagName.toUpperCase()
    this.textContent = text
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  closest(selector: string): MockElement | null {
    for (let node: MockElement | null = this; node; node = node.parentElement) {
      if (selector.split(',').some((part) => node?.matches(part.trim()))) return node
    }
    return null
  }

  matches(selector: string): boolean {
    if (selector === 'button') return this.tagName === 'BUTTON'
    if (selector === '[role="button"]') return this.getAttribute('role') === 'button'
    if (selector === '[data-infron-ignore]') return this.hasAttribute('data-infron-ignore')
    return false
  }

  querySelectorAll(): MockElement[] {
    return this.children
  }
}

function append(parent: MockElement, child: MockElement): void {
  child.parentElement = parent
  parent.children.push(child)
}

function setupMockDom(): void {
  const html = new MockElement('html')
  const body = new MockElement('body')
  append(html, body)
  vi.stubGlobal('HTMLElement', MockElement)
  vi.stubGlobal('document', {
    documentElement: html,
    body,
    getElementById: () => null,
  })
  vi.stubGlobal('window', {
    clearTimeout: () => undefined,
    setTimeout: () => 0,
    getComputedStyle: (el: MockElement) => el.computed,
  })
}

const pageSettings = {
  targetLang: 'zh-CN',
  sourceLang: 'auto',
  pageTranslationEngine: 'browser',
  translationDisplayMode: 'bilingual',
  pageTranslationFontSizePx: 13,
  pageTranslationUseCustomColor: false,
  pageTranslationTextColor: '#111111',
  pageTranslationUseBackground: false,
  pageTranslationBackgroundColor: '#ffffff',
  pageTranslationBold: false,
  pageTranslationItalic: false,
  pageTranslationUnderline: false,
  batchCharLimit: 4000,
  minTextLength: 10,
} as const

describe('groupPageBlocks', () => {
  it('prioritizes visible text and deduplicates repeated content', () => {
    vi.stubGlobal('window', {
      innerHeight: 800,
      innerWidth: 1200,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    })
    const offscreenDuplicate = block('offscreen', 'Repeated paragraph', 4000, 0)
    const visibleDuplicate = block('visible', 'Repeated paragraph', 100, 1)
    const visibleOther = block('other', 'Another visible paragraph', 200, 2)

    const groups = groupPageBlocks([offscreenDuplicate, visibleOther, visibleDuplicate])

    expect(groups.map((group) => group.representative.id)).toEqual(['visible', 'other'])
    expect(groups[0].blocks.map((item) => item.id)).toEqual(['visible', 'offscreen'])
  })
})

describe('isPageTranslationCandidate', () => {
  it('keeps navigation and controls as compact UI translations', () => {
    const candidates = [
      { id: 'nav', text: 'Explore topics', tagName: 'span', ancestors: [{ tagName: 'nav' }] },
      { id: 'button', text: 'Show more results', tagName: 'span', ancestors: [{ tagName: 'button' }] },
      { id: 'link', text: 'Features overview', tagName: 'a', ancestors: [] },
    ]

    for (const { id, text, tagName, ancestors } of candidates) {
      const candidate = {
        id,
        el: candidateElement(text, tagName, ancestors),
        tag: tagName,
        text,
      }
      expect(isPageTranslationCandidate(candidate, 10)).toBe(true)
      expect(isPageUiTranslationCandidate(candidate)).toBe(true)
    }
  })

  it('rejects metadata links and time labels', () => {
    const candidates = [
      { id: 'handle', text: '@example_user', ancestors: [{ tagName: 'a' }] },
      { id: 'account', text: 'Example @example_user', ancestors: [{ tagName: 'a' }] },
      { id: 'time', text: 'Yesterday morning', ancestors: [{ tagName: 'time' }] },
    ]

    for (const { id, text, ancestors } of candidates) {
      const candidate = {
        id,
        el: candidateElement(text, 'span', ancestors),
        tag: 'span',
        text,
      }
      expect(isPageTranslationCandidate(candidate, 2)).toBe(false)
    }
  })

  it('skips grid/chart widgets and bare date-axis labels that break layout', () => {
    const gridLabels = [
      { id: 'month', text: 'Jul', ancestors: [{ tagName: 'td' }, { tagName: 'table', role: 'grid' }] },
      { id: 'weekday', text: 'Mon', ancestors: [{ tagName: 'td' }, { tagName: 'table', role: 'grid' }] },
    ]
    for (const { id, text, ancestors } of gridLabels) {
      const candidate = { id, el: candidateElement(text, 'span', ancestors), tag: 'span', text }
      expect(isPageTranslationCandidate(candidate, 2)).toBe(false)
    }

    // Even outside a grid, a standalone month/weekday token adds no value and risks layout.
    for (const text of ['August', 'Sunday', 'Sep', 'May']) {
      const candidate = { id: text, el: candidateElement(text, 'span'), tag: 'span', text }
      expect(isPageTranslationCandidate(candidate, 2)).toBe(false)
    }
  })

  it('places UI translation on the inner text label instead of the flex link', () => {
    const label = candidateElement('Home', 'span')
    const link = candidateElement('Home', 'a')
    link.querySelectorAll = (() => [label]) as unknown as typeof link.querySelectorAll
    const candidate = { id: 'home', el: link, tag: 'a', text: 'Home' }

    expect(pageTranslationHost(candidate)).toBe(label)
  })

  it('keeps prose, including prose with an inline link', () => {
    const text = 'A useful explanation with supporting documentation.'
    const candidate = { id: 'post', el: candidateElement(text, 'p'), tag: 'p', text }

    expect(isPageTranslationCandidate(candidate, 10)).toBe(true)
  })
})

describe('PageTranslator bilingual overflow handling', () => {
  it('expands clipped containers for bilingual content and restores them on deactivate', () => {
    setupMockDom()
    const container = new MockElement('div')
    container.computed = {
      ...container.computed,
      overflow: 'hidden',
      overflowY: 'hidden',
      height: '80px',
    }
    container.clientHeight = 80
    container.scrollHeight = 148
    container.style.height = '80px'
    container.style.overflow = 'hidden'
    const host = new MockElement('p', 'Original content that should be translated.')
    append(container, host)
    append(document.body as unknown as MockElement, container)

    const translator = new PageTranslator({} as never)
    ;(translator as unknown as {
      renderGroup: (
        group: { representative: { id: string; tag: string; text: string }; blocks: ExtractedBlock[] },
        translation: string,
        settings: typeof pageSettings,
      ) => void
    }).renderGroup(
      {
        representative: { id: 'a', tag: 'p', text: host.textContent },
        blocks: [{ id: 'a', tag: 'p', text: host.textContent, el: host as unknown as Element }],
      },
      'Translated content that adds another readable line.',
      pageSettings,
    )

    expect(container.hasAttribute('data-infron-page-expanded-container')).toBe(true)
    expect(container.style.height).toBe('auto')
    expect(container.style.maxHeight).toBe('none')
    expect(container.style.overflow).toBe('visible')
    expect(container.style.getPropertyValue('--infron-translate-expanded-min-height')).toBe('148px')

    translator.deactivate()

    expect(container.hasAttribute('data-infron-page-expanded-container')).toBe(false)
    expect(container.style.height).toBe('80px')
    expect(container.style.overflow).toBe('hidden')
    expect(container.style.getPropertyValue('--infron-translate-expanded-min-height')).toBe('')
  })

  it('does not resize containers when bilingual content still fits', () => {
    setupMockDom()
    const container = new MockElement('div')
    container.computed = {
      ...container.computed,
      overflow: 'hidden',
      overflowY: 'hidden',
      height: '120px',
    }
    container.clientHeight = 120
    container.scrollHeight = 120
    const host = new MockElement('p', 'Original content that should be translated.')
    append(container, host)
    append(document.body as unknown as MockElement, container)

    const translator = new PageTranslator({} as never)
    ;(translator as unknown as {
      renderGroup: (
        group: { representative: { id: string; tag: string; text: string }; blocks: ExtractedBlock[] },
        translation: string,
        settings: typeof pageSettings,
      ) => void
    }).renderGroup(
      {
        representative: { id: 'a', tag: 'p', text: host.textContent },
        blocks: [{ id: 'a', tag: 'p', text: host.textContent, el: host as unknown as Element }],
      },
      'Translated content.',
      pageSettings,
    )

    expect(container.hasAttribute('data-infron-page-expanded-container')).toBe(false)
    expect(container.style.height).toBe('')
    expect(container.style.overflow).toBe('')
  })
})
