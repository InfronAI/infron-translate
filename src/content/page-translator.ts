import { splitIntoBatches } from '../shared/batch'
import type {
  TranslateBatchResultErr,
  TranslateBatchResultOk,
  TranslateBlock,
} from '../shared/messages'
import type { UserSettings } from '../shared/settings-defaults'
import { isPageTranslatableText, normalizeText } from '../shared/text'
import {
  collectPageRoots,
  elementText,
  extractPageBlocks,
  isUiLabelElement,
  isVisible,
  PAGE_SOURCE_ATTR,
  type ExtractedBlock,
} from './extract'
import { makePageKey } from './page-key'
import { BrowserTranslator } from './browser-translator'
import {
  PAGE_ALIGNMENT_FALLBACK_ATTR,
  PAGE_ALIGNMENT_HIGHLIGHT_NAME,
  PageAlignmentController,
} from './page-alignment'

const TRANSLATED_ATTR = 'data-lens-page-translated'
const TRANSLATION_TEXT_ATTR = 'data-lens-page-translation-text'
const UI_TRANSLATION_ATTR = 'data-lens-page-ui-translation'
const UI_STACKED_TRANSLATION_ATTR = 'data-lens-page-ui-stacked-translation'
const UI_CONTROL_TRANSLATION_ATTR = 'data-lens-page-ui-control-translation'
const STYLE_ID = 'infron-translate-page-style'
const STATUS_ID = 'infron-translate-page-status'

// A translated host that keeps mutating (clocks, counters, live chat) would loop
// forever between invalidate and re-translate. After this many re-invalidations
// within the window we give up on it and leave the original text in place.
const VOLATILE_CHURN_LIMIT = 3
const VOLATILE_CHURN_WINDOW_MS = 5000

// How many translate-batch requests may be in flight at once for one full-page
// run. Each maps to a separate background fetch, so this is real HTTP parallelism
// while staying low enough to avoid provider rate limits.
const PAGE_TRANSLATION_CONCURRENCY = 4

// When translation starts before dynamic content has rendered (SPA hydration,
// async data), keep observing and retrying the initial scan for this long before
// declaring the page empty, instead of failing on the first blank scan.
const INITIAL_CONTENT_GRACE_MS = 8000
const INITIAL_RETRY_INTERVAL_MS = 600

type ChurnRecord = { count: number; since: number }

