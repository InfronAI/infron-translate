import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings-defaults'
import type {
  PageLanguageResult,
  SettingsMsg,
  TogglePageTranslationResult,
} from '../shared/messages'
import { BrowserTranslator } from './browser-translator'
import { PageTranslator } from './page-translator'
import { detectPageSourceLanguage } from './page-language'
import { browserLanguageCode } from '../shared/languages'

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

export function pageTranslationSigOf(
  s: UserSettings,
  isConfiguredFlag: boolean,
  effectiveSourceLang = s.sourceLang,
): string {
  return [
    s.pageTranslationEngine === 'external' ? isConfiguredFlag : true,
    effectiveSourceLang,
    s.targetLang,
    s.pageTranslationEngine,
    s.translationDisplayMode,
    s.minTextLength,
    s.batchCharLimit,
  ].join('\0')
}

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

type PageSettings = UserSettings & { sourceLang: string }

export class PageController {
  private readonly browserTranslator = new BrowserTranslator()
  private readonly pageTranslator = new PageTranslator(this.browserTranslator)
  private settings: UserSettings = DEFAULT_SETTINGS
  private configured = false
  private pausedHere = false
  private pageSettingsSig = ''
  private pageStyleSig = ''
  private autoPageStartPending = false
  private settingsGeneration = 0
  private detectedSourceLang = 'auto'
  private listenersBound = false

  bindListeners(): void {
    if (this.listenersBound) return
    this.listenersBound = true

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) void this.refreshSettings()
    })

    chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
      if (sender.id !== chrome.runtime.id || !message || typeof message !== 'object') return false

      const type = (message as { type?: unknown }).type
      if (type === 'toggle-page-translation') {
        const result = this.validatePageTranslation()
        if (!result.ok) {
          sendResponse(result)
          return false
        }
        void this.pageTranslator.toggle(this.pageSettings(), this.configured)
        sendResponse({ ok: true } satisfies TogglePageTranslationResult)
        return false
      }

      if (type === 'get-page-language') {
        sendResponse({
          type: 'page-language-result',
          detectedSourceLang: this.detectedSourceLang,
          effectiveSourceLang: this.effectiveSourceLang(),
        } satisfies PageLanguageResult)
        return false
      }

      return false
    })
  }

  async refreshSettings(): Promise<void> {
    try {
      const response: unknown = await chrome.runtime.sendMessage({ type: 'get-settings' })
      const responseError = backgroundError(response)
      if (responseError) throw new Error(responseError)
      if (!isSettingsMessage(response)) throw new Error('Invalid settings response')

      this.configured = response.configured
      this.settings = mergeSettings(response.settings)
      this.detectedSourceLang = detectPageSourceLanguage()
      this.settingsGeneration++
      this.pausedHere = response.paused
      if (this.pausedHere && this.pageTranslator.isActive()) this.pageTranslator.deactivate()

      const pageSig = pageTranslationSigOf(
        this.settings,
        this.configured,
        this.effectiveSourceLang(),
      )
      const pageChanged = pageSig !== this.pageSettingsSig
      const previousPageSig = this.pageSettingsSig
      this.pageSettingsSig = pageSig

      const styleSig = pageStyleSigOf(this.settings)
      const styleChanged = styleSig !== this.pageStyleSig
      this.pageStyleSig = styleSig

      if (previousPageSig !== '' && pageChanged && this.pageTranslator.isActive()) {
        this.pageTranslator.deactivate()
      } else if (styleChanged && this.pageTranslator.isActive()) {
        this.pageTranslator.restyle(this.pageSettings())
      }

      if (this.settings.autoPageTranslation) await this.maybeStartPageTranslation()
    } catch (error) {
      console.warn(
        '[Infron Translate] settings refresh failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  private async maybeStartPageTranslation(): Promise<void> {
    if (
      this.autoPageStartPending ||
      this.pausedHere ||
      !this.settings.autoPageTranslation ||
      this.pageTranslator.isActive() ||
      browserLanguageCode(this.effectiveSourceLang()) ===
        browserLanguageCode(this.settings.targetLang)
    ) {
      return
    }
    if (this.settings.pageTranslationEngine === 'external' && !this.configured) return

    const settingsGeneration = this.settingsGeneration
    const settings = this.settings
    const sourceLang = this.effectiveSourceLang()
    const configured = this.configured
    this.autoPageStartPending = true
    try {
      if (settings.pageTranslationEngine === 'browser') {
        const availability = await this.browserTranslator.availability(
          browserLanguageCode(sourceLang),
          browserLanguageCode(settings.targetLang),
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
      await this.pageTranslator.activate({ ...settings, sourceLang }, configured)
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

  private validatePageTranslation(): TogglePageTranslationResult {
    if (this.pausedHere) return { ok: false, error: '当前网站已暂停翻译' }
    if (this.settings.pageTranslationEngine === 'external' && !this.configured) {
      return { ok: false, error: '整页翻译需要先配置外部 API' }
    }
    if (this.settings.pageTranslationEngine === 'browser' && !this.browserTranslator.isSupported()) {
      return { ok: false, error: '当前浏览器不支持 Chrome 内置翻译' }
    }
    return { ok: true }
  }

  private pageSettings(): PageSettings {
    return { ...this.settings, sourceLang: this.effectiveSourceLang() }
  }

  private effectiveSourceLang(): string {
    return this.settings.sourceLang === 'auto'
      ? this.detectedSourceLang
      : this.settings.sourceLang
  }
}
