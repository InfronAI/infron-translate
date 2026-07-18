import { matchesHotkey } from '../shared/hotkey'
import { makeBlockId } from '../shared/block-id'
import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings-defaults'
import type {
  SettingsMsg,
  TranslateBatchResultErr,
  TranslateBatchResultOk,
  TranslateBlock,
  TranslateImageResultErr,
  TranslateImageResultOk,
  TogglePageTranslationResult,
} from '../shared/messages'
import { normalizeText } from '../shared/text'
import { coarsePath, extractBlockAtElement, extractVisibleBlocks } from './extract'
import { BlockRegistry } from './registry'
import { LensOverlay } from './lens'
import { BrowserTranslator } from './browser-translator'
import { ImageRegistry, type ImageTranslationEntry } from './image-registry'
import { makePageKey } from './page-key'
import { TranslationBatcher } from './translation-batcher'
import { PageTranslator } from './page-translator'
import { detectPageSourceLanguage } from './page-language'

// ---------------------------------------------------------------------------
// Runtime type guards (no runtime dep, zero alloc on hot path)
// ---------------------------------------------------------------------------

function isImageTranslationResult(
  value: unknown,
): value is TranslateImageResultOk | TranslateImageResultErr {
  if (!value || typeof value !== 'object' || !('type' in value) || !('ok' in value)) return false
  if (value.type !== 'translate-image-result' || typeof value.ok !== 'boolean') return false
  return value.ok
    ? 'translation' in value && typeof value.translation === 'string'
    : 'error' in value && typeof value.error === 'string'
}

function isTranslationRow(value: unknown): value is { id: string; translation: string } {
  if (!value || typeof value !== 'object') return false
  return (
    'id' in value &&
    typeof value.id === 'string' &&
    'translation' in value &&
    typeof value.translation === 'string'
  )
}

function isTranslateBatchResult(
  value: unknown,
): value is TranslateBatchResultOk | TranslateBatchResultErr {
  if (!value || typeof value !== 'object' || !('type' in value) || !('ok' in value)) return false
  if (value.type !== 'translate-batch-result' || typeof value.ok !== 'boolean') return false
  if (value.ok) {
    return (
      'translations' in value &&
      Array.isArray(value.translations) &&
      value.translations.every(isTranslationRow)
    )
  }
  if (!('error' in value) || typeof value.error !== 'string') return false
  return (
    !('translations' in value) ||
    value.translations === undefined ||
    (Array.isArray(value.translations) && value.translations.every(isTranslationRow))
  )
}

function isSettingsMessage(value: unknown): value is SettingsMsg {
  if (!value || typeof value !== 'object') return false
  if (!('type' in value) || value.type !== 'settings') return false
  if (!('configured' in value) || typeof value.configured !== 'boolean') return false
  if (!('settings' in value) || !value.settings || typeof value.settings !== 'object') return false
  if (!('paused' in value) || typeof value.paused !== 'boolean') return false
  return 'apiKey' in value.settings && value.settings.apiKey === ''
}

function backgroundError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  if (!('type' in value) || value.type !== 'background-error') return null
  return 'error' in value && typeof value.error === 'string' ? value.error : null
}

/**
 * Signature of settings that require re-translating the page (language pair,
 * engine, thresholds). A change here tears down and rebuilds the run.
 */
export function lensTranslationSigOf(s: UserSettings, isConfiguredFlag: boolean): string {
  return [
    isConfiguredFlag,
    s.targetLang,
    s.minTextLength,
    s.batchCharLimit,
  ].join('\0')
}

export function pageTranslationSigOf(s: UserSettings, isConfiguredFlag: boolean): string {
  return [
    s.pageTranslationEngine === 'external' ? isConfiguredFlag : true,
    s.targetLang,
    s.pageTranslationEngine,
    s.minTextLength,
    s.batchCharLimit,
  ].join('\0')
}

/**
 * Signature of appearance-only settings (font size, colors, weight…). A change
 * here just re-injects the stylesheet, keeping translations in place.
 */
function pageStyleSigOf(s: UserSettings): string {
  return [
    s.pageTranslationFontSizePx,
    s.pageTranslationUseCustomColor,
    s.pageTranslationTextColor,
    s.pageTranslationUseBackground,
    s.pageTranslationBackgroundColor,
    s.pageTranslationBold,
    s.pageTranslationItalic,
    s.pageTranslationUnderline,
  ].join('\0')
}