function pageStyles(settings: PageSettings): string {
  const color = settings.pageTranslationUseCustomColor
    ? settings.pageTranslationTextColor
    : 'inherit'
  const background = settings.pageTranslationUseBackground
    ? settings.pageTranslationBackgroundColor
    : 'transparent'
  const padding = settings.pageTranslationUseBackground ? '0.3em 0.5em' : '0'
  const radius = settings.pageTranslationUseBackground ? '4px' : '0'
  const opacity =
    settings.pageTranslationUseCustomColor || settings.pageTranslationUseBackground ? '1' : '0.78'

  return `
[${TRANSLATED_ATTR}]::after {
  content: attr(${TRANSLATION_TEXT_ATTR}) !important;
  display: block !important;
  box-sizing: border-box !important;
  margin: 0.24em 0 0.1em !important;
  padding: ${padding} !important;
  border: 0 !important;
  border-radius: ${radius} !important;
  background: ${background} !important;
  color: ${color} !important;
  font-family: inherit !important;
  font-size: ${settings.pageTranslationFontSizePx}px !important;
  font-style: ${settings.pageTranslationItalic ? 'italic' : 'normal'} !important;
  font-weight: ${settings.pageTranslationBold ? '700' : '400'} !important;
  line-height: 1.45 !important;
  letter-spacing: 0 !important;
  overflow-wrap: anywhere !important;
  text-align: start !important;
  text-decoration: ${settings.pageTranslationUnderline ? 'underline' : 'none'} !important;
  text-transform: none !important;
  unicode-bidi: plaintext !important;
  white-space: pre-wrap !important;
  opacity: ${opacity} !important;
}

[${TRANSLATED_ATTR}][${UI_TRANSLATION_ATTR}]::after {
  content: " · " attr(${TRANSLATION_TEXT_ATTR}) !important;
  display: inline-block !important;
  vertical-align: baseline !important;
  margin: 0 0 0 0.32em !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  color: inherit !important;
  font-size: 0.68em !important;
  font-style: normal !important;
  font-weight: 400 !important;
  line-height: inherit !important;
  text-decoration: none !important;
  white-space: normal !important;
  opacity: 0.62 !important;
}

[${TRANSLATED_ATTR}][${UI_TRANSLATION_ATTR}][${UI_STACKED_TRANSLATION_ATTR}]::after {
  content: attr(${TRANSLATION_TEXT_ATTR}) !important;
  display: block !important;
  margin: 0.12em 0 0 !important;
  font-size: 0.58em !important;
  line-height: 1.15 !important;
  white-space: normal !important;
}

[${TRANSLATED_ATTR}][${UI_TRANSLATION_ATTR}][${UI_CONTROL_TRANSLATION_ATTR}]::after {
  content: " · " attr(${TRANSLATION_TEXT_ATTR}) !important;
  display: inline-block !important;
  vertical-align: baseline !important;
  margin-left: 0.3em !important;
  font-size: 0.7em !important;
  line-height: inherit !important;
  white-space: nowrap !important;
}

::highlight(${PAGE_ALIGNMENT_HIGHLIGHT_NAME}) {
  background: rgb(250 204 21 / 52%);
  color: inherit;
  text-decoration: underline;
  text-decoration-color: rgb(202 138 4 / 80%);
  text-decoration-thickness: 2px;
}

[${PAGE_ALIGNMENT_FALLBACK_ATTR}] {
  background-color: rgb(250 204 21 / 22%) !important;
}

#${STATUS_ID} {
  position: fixed !important;
  z-index: 2147483647 !important;
  top: 16px !important;
  right: 16px !important;
  max-width: min(360px, calc(100vw - 32px)) !important;
  padding: 9px 12px !important;
  border: 1px solid rgb(15 23 42 / 14%) !important;
  border-radius: 7px !important;
  background: rgb(255 255 255 / 96%) !important;
  box-shadow: 0 8px 24px rgb(15 23 42 / 16%) !important;
  color: #172033 !important;
  font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif !important;
  letter-spacing: 0 !important;
}

#${STATUS_ID}[data-error="true"] {
  border-color: rgb(185 28 28 / 24%) !important;
  color: #991b1b !important;
}

@media (prefers-color-scheme: dark) {
  #${STATUS_ID} {
    border-color: rgb(255 255 255 / 16%) !important;
    background: rgb(24 24 27 / 96%) !important;
    color: #f4f4f5 !important;
  }
  #${STATUS_ID}[data-error="true"] { color: #fca5a5 !important; }
}
`
}

type PageSettings = Pick<
  UserSettings,
  | 'sourceLang'
  | 'targetLang'
  | 'pageTranslationEngine'
  | 'pageTranslationFontSizePx'
  | 'pageTranslationUseCustomColor'
  | 'pageTranslationTextColor'
  | 'pageTranslationUseBackground'
  | 'pageTranslationBackgroundColor'
  | 'pageTranslationBold'
  | 'pageTranslationItalic'
  | 'pageTranslationUnderline'
  | 'batchCharLimit'
  | 'minTextLength'
>

type TranslationGroup = {
  representative: TranslateBlock
  blocks: ExtractedBlock[]
}

function isTranslationRow(value: unknown): value is { id: string; translation: string } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'id' in value &&
      typeof value.id === 'string' &&
      'translation' in value &&
      typeof value.translation === 'string',
  )
}

