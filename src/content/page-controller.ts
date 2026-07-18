import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings-defaults'
import type {
  OpenOptionsMsg,
  PageLanguageResult,
  SetAutoPageTranslationMsg,
  SettingsMsg,
  TogglePageTranslationResult,
} from '../shared/messages'
import { BrowserTranslator } from './browser-translator'
import { PageTranslator } from './page-translator'
import { detectPageSourceLanguage } from './page-language'
import { browserLanguageCode } from '../shared/languages'
import { uiText } from '../shared/i18n'

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

const AUTO_TOGGLE_HOST_ID = 'infron-translate-auto-toggle'

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
  private externalConfigPrompted = false
  private autoToggleRoot: ShadowRoot | null = null
  private autoToggleButton: HTMLButtonElement | null = null
  private autoToggleBusy = false

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
      this.ensureAutoToggle()
      this.renderAutoToggle()
      if (this.settings.pageTranslationEngine !== 'external' || this.configured) {
        this.externalConfigPrompted = false
      }
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
    if (this.settings.pageTranslationEngine === 'external' && !this.configured) {
      await this.openExternalConfigPage()
      return
    }

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
    if (this.pausedHere) return { ok: false, error: 'Translation is paused for this site' }
    if (this.settings.pageTranslationEngine === 'external' && !this.configured) {
      void this.openExternalConfigPage()
      return { ok: false, error: 'Cloud AI model needs to be configured first' }
    }
    if (this.settings.pageTranslationEngine === 'browser' && !this.browserTranslator.isSupported()) {
      return { ok: false, error: 'This browser does not support Chrome built-in translation' }
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

  private async openExternalConfigPage(): Promise<void> {
    if (this.externalConfigPrompted) return
    this.externalConfigPrompted = true
    try {
      await chrome.runtime.sendMessage({ type: 'open-options' } satisfies OpenOptionsMsg)
    } catch {
      // Opening the options page is a guide; translation validation still returns the real error.
    }
  }

  private ensureAutoToggle(): void {
    if (this.autoToggleRoot && this.autoToggleButton) return
    let host = document.getElementById(AUTO_TOGGLE_HOST_ID)
    if (!host) {
      host = document.createElement('div')
      host.id = AUTO_TOGGLE_HOST_ID
      host.setAttribute('data-infron-ignore', '')
      document.documentElement.append(host)
    }
    this.autoToggleRoot = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    if (this.autoToggleRoot.childElementCount === 0) {
      const style = document.createElement('style')
      style.textContent = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483646;
  top: 50%;
  right: 14px;
  transform: translateY(-50%);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}

button {
  all: unset;
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  box-sizing: border-box;
  padding: 8px;
  border: 1px solid rgb(255 255 255 / 58%);
  border-radius: 999px;
  background:
    radial-gradient(circle at 22% 12%, rgb(255 255 255 / 92%), transparent 34%),
    linear-gradient(135deg, rgb(25 113 235 / 96%), rgb(0 180 160 / 94%));
  color: #fff;
  box-shadow:
    0 14px 34px rgb(15 23 42 / 22%),
    0 0 0 3px rgb(0 180 160 / 24%),
    inset 0 1px 0 rgb(255 255 255 / 42%);
  cursor: pointer;
  user-select: none;
  -webkit-font-smoothing: antialiased;
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease, opacity 0.16s ease;
}

button:hover {
  transform: translateX(-2px) scale(1.04);
  filter: saturate(1.08) brightness(1.04);
  box-shadow:
    0 18px 42px rgb(15 23 42 / 26%),
    0 0 0 4px rgb(0 180 160 / 28%),
    inset 0 1px 0 rgb(255 255 255 / 48%);
}

button:active {
  transform: translateX(-1px) scale(0.98);
}

button:focus-visible {
  outline: 3px solid rgb(59 130 246 / 34%);
  outline-offset: 3px;
}

button[data-enabled="false"] {
  background:
    radial-gradient(circle at 22% 12%, rgb(255 255 255 / 86%), transparent 34%),
    linear-gradient(135deg, rgb(71 85 105 / 94%), rgb(100 116 139 / 92%));
  filter: grayscale(0.64) saturate(0.52);
  opacity: 0.68;
  box-shadow:
    0 10px 24px rgb(15 23 42 / 16%),
    0 0 0 1px rgb(148 163 184 / 22%),
    inset 0 1px 0 rgb(255 255 255 / 34%);
}

button[data-busy="true"] {
  pointer-events: none;
  opacity: 0.72;
  animation: infronAutoTogglePulse 0.8s ease-in-out infinite;
}

.logo {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  object-fit: contain;
  filter: drop-shadow(0 1px 2px rgb(15 23 42 / 22%));
}

@keyframes infronAutoTogglePulse {
  0%, 100% { transform: scale(0.96); }
  50% { transform: scale(1.04); }
}

@media (max-width: 520px) {
  :host { right: 10px; }
  button {
    width: 42px;
    height: 42px;
    padding: 10px;
  }
}
`
      const button = document.createElement('button')
      button.type = 'button'
      button.innerHTML = '<img class="logo" src="' + chrome.runtime.getURL('icons/infron-mark.png') + '" alt="" aria-hidden="true" />'
      button.addEventListener('click', () => {
        void this.toggleAutoTranslation()
      })
      this.autoToggleRoot.append(style, button)
      this.autoToggleButton = button
    } else {
      this.autoToggleButton = this.autoToggleRoot.querySelector('button')
    }
  }

  private renderAutoToggle(): void {
    if (!this.autoToggleButton) return
    const enabled = this.settings.autoPageTranslation
    const label = uiText(this.settings.uiLanguage, enabled ? 'autoStop' : 'autoStart')
    this.autoToggleButton.dataset.enabled = String(enabled)
    this.autoToggleButton.dataset.busy = String(this.autoToggleBusy)
    this.autoToggleButton.disabled = this.autoToggleBusy
    this.autoToggleButton.removeAttribute('title')
    this.autoToggleButton.setAttribute('aria-label', label)
  }

  private async toggleAutoTranslation(): Promise<void> {
    if (this.autoToggleBusy) return
    this.autoToggleBusy = true
    this.renderAutoToggle()
    try {
      const nextEnabled = !this.settings.autoPageTranslation
      const response: unknown = await chrome.runtime.sendMessage({
        type: 'set-auto-page-translation',
        enabled: nextEnabled,
      } satisfies SetAutoPageTranslationMsg)
      const responseError = backgroundError(response)
      if (responseError) throw new Error(responseError)
      if (!isSettingsMessage(response)) throw new Error('Invalid settings response')
      this.configured = response.configured
      this.settings = mergeSettings(response.settings)
      this.pausedHere = response.paused
      this.settingsGeneration++
      this.renderAutoToggle()
      if (this.settings.autoPageTranslation) await this.maybeStartPageTranslation()
      else if (this.pageTranslator.isActive()) this.pageTranslator.deactivate()
    } catch (error) {
      console.warn(
        '[Infron Translate] auto translation toggle failed',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      this.autoToggleBusy = false
      this.renderAutoToggle()
    }
  }
}