// ---------------------------------------------------------------------------
// LensController
// ---------------------------------------------------------------------------

/**
 * Owns all lens interaction state and orchestrates the translation pipeline.
 * Created once per content-script lifecycle; `main.ts` only mounts it.
 */
export class LensController {
  // --- sub-systems ---
  private readonly registry = new BlockRegistry()
  private readonly imageRegistry = new ImageRegistry()
  private readonly browserTranslator = new BrowserTranslator()
  private readonly pageTranslator = new PageTranslator(this.browserTranslator)
  private readonly lens: LensOverlay
  private readonly batcher: TranslationBatcher

  // --- settings state ---
  settings: UserSettings = DEFAULT_SETTINGS
  private configured = false
  private pausedHere = false
  private lensSettingsSig = ''
  private pageSettingsSig = ''
  private pageStyleSig = ''
  private autoPageStartPending = false
  private settingsGeneration = 0
  private translationGeneration = 0
  private detectedSourceLang = 'auto'

  // --- lens interaction state ---
  private lensActive = false
  private lensSticky = false
  private lastMouse = { x: 0, y: 0 }

  // --- in-flight dedup ---
  /** In-flight block ids — avoid duplicate API calls for the same block. */
  private readonly inflight = new Map<string, number>()
  /** In-flight normalized texts — identical sentences share one request. */
  private readonly inflightTexts = new Map<string, number>()
  private readonly imageInflight = new Set<string>()

  // --- rAF + bind guard ---
  private pointerFrame = 0
  private stickyFrame = 0
  private listenersBound = false

  constructor(lensWidthPx = 340) {
    this.lens = new LensOverlay(lensWidthPx)
    this.batcher = new TranslationBatcher((blocks) => this.translateSpecific(blocks))
  }

  // -------------------------------------------------------------------------
  // Public API (called from main.ts)
  // -------------------------------------------------------------------------