function isTranslateBatchResult(
  value: unknown,
): value is TranslateBatchResultOk | TranslateBatchResultErr {
  if (!value || typeof value !== 'object' || !('type' in value) || !('ok' in value)) return false
  if (value.type !== 'translate-batch-result' || typeof value.ok !== 'boolean') return false
  if (
    'translations' in value &&
    value.translations !== undefined &&
    (!Array.isArray(value.translations) || !value.translations.every(isTranslationRow))
  ) {
    return false
  }
  return value.ok
    ? 'translations' in value && Array.isArray(value.translations)
    : 'error' in value && typeof value.error === 'string'
}

/** Visible blocks first, then DOM order; repeated text shares one translation operation. */
export function groupPageBlocks(blocks: ExtractedBlock[]): TranslationGroup[] {
  const inDocumentOrder = [...blocks].sort((a, b) => {
    if (a.el === b.el) return 0
    const position = a.el.compareDocumentPosition(b.el)
    return position & 4 ? -1 : 1
  })
  const visible: ExtractedBlock[] = []
  const offscreen: ExtractedBlock[] = []
  for (const block of inDocumentOrder) {
    if (isVisible(block.el, 0)) visible.push(block)
    else offscreen.push(block)
  }
  const ordered = [...visible, ...offscreen]
  const groups = new Map<string, TranslationGroup>()

  for (const block of ordered) {
    const text = normalizeText(block.text)
    const existing = groups.get(text)
    if (existing) {
      existing.blocks.push(block)
      continue
    }
    groups.set(text, {
      representative: { id: block.id, tag: block.tag, text },
      blocks: [block],
    })
  }
  return [...groups.values()]
}

const PAGE_UI_CHROME_SELECTOR =
  'nav, [role="navigation"], [role="banner"], [role="menu"], [role="tablist"], [role="search"], [role="toolbar"]'
const PAGE_CONTROL_SELECTOR =
  'button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"]'

/**
 * Interactive grid/chart widgets (calendars, heatmaps, spreadsheets) pack short labels into
 * fixed-size cells. Appending an inline translation there overflows the cell and breaks the
 * layout (e.g. the GitHub contribution graph), so full-page mode leaves their text untouched.
 * This also covers the graph *legend* ("Less [][][][] More"), whose level swatches live outside
 * the grid and would otherwise get "没低中高" crammed on top of each tiny square.
 */
const PAGE_LAYOUT_LOCKED_SELECTOR =
  '[role="grid"], [role="treegrid"], [class*="ContributionCalendar"], .js-calendar-graph, .contrib-legend, [class*="ContributionCalendar"] [data-level], .js-calendar-graph [data-level]'

/** Month / weekday axis tokens: near-zero translation value, high layout risk in charts & calendars. */
const DATE_AXIS_LABEL_RE =
  /^(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)$/i

function isDateAxisLabel(text: string): boolean {
  return DATE_AXIS_LABEL_RE.test(normalizeText(text))
}

export function isPageUiTranslationCandidate(block: ExtractedBlock): boolean {
  return Boolean(
    isUiLabelElement(block.el) ||
      block.el.closest(PAGE_UI_CHROME_SELECTOR) ||
      block.el.closest(PAGE_CONTROL_SELECTOR),
  )
}

function isButtonLikeUi(block: ExtractedBlock): boolean {
  if (block.el.closest('button, [role="button"]')) return true
  const marker = `${block.el.getAttribute('class') ?? ''} ${block.el.getAttribute('data-testid') ?? ''}`
  return /(?:^|[\s_-])(?:button|btn|submit)(?:$|[\s_-])/iu.test(marker)
}

/** Attach generated UI copy to the text label instead of the outer flex control. */
export function pageTranslationHost(block: ExtractedBlock): Element {
  if (!isPageUiTranslationCandidate(block)) return block.el
  const text = normalizeText(block.text)
  let host = block.el
  for (const candidate of block.el.querySelectorAll('*')) {
    const tag = candidate.tagName.toLowerCase()
    if (tag === 'svg' || tag === 'path' || tag === 'img') continue
    if (normalizeText(elementText(candidate)) === text) host = candidate
  }
  return host
}

/** Full-page mode favors reading content over site chrome and compact metadata. */
export function isPageTranslationCandidate(
  block: ExtractedBlock,
  minTextLength: number,
): boolean {
  const { el, text } = block
  if (el.closest('time')) return false
  // Data-visualization widgets and bare date-axis labels break layout or add no value.
  if (el.closest(PAGE_LAYOUT_LOCKED_SELECTOR)) return false
  if (isDateAxisLabel(text)) return false
  const isUi = isPageUiTranslationCandidate(block)
  if (isUi && /@[\p{L}\p{N}_-]+/u.test(text)) return false
  if (!isPageTranslatableText(text, isUi ? Math.min(2, minTextLength) : minTextLength)) {
    return false
  }
  if (isUi) return true
  if (isUiLabelElement(el)) return false

  const link = el.closest('a, [role="link"]')
  if (link && text.length <= 48 && normalizeText(elementText(link)) === normalizeText(text)) {
    return false
  }
  return true
}

/** Owns one reversible full-page bilingual translation run. */
export class PageTranslator {
  private active = false
  private generation = 0
  private statusTimer = 0
  private mutationTimer = 0
  private initialRetryTimer = 0
  private activationDeadline = 0
  private processingGeneration = 0
  private rescanRequested = false
  private observer: MutationObserver | null = null
  private observedRoots = new WeakSet<Node>()
  private currentSettings: PageSettings | null = null
  private readonly dirtyRoots = new Set<ParentNode>()
  private readonly translatedHosts = new Set<Element>()
  private readonly sourceHosts = new Map<Element, string | null>()
  private attemptedTextByHost = new WeakMap<Element, string>()
  private sourceBlockByHost = new WeakMap<Element, Element>()
  private volatileHosts = new WeakSet<Element>()
  private hostChurn = new WeakMap<Element, ChurnRecord>()
  private readonly translationCache = new Map<string, string>()
  private processedCount = 0
  private translatedCount = 0
  private totalCount = 0
  private readonly alignment = new PageAlignmentController()

  constructor(private readonly browserTranslator: BrowserTranslator) {}

  isActive(): boolean {
    return this.active
  }

  async toggle(settings: PageSettings, externalConfigured: boolean): Promise<void> {
    if (this.active) {
      this.deactivate()
      return
    }
    await this.activate(settings, externalConfigured)
  }

  deactivate(): void {
    this.active = false
    this.generation++
    this.observer?.disconnect()
    this.observer = null
    this.alignment.deactivate()
    this.observedRoots = new WeakSet<Node>()
    window.clearTimeout(this.statusTimer)
    window.clearTimeout(this.mutationTimer)
    window.clearTimeout(this.initialRetryTimer)
    for (const host of this.translatedHosts) {
      host.removeAttribute(TRANSLATED_ATTR)
      host.removeAttribute(TRANSLATION_TEXT_ATTR)
      host.removeAttribute(UI_TRANSLATION_ATTR)
      host.removeAttribute(UI_STACKED_TRANSLATION_ATTR)
      host.removeAttribute(UI_CONTROL_TRANSLATION_ATTR)
    }
    for (const [host, previous] of this.sourceHosts) {
      if (previous === null) host.removeAttribute(PAGE_SOURCE_ATTR)
      else host.setAttribute(PAGE_SOURCE_ATTR, previous)
    }
    this.translatedHosts.clear()
    this.sourceHosts.clear()
    this.attemptedTextByHost = new WeakMap<Element, string>()
    this.sourceBlockByHost = new WeakMap<Element, Element>()
    this.volatileHosts = new WeakSet<Element>()
    this.hostChurn = new WeakMap<Element, ChurnRecord>()
    this.translationCache.clear()
    this.dirtyRoots.clear()
    this.currentSettings = null
    this.processingGeneration = 0
    this.rescanRequested = false
    document.getElementById(STATUS_ID)?.remove()
    document.getElementById(STYLE_ID)?.remove()
  }