  bindListeners(): void {
    if (this.listenersBound) return
    this.listenersBound = true
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('mousemove', this.onMouseMove, true)
    window.addEventListener('click', this.onClick, true)

    const scheduleScan = debounce(() => {
      if (this.settings.autoTranslate) void this.scanVisibleAndTranslate()
    }, 300)
    window.addEventListener('scroll', scheduleScan, true)
    window.addEventListener('resize', scheduleScan)

    // A pinned (sticky) lens must keep its highlight ring aligned with the source
    // element as the page scrolls; the ring lives in a fixed overlay otherwise.
    window.addEventListener('scroll', this.onStickyReposition, true)
    window.addEventListener('resize', this.onStickyReposition)

    const mo = new MutationObserver(
      debounce(() => {
        if (this.settings.autoTranslate) void this.scanVisibleAndTranslate()
      }, 500),
    )
    mo.observe(document.documentElement, { childList: true, subtree: true })

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) void this.refreshSettings()
    })

    // Popup “翻译此页” button drives the same toggle as the page hotkey.
    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      if (
        sender.id === chrome.runtime.id &&
        message &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'toggle-page-translation'
      ) {
        if (this.pausedHere) {
          const result: TogglePageTranslationResult = {
            ok: false,
            error: '当前网站已暂停翻译',
          }
          sendResponse(result)
          return false
        }
        if (this.settings.pageTranslationEngine === 'external' && !this.configured) {
          const result: TogglePageTranslationResult = {
            ok: false,
            error: '整页翻译需要先配置外部 API',
          }
          sendResponse(result)
          return false
        }
        if (
          this.settings.pageTranslationEngine === 'browser' &&
          !this.browserTranslator.isSupported()
        ) {
          const result: TogglePageTranslationResult = {
            ok: false,
            error: '当前浏览器不支持 Chrome 内置翻译',
          }
          sendResponse(result)
          return false
        }
        if (this.lensActive) this.deactivateLens()
        void this.pageTranslator.toggle(this.pageSettings(), this.configured)
        const result: TogglePageTranslationResult = { ok: true }
        sendResponse(result)
        return false
      }
      return false
    })
  }

  /** Refresh only redacted settings; the API key never enters the content-script world. */
  async refreshSettings(): Promise<void> {
    try {
      const response: unknown = await chrome.runtime.sendMessage({ type: 'get-settings' })
      const responseError = backgroundError(response)
      if (responseError) throw new Error(responseError)
      if (!isSettingsMessage(response)) throw new Error('Invalid settings response')

      const previousSettings = this.settings
      this.configured = response.configured
      this.settings = mergeSettings(response.settings)
      this.detectedSourceLang = detectPageSourceLanguage()
      this.settingsGeneration++
      this.pausedHere = response.paused
      if (this.pausedHere) {
        if (this.lensActive) this.deactivateLens()
        if (this.pageTranslator.isActive()) this.pageTranslator.deactivate()
      }
      this.lens.setWidth(this.settings.lensWidthPx)
      this.lens.setFontSize(this.settings.pageTranslationFontSizePx)

      const lensSig = lensTranslationSigOf(this.settings, this.configured)
      const lensChanged = lensSig !== this.lensSettingsSig
      const previousLensSig = this.lensSettingsSig
      this.lensSettingsSig = lensSig

      const pageSig = pageTranslationSigOf(this.settings, this.configured)
      const pageChanged = pageSig !== this.pageSettingsSig
      const previousPageSig = this.pageSettingsSig
      this.pageSettingsSig = pageSig

      const styleSig = pageStyleSigOf(this.settings)
      const styleChanged = styleSig !== this.pageStyleSig
      this.pageStyleSig = styleSig

      if (previousPageSig !== '' && pageChanged && this.pageTranslator.isActive()) {
        this.pageTranslator.deactivate()
      } else if (styleChanged && this.pageTranslator.isActive()) {
        // Appearance-only change: restyle in place instead of losing translations.
        this.pageTranslator.restyle(this.pageSettings())
      }

      if (previousLensSig !== '' && lensChanged) {
        this.translationGeneration++
        this.inflight.clear()
        this.inflightTexts.clear()
        this.registry.resetTranslationsToPending()
      }
      if (
        this.canTranslateText() &&
        this.settings.autoTranslate &&
        (lensChanged || !previousSettings.autoTranslate)
      ) {
        this.lensActive = true
        this.lensSticky = false
        this.ensureMouseSeed()
        this.updateLens()
        void this.scanVisibleAndTranslate()
      }
      if (previousSettings.autoTranslate && !this.settings.autoTranslate && !this.lensSticky) {
        this.deactivateLens()
      }
      if (this.settings.autoPageTranslation) await this.maybeStartPageTranslation()
    } catch (error) {
      console.warn(
        '[Infron Translate] settings refresh failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  ensureMouseSeed(): void {
    if (this.lastMouse.x === 0 && this.lastMouse.y === 0) {
      this.lastMouse = {
        x: Math.round(window.innerWidth / 2),
        y: Math.round(window.innerHeight / 2),
      }
    }
  }

  async scanVisibleAndTranslate(): Promise<void> {
    if (this.pausedHere || !this.settings.autoTranslate || !this.canTranslateText()) return
    const margin = Math.round(window.innerHeight * this.settings.prefetchMarginRatio)
    const blocks = extractVisibleBlocks(this.settings.minTextLength, margin)
    for (const b of blocks) {
      this.registry.upsert({ id: b.id, el: b.el, tag: b.tag, text: b.text })
    }
    const pending = this.registry.pendingBlocks().filter((b) => !this.inflight.has(b.id))
    if (!pending.length) return
    await this.translateSpecific(pending)
  }

  async maybeStartPageTranslation(): Promise<void> {
    if (
      this.autoPageStartPending ||
      this.pausedHere ||
      !this.settings.autoPageTranslation ||
      this.pageTranslator.isActive() ||
      this.detectedSourceLang === this.settings.targetLang
    ) {
      return
    }
    if (this.settings.pageTranslationEngine === 'external' && !this.configured) return

    const settingsGeneration = this.settingsGeneration
    const settings = this.settings
    const configured = this.configured
    this.autoPageStartPending = true
    try {
      if (settings.pageTranslationEngine === 'browser') {
        const availability = await this.browserTranslator.availability(
          this.detectedSourceLang,
          settings.targetLang,
        )
        if (availability !== 'available') return
      }
      if (
        settingsGeneration !== this.settingsGeneration ||
        this.pausedHere ||
        !this.settings.autoPageTranslation ||
        this.pageTranslator.isActive()
      ) {
        return
      }
      await this.pageTranslator.activate(
        { ...settings, sourceLang: this.detectedSourceLang },
        configured,
      )
    } finally {
      this.autoPageStartPending = false
      if (
        settingsGeneration !== this.settingsGeneration &&
        this.settings.autoPageTranslation &&
        !this.pausedHere &&
        !this.pageTranslator.isActive()
      ) {
        void this.maybeStartPageTranslation()
      }
    }
  }

  // -------------------------------------------------------------------------
  // Private interaction handlers (arrow fns to preserve `this` in addEventListener)
  // -------------------------------------------------------------------------

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.lensActive) {
        e.preventDefault()
        this.deactivateLens()
        return
      }
      if (this.pageTranslator.isActive()) {
        e.preventDefault()
        this.pageTranslator.deactivate()
        return
      }
    }

    if (this.pausedHere) return
    if (matchesHotkey(e, this.settings.pageTranslationHotkey)) {
      if (e.repeat) {
        e.preventDefault()
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (this.lensActive) this.deactivateLens()
      void this.pageTranslator.toggle(this.pageSettings(), this.configured)
      return
    }
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (e.composedPath().includes(this.lens.getHost())) return
    this.lastMouse = { x: e.clientX, y: e.clientY }
    if (!this.settings.autoTranslate || this.lensSticky || this.pointerFrame) return
    if (this.pausedHere) return
    this.lensActive = true
    this.pointerFrame = requestAnimationFrame(() => {
      this.pointerFrame = 0
      this.updateLens()
    })
  }

  private readonly onClick = (e: MouseEvent): void => {
    if (e.button !== 0 || this.pausedHere) return
    if (e.composedPath().includes(this.lens.getHost())) return
    this.lastMouse = { x: e.clientX, y: e.clientY }
    this.lensActive = true
    this.lensSticky = true
    this.updateLens()
  }

  private readonly onStickyReposition = (): void => {
    if (!this.lensActive || !this.lensSticky || this.stickyFrame) return
    this.stickyFrame = requestAnimationFrame(() => {
      this.stickyFrame = 0
      this.lens.reposition()
    })
  }

  // -------------------------------------------------------------------------
  // Lens update
  // -------------------------------------------------------------------------

  private updateLens(): void {
    if (!this.lensActive) {
      this.lens.hide()
      return
    }
    this.ensureMouseSeed()
    const host = this.lens.getHost()
    const stack = document
      .elementsFromPoint(this.lastMouse.x, this.lastMouse.y)
      .filter((el) => el !== host && !host.contains(el))
    const hit = stack[0] ?? null

    const imageEntry = this.imageEntryForHit(hit)
    if (imageEntry) {
      if (!this.configured) {
        this.lens.showAt(this.lastMouse.x, this.lastMouse.y, { kind: 'unconfigured' })
        this.lens.highlight(null)
        return
      }

      const sourceRect = imageEntry.el.getBoundingClientRect()
      this.lens.highlight(imageEntry.el)
      if (imageEntry.status === 'ready' && imageEntry.translation) {
        this.lens.showAt(this.lastMouse.x, this.lastMouse.y, {
          kind: 'ready',
          text: imageEntry.translation,
          sourceRect,
        })
        return
      }
      if (imageEntry.status === 'error' && !this.imageInflight.has(imageEntry.id)) {
        this.lens.showAt(this.lastMouse.x, this.lastMouse.y, {
          kind: 'error',
          message: imageEntry.error ?? '图片翻译失败',
          sourceRect,
        })
        return
      }

      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, { kind: 'pending', sourceRect })
      void this.translateImageEntry(imageEntry)
      return
    }

    if (!this.canTranslateText()) {
      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, { kind: 'unconfigured' })
      this.lens.highlight(null)
      return
    }

    let entry = this.registry.getByElement(hit)
    if (!entry) {
      const block = extractBlockAtElement(hit, this.settings.minTextLength)
      if (block) entry = this.registry.upsert(block)
    }

    if (!entry) {
      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, { kind: 'empty' })
      this.lens.highlight(null)
      return
    }

    this.lens.highlight(entry.el)
    const sourceRect = entry.el.getBoundingClientRect()
    const sourceText = entry.text

    if (entry.status === 'ready' && entry.translation) {
      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, {
        kind: 'ready',
        text: entry.translation,
        sourceText,
        sourceRect,
      })
      return
    }

    if (entry.status === 'error' && !this.inflight.has(entry.id)) {
      this.lens.showAt(this.lastMouse.x, this.lastMouse.y, {
        kind: 'error',
        message: entry.error ?? '翻译失败',
        sourceText,
        sourceRect,
      })
      return
    }

    // Need translation — show EN while waiting
    this.lens.showAt(this.lastMouse.x, this.lastMouse.y, {
      kind: 'pending',
      sourceText,
      sourceRect,
    })
    if (!this.inflight.has(entry.id)) {
      this.batcher.enqueue({ id: entry.id, tag: entry.tag, text: entry.text })
    }
  }

  private deactivateLens(): void {
    this.lensActive = false
    this.lensSticky = false
    this.lens.hide()
  }

  // -------------------------------------------------------------------------
  // Translation
  // -------------------------------------------------------------------------

  private async translateImageEntry(entry: ImageTranslationEntry): Promise<void> {
    if (this.pausedHere || !this.configured || this.imageInflight.has(entry.id)) return

    this.imageInflight.add(entry.id)
    this.imageRegistry.setPending(entry.id)
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'translate-image',
        imageUrl: entry.url,
        sourceLang: this.detectedSourceLang,
      })
      if (!isImageTranslationResult(result)) {
        this.imageRegistry.setError(entry.id, '图片翻译服务未返回有效结果')
      } else if (result.ok) {
        this.imageRegistry.setTranslation(entry.id, result.translation)
      } else {
        this.imageRegistry.setError(entry.id, result.error)
      }
    } catch (error) {
      this.imageRegistry.setError(entry.id, error instanceof Error ? error.message : String(error))
    } finally {
      this.imageInflight.delete(entry.id)
    }

    if (this.lensActive) this.updateLens()
  }

  async translateSpecific(blocks: TranslateBlock[]): Promise<void> {
    if (this.pausedHere) return

    const generation = this.translationGeneration
    const configured = this.configured
    const todo: TranslateBlock[] = []
    const seenText = new Set<string>()

    for (const b of blocks) {
      const e = this.registry.get(b.id)
      if (!e) continue
      if (e.status === 'ready' && e.translation) continue
      if (this.inflight.has(b.id)) continue
      const norm = normalizeText(b.text)
      if (this.inflightTexts.has(norm)) continue
      if (seenText.has(norm)) {
        this.registry.setPending(b.id)
        continue
      }
      seenText.add(norm)
      todo.push({ id: b.id, tag: b.tag, text: norm })
    }
    if (!todo.length) return

    for (const b of todo) {
      this.inflight.set(b.id, generation)
      this.inflightTexts.set(normalizeText(b.text), generation)
      this.registry.setPending(b.id)
    }

    let error = '外部 API 未配置'
    try {
      if (configured) {
        const response: unknown = await chrome.runtime.sendMessage({
          type: 'translate-batch',
          pageKey: makePageKey(),
          sourceLang: this.detectedSourceLang,
          blocks: todo,
        })
        if (generation !== this.translationGeneration) return
        if (!isTranslateBatchResult(response)) {
          error = '翻译服务未返回有效结果'
        } else {
          for (const item of response.translations ?? []) {
            this.registry.setTranslation(item.id, item.translation)
          }
          if (!response.ok) error = response.error
        }
      }

      if (generation !== this.translationGeneration) return
      for (const b of todo) {
        if (!this.registry.get(b.id)?.translation) this.registry.setError(b.id, error)
      }
    } catch (err) {
      if (generation !== this.translationGeneration) return
      error = err instanceof Error ? err.message : String(err)
      for (const b of todo) {
        if (!this.registry.get(b.id)?.translation) this.registry.setError(b.id, error)
      }
    } finally {
      for (const b of todo) {
        if (this.inflight.get(b.id) === generation) this.inflight.delete(b.id)
        const text = normalizeText(b.text)
        if (this.inflightTexts.get(text) === generation) this.inflightTexts.delete(text)
      }
    }

    if (this.lensActive) this.updateLens()
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private canTranslateText(): boolean {
    return this.configured
  }

  private pageSettings(): UserSettings & { sourceLang: string } {
    return { ...this.settings, sourceLang: this.detectedSourceLang }
  }

  private imageEntryForHit(hit: Element | null): ImageTranslationEntry | undefined {
    if (!(hit instanceof HTMLImageElement)) return undefined
    if (!hit.complete || hit.naturalWidth < 2 || hit.naturalHeight < 2) return undefined
    const url = hit.currentSrc || hit.src
    if (!url) return undefined
    return this.imageRegistry.upsert(makeBlockId('img', url, coarsePath(hit)), hit, url)
  }

}

// ---------------------------------------------------------------------------
// Standalone util (not exported — used only here)
// ---------------------------------------------------------------------------

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let t = 0
  return ((...args: unknown[]) => {
    window.clearTimeout(t)
    t = window.setTimeout(() => fn(...args), ms)
  }) as T
}