  /**
   * Re-apply appearance-only settings (font size, colors, weight…) without
   * tearing down the active translation. Injected CSS uses `content: attr(...)`,
   * so re-writing the stylesheet restyles every rendered translation in place.
   */
  restyle(settings: PageSettings): void {
    if (!this.active) return
    this.currentSettings = settings
    this.ensureStyles(settings)
  }

  async activate(settings: PageSettings, externalConfigured: boolean): Promise<void> {
    window.clearTimeout(this.statusTimer)
    this.active = true
    const generation = ++this.generation
    this.currentSettings = settings
    this.ensureStyles(settings)

    if (settings.pageTranslationEngine === 'external' && !externalConfigured) {
      this.failActivation('整页翻译需要先配置外部 API')
      return
    }
    if (settings.pageTranslationEngine === 'browser' && !this.browserTranslator.isSupported()) {
      this.failActivation('当前浏览器不支持 Chrome 内置翻译')
      return
    }

    this.alignment.activate()
    this.startObserving()
    this.activationDeadline = Date.now() + INITIAL_CONTENT_GRACE_MS
    await this.scanAndTranslate(settings, generation, true)
  }

  private async scanAndTranslate(
    settings: PageSettings,
    generation: number,
    initial = false,
  ): Promise<void> {
    if (!this.isCurrent(generation)) return
    if (this.processingGeneration === generation) {
      this.rescanRequested = true
      return
    }
    if (this.processingGeneration !== 0) return
    this.processingGeneration = generation
    window.clearTimeout(this.statusTimer)

    try {
      const scanRoots = initial ? [document] : [...this.dirtyRoots]
      this.dirtyRoots.clear()
      this.observePageRoots(scanRoots)
      this.cleanupDisconnectedHosts()
      if (initial) this.showStatus('正在分析页面文本…')

      const blocksByElement = new Map<Element, ExtractedBlock>()
      for (const root of scanRoots) {
        if (root !== document && root instanceof Node && !root.isConnected) continue
        for (const block of extractPageBlocks(settings.minTextLength, root)) {
          blocksByElement.set(block.el, block)
        }
      }
      const blocks = [...blocksByElement.values()].filter((block) => {
        if (this.volatileHosts.has(block.el)) return false
        if (!isPageTranslationCandidate(block, settings.minTextLength)) return false
        if (this.translatedHosts.has(block.el)) return false
        return this.attemptedTextByHost.get(block.el) !== block.text
      })
      const groups = groupPageBlocks(blocks)
      this.totalCount = groups.reduce((total, group) => total + group.blocks.length, 0)
      this.processedCount = 0
      this.translatedCount = 0

      if (!groups.length) {
        if (initial && this.translatedHosts.size === 0) {
          // Content may not have rendered yet. Keep the observer running (so late
          // content is picked up immediately) and retry the initial scan until the
          // grace window elapses, only then declaring the page empty.
          if (Date.now() < this.activationDeadline) {
            this.showStatus('正在等待页面内容加载…')
            this.scheduleInitialRetry(generation)
          } else {
            this.failActivation('当前页面没有可翻译文本')
          }
        } else {
          document.getElementById(STATUS_ID)?.remove()
        }
        return
      }
      if (!initial) this.showStatus('检测到新内容，正在翻译…')
      for (const group of groups) {
        for (const block of group.blocks) {
          this.attemptedTextByHost.set(block.el, block.text)
        }
      }
      this.updateProgress()

      const unresolved: TranslationGroup[] = []
      for (const group of groups) {
        const cached = this.translationCache.get(group.representative.text)
        if (cached) {
          this.renderGroup(group, cached, settings)
          this.processedCount += group.blocks.length
        } else {
          unresolved.push(group)
        }
      }
      this.updateProgress()

      if (unresolved.length) {
        if (settings.pageTranslationEngine === 'browser') {
          await this.translateWithBrowser(unresolved, settings, generation)
        } else {
          await this.translateWithExternal(unresolved, settings, generation)
        }
      }
      if (!this.isCurrent(generation)) return

      if (initial && this.translatedCount === 0 && this.translatedHosts.size === 0) {
        this.failActivation('整页翻译失败，当前语言对可能不可用')
        return
      }
      const failed = this.totalCount - this.translatedCount
      this.showStatus(
        failed > 0
          ? `翻译完成：${this.translatedCount} 段成功，${failed} 段失败`
          : `翻译完成：${this.translatedCount} 段`,
        failed > 0,
      )
      this.scheduleStatusRemoval()
    } catch (error) {
      if (!this.isCurrent(generation)) return
      const message = error instanceof Error ? error.message : String(error)
      if (initial && this.translatedHosts.size === 0) this.failActivation(message)
      else {
        this.showStatus(`整页翻译部分失败：${message}`, true)
        this.scheduleStatusRemoval(5000)
      }
    } finally {
      if (this.processingGeneration !== generation) return
      this.processingGeneration = 0
      if (this.rescanRequested && this.isCurrent(generation)) {
        this.rescanRequested = false
        this.scheduleScan(0)
      }
    }
  }

  private async translateWithBrowser(
    groups: TranslationGroup[],
    settings: PageSettings,
    generation: number,
  ): Promise<void> {
    const ready = await this.browserTranslator.prepare(settings.sourceLang, settings.targetLang)
    if (!this.isCurrent(generation)) return
    if (!ready) throw new Error('Chrome 内置翻译不支持当前语言对')
    for (const group of groups) {
      if (!this.isCurrent(generation)) return
      const translation = await this.browserTranslator.translate(
        group.representative.text,
        settings.sourceLang,
        settings.targetLang,
      )
      if (!this.isCurrent(generation)) return
      if (translation) this.renderGroup(group, translation, settings)
      this.processedCount += group.blocks.length
      this.updateProgress()
    }
  }

  private async translateWithExternal(
    groups: TranslationGroup[],
    settings: PageSettings,
    generation: number,
  ): Promise<void> {
    const byRepresentativeId = new Map(groups.map((group) => [group.representative.id, group]))
    const batches = splitIntoBatches(
      groups.map((group) => group.representative),
      settings.batchCharLimit,
      30,
    )
    const pageKey = makePageKey()
    let firstError: string | null = null

    // Batches run concurrently (bounded) instead of one-at-a-time; every batch is
    // an independent request keyed by block id, so order does not matter.
    const runBatch = async (batch: TranslateBlock[]): Promise<void> => {
      if (!this.isCurrent(generation)) return
      try {
        const response: unknown = await chrome.runtime.sendMessage({
          type: 'translate-batch',
          pageKey,
          blocks: batch,
        })
        if (!this.isCurrent(generation)) return
        if (!isTranslateBatchResult(response)) throw new Error('翻译服务未返回有效结果')

        for (const item of response.translations ?? []) {
          const group = byRepresentativeId.get(item.id)
          if (group) {
            this.renderGroup(group, item.translation, settings)
          }
        }
        if (!response.ok) {
          if (firstError === null) firstError = response.error
        }
      } catch (error) {
        if (firstError === null) {
          firstError = error instanceof Error ? error.message : String(error)
        }
      }

      if (!this.isCurrent(generation)) return
      for (const block of batch) {
        const group = byRepresentativeId.get(block.id)
        if (group) this.processedCount += group.blocks.length
      }
      this.updateProgress()
    }

    await this.runWithConcurrency(batches, PAGE_TRANSLATION_CONCURRENCY, runBatch)
    if (!this.isCurrent(generation)) return
    // External and on-device engines are intentionally isolated; surface any remaining gap.
    if (firstError !== null && groups.some((g) => !this.translationCache.has(g.representative.text))) {
      throw new Error(firstError)
    }
  }

  /** Run `worker` over `items` with at most `limit` in flight; never rejects per item. */
  private async runWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    const queue = items.slice()
    const runNext = async (): Promise<void> => {
      const item = queue.shift()
      if (item === undefined) return
      await worker(item)
      await runNext()
    }
    const runners: Promise<void>[] = []
    for (let i = 0; i < Math.min(limit, items.length); i++) runners.push(runNext())
    await Promise.all(runners)
  }

  private renderGroup(group: TranslationGroup, translation: string, settings: PageSettings): void {
    this.translationCache.set(group.representative.text, translation)
    for (const block of group.blocks) {
      if (!block.el.isConnected) continue
      const isUi = isPageUiTranslationCandidate(block)
      const host = isUi ? pageTranslationHost(block) : block.el
      if (this.translatedHosts.has(host)) continue
      if (!this.sourceHosts.has(host)) {
        this.sourceHosts.set(host, host.getAttribute(PAGE_SOURCE_ATTR))
        host.setAttribute(PAGE_SOURCE_ATTR, block.text)
      }
      host.setAttribute(TRANSLATED_ATTR, '')
      host.setAttribute(TRANSLATION_TEXT_ATTR, translation)
      if (isUi) {
        host.setAttribute(UI_TRANSLATION_ATTR, '')
        if (isButtonLikeUi(block)) {
          host.setAttribute(UI_CONTROL_TRANSLATION_ATTR, '')
        } else {
          const display = window.getComputedStyle(host).display
          if (!display.includes('flex') && !display.includes('grid')) {
            host.setAttribute(UI_STACKED_TRANSLATION_ATTR, '')
          }
        }
      }
      this.translatedHosts.add(host)
      this.sourceBlockByHost.set(host, block.el)
      this.alignment.register(
        host,
        block.text,
        translation,
        settings.sourceLang,
        settings.targetLang,
        isPageUiTranslationCandidate(block),
      )
      this.translatedCount++
    }
  }

  private startObserving(): void {
    this.observer?.disconnect()
    this.observedRoots = new WeakSet<Node>()
    this.observer = new MutationObserver((records) => this.onMutations(records))
    this.observePageRoots([document])
  }

  private observePageRoots(scanRoots: ParentNode[]): void {
    if (!this.observer) return
    for (const scanRoot of scanRoots) {
      for (const root of collectPageRoots(scanRoot)) {
        const target = root === document ? document.documentElement : (root as Node)
        if (this.observedRoots.has(target)) continue
        this.observer.observe(target, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'],
        })
        this.observedRoots.add(target)
      }
    }
  }

  private onMutations(records: MutationRecord[]): void {
    let relevant = false
    for (const record of records) {
      const target =
        record.target.nodeType === 1
          ? (record.target as Element)
          : record.target.parentElement
      if (!target || target.closest('[data-lens-ignore]')) continue

      if (record.type === 'childList') {
        const changed = [...record.addedNodes, ...record.removedNodes]
        if (changed.length > 0 && changed.every((node) => this.isOwnNode(node))) continue
      }

      const translatedHost = target.closest(`[${TRANSLATED_ATTR}]`)
      if (translatedHost && record.type === 'attributes') continue
      if (translatedHost) {
        const source = translatedHost.getAttribute(PAGE_SOURCE_ATTR) ?? ''
        if (normalizeText(elementText(translatedHost)) === source) continue
        if (this.markChurnAndMaybeVolatile(translatedHost)) {
          // Host changes too often to be worth translating: restore the original
          // text and stop tracking it so we never loop on it again.
          this.invalidateHost(translatedHost)
          continue
        }
        this.invalidateHost(translatedHost)
        this.dirtyRoots.add(translatedHost.parentElement ?? translatedHost)
        relevant = true
        continue
      }
      this.dirtyRoots.add(target.parentElement ?? target)
      relevant = true
    }
    if (relevant) this.scheduleScan()
  }

  private markChurnAndMaybeVolatile(host: Element): boolean {
    const now = Date.now()
    const record = this.hostChurn.get(host)
    if (!record || now - record.since > VOLATILE_CHURN_WINDOW_MS) {
      this.hostChurn.set(host, { count: 1, since: now })
      return false
    }
    record.count++
    if (record.count < VOLATILE_CHURN_LIMIT) return false
    this.volatileHosts.add(host)
    const sourceBlock = this.sourceBlockByHost.get(host)
    if (sourceBlock) this.volatileHosts.add(sourceBlock)
    return true
  }

  private isOwnNode(node: Node): boolean {
    return (
      node.nodeType === 1 &&
      ((node as Element).hasAttribute('data-lens-ignore') ||
        (node as Element).id === STYLE_ID ||
        (node as Element).id === STATUS_ID)
    )
  }

  private invalidateHost(host: Element): void {
    this.alignment.unregister(host)
    host.removeAttribute(TRANSLATED_ATTR)
    host.removeAttribute(TRANSLATION_TEXT_ATTR)
    host.removeAttribute(UI_TRANSLATION_ATTR)
    host.removeAttribute(UI_STACKED_TRANSLATION_ATTR)
    host.removeAttribute(UI_CONTROL_TRANSLATION_ATTR)
    this.translatedHosts.delete(host)
    const previous = this.sourceHosts.get(host)
    if (previous === null) host.removeAttribute(PAGE_SOURCE_ATTR)
    else if (previous !== undefined) host.setAttribute(PAGE_SOURCE_ATTR, previous)
    this.sourceHosts.delete(host)
    this.attemptedTextByHost.delete(this.sourceBlockByHost.get(host) ?? host)
    this.sourceBlockByHost.delete(host)
  }

  private cleanupDisconnectedHosts(): void {
    for (const host of this.translatedHosts) {
      if (host.isConnected) continue
      this.invalidateHost(host)
    }
  }

  private scheduleScan(delay = 250): void {
    window.clearTimeout(this.mutationTimer)
    this.mutationTimer = window.setTimeout(() => {
      if (!this.active || !this.currentSettings) return
      void this.scanAndTranslate(this.currentSettings, this.generation)
    }, delay)
  }

  private scheduleInitialRetry(generation: number): void {
    window.clearTimeout(this.initialRetryTimer)
    this.initialRetryTimer = window.setTimeout(() => {
      if (!this.isCurrent(generation) || !this.currentSettings) return
      void this.scanAndTranslate(this.currentSettings, generation, true)
    }, INITIAL_RETRY_INTERVAL_MS)
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation
  }

  private ensureStyles(settings: PageSettings): void {
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = STYLE_ID
      style.setAttribute('data-lens-ignore', '')
      ;(document.head ?? document.documentElement).append(style)
    }
    style.textContent = pageStyles(settings)
  }

  private showStatus(text: string, error = false): void {
    let status = document.getElementById(STATUS_ID)
    if (!status) {
      status = document.createElement('div')
      status.id = STATUS_ID
      status.setAttribute('data-lens-ignore', '')
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      document.documentElement.append(status)
    }
    status.dataset.error = error ? 'true' : 'false'
    status.textContent = text
  }

  private updateProgress(): void {
    this.showStatus(`整页翻译 ${Math.min(this.processedCount, this.totalCount)}/${this.totalCount}`)
  }

  private failActivation(message: string): void {
    this.active = false
    window.clearTimeout(this.initialRetryTimer)
    this.observer?.disconnect()
    this.observer = null
    this.alignment.deactivate()
    this.showStatus(message, true)
    this.scheduleStatusRemoval(5000)
  }

  private scheduleStatusRemoval(delay = 3000): void {
    window.clearTimeout(this.statusTimer)
    this.statusTimer = window.setTimeout(() => {
      document.getElementById(STATUS_ID)?.remove()
    }, delay)
  }
}
