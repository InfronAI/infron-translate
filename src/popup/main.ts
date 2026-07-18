import {
  DEFAULT_SETTINGS,
  isConfigured,
  loadSettings,
  saveSettings,
  type TranslationEngine,
  type UserSettings,
} from '../shared/settings'
import { LANGUAGE_OPTIONS, languageLabel } from '../shared/languages'
import type { TranslationDisplayMode } from '../shared/settings-defaults'
import type {
  GetPageLanguageMsg,
  PageLanguageResult,
  PauseHostnameMsg,
  TogglePageTranslationMsg,
  TogglePageTranslationResult,
} from '../shared/messages'

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

function hostnameFromUrl(url: string | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.hostname
  } catch {
    return ''
  }
}

function populateLanguageSelects(): void {
  const source = el<HTMLSelectElement>('sourceLangSelect')
  source.replaceChildren(
    option('auto', 'Auto detect'),
    ...LANGUAGE_OPTIONS.map(([code, name]) => option(code, `${name} · ${code}`)),
  )

  const target = el<HTMLSelectElement>('targetLangSelect')
  target.replaceChildren(
    ...LANGUAGE_OPTIONS.map(([code, name]) => option(code, `${name} · ${code}`)),
  )
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

function setSourceLanguageValue(value: string): void {
  setLanguageSelectValue('sourceLangSelect', value, 'auto')
}

function setTargetLanguageValue(value: string): void {
  setLanguageSelectValue('targetLangSelect', value, DEFAULT_SETTINGS.targetLang)
}

function setLanguageSelectValue(id: string, value: string, fallback: string): void {
  const select = el<HTMLSelectElement>(id)
  const nextValue = value || fallback
  if (![...select.options].some((item) => item.value === nextValue)) {
    select.append(option(nextValue, `Custom · ${nextValue}`))
  }
  select.value = nextValue
}

function renderStatus(settings: UserSettings): void {
  const configured = isConfigured(settings)
  const pageEngineSelect = el<HTMLSelectElement>('pageEngineSelect')
  const externalOption = pageEngineSelect.querySelector<HTMLOptionElement>('option[value="external"]')
  if (externalOption) externalOption.disabled = !configured
  pageEngineSelect.value =
    settings.pageTranslationEngine === 'external' && !configured
      ? 'browser'
      : settings.pageTranslationEngine

  const pageAuto = el<HTMLInputElement>('pageAutoToggle')
  pageAuto.checked = settings.autoPageTranslation
  el<HTMLElement>('pageAutoDesc').textContent = settings.autoPageTranslation
    ? 'On: translate pages automatically'
    : 'Off: translate after clicking the button'

  el<HTMLElement>('modeHint').textContent =
    settings.translationDisplayMode === 'translation-only'
      ? 'Full-page translation only'
      : 'Full-page bilingual'

  const configureCloudModel = el<HTMLButtonElement>('configureCloudModel')
  configureCloudModel.hidden = configured

  el<HTMLElement>('usageHint').textContent =
    settings.translationDisplayMode === 'translation-only'
      ? 'Use the button below to replace page text with translations.'
      : 'Use the button below to toggle full-page bilingual translation.'
  setSourceLanguageValue(settings.sourceLang)
  setTargetLanguageValue(settings.targetLang)
  el<HTMLSelectElement>('displayModeSelect').value = settings.translationDisplayMode
}

async function openExternalConfigIfNeeded(settings: UserSettings): Promise<boolean> {
  if (settings.pageTranslationEngine !== 'external' || isConfigured(settings)) return false
  await chrome.runtime.openOptionsPage()
  return true
}

async function normalizeUnavailableEngine(settings: UserSettings): Promise<UserSettings> {
  if (settings.pageTranslationEngine !== 'external' || isConfigured(settings)) return settings
  await saveSettings({ ...settings, pageTranslationEngine: 'browser' })
  return loadSettings()
}

async function setHostnamePaused(hostname: string, paused: boolean): Promise<UserSettings> {
  const msg: PauseHostnameMsg = {
    type: 'set-hostname-paused',
    hostname,
    paused,
  }
  const response: unknown = await chrome.runtime.sendMessage(msg)
  if (
    response &&
    typeof response === 'object' &&
    'type' in response &&
    response.type === 'background-error' &&
    'error' in response &&
    typeof response.error === 'string'
  ) {
    throw new Error(response.error)
  }
  if (!response || typeof response !== 'object' || !('type' in response) || response.type !== 'settings') {
    throw new Error('Failed to update this site')
  }
  return loadSettings()
}

/** Toggle full-page translation in the active tab, injecting the script if the tab predates install. */
async function togglePageTranslation(tabId: number): Promise<void> {
  const message: TogglePageTranslationMsg = { type: 'toggle-page-translation' }
  let response: unknown
  try {
    response = await chrome.tabs.sendMessage(tabId, message)
  } catch {
    const files = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((s) => s.js ?? [])
    if (!files.length) throw new Error('Cannot run on this page')
    await chrome.scripting.executeScript({ target: { tabId }, files })
    await new Promise((resolve) => setTimeout(resolve, 120))
    response = await chrome.tabs.sendMessage(tabId, message)
  }
  if (!isTogglePageTranslationResult(response)) {
    throw new Error('The page translation script returned an invalid response')
  }
  if (!response.ok) throw new Error(response.error)
}

function isTogglePageTranslationResult(value: unknown): value is TogglePageTranslationResult {
  if (!value || typeof value !== 'object' || !('ok' in value)) return false
  if (value.ok === true) return true
  return value.ok === false && 'error' in value && typeof value.error === 'string'
}

async function queryPageLanguage(tabId: number): Promise<PageLanguageResult | null> {
  const message: GetPageLanguageMsg = { type: 'get-page-language' }
  let response: unknown
  try {
    response = await chrome.tabs.sendMessage(tabId, message)
  } catch {
    const files = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((s) => s.js ?? [])
    if (!files.length) return null
    await chrome.scripting.executeScript({ target: { tabId }, files })
    await new Promise((resolve) => setTimeout(resolve, 120))
    response = await chrome.tabs.sendMessage(tabId, message)
  }
  return isPageLanguageResult(response) ? response : null
}

function isPageLanguageResult(value: unknown): value is PageLanguageResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'type' in value &&
      value.type === 'page-language-result' &&
      'detectedSourceLang' in value &&
      typeof value.detectedSourceLang === 'string' &&
      'effectiveSourceLang' in value &&
      typeof value.effectiveSourceLang === 'string',
  )
}

async function init(): Promise<void> {
  populateLanguageSelects()

  el<HTMLButtonElement>('openOptions').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage()
  })

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const hostname = hostnameFromUrl(tab?.url)
  const hostnameEl = el<HTMLElement>('hostname')
  const pauseToggle = el<HTMLInputElement>('pauseToggle')
  const pageAutoToggle = el<HTMLInputElement>('pageAutoToggle')
  const sourceLangSelect = el<HTMLSelectElement>('sourceLangSelect')
  const targetLangSelect = el<HTMLSelectElement>('targetLangSelect')
  const displayModeSelect = el<HTMLSelectElement>('displayModeSelect')
  const pageEngineSelect = el<HTMLSelectElement>('pageEngineSelect')
  const configureCloudModel = el<HTMLButtonElement>('configureCloudModel')

  const translatePageBtn = el<HTMLButtonElement>('translatePage')
  if (tab?.id === undefined || !hostname) {
    translatePageBtn.disabled = true
    sourceLangSelect.disabled = true
  } else {
    const tabId = tab.id
    const pageLanguage = await queryPageLanguage(tabId)
    if (pageLanguage) {
      el<HTMLElement>('detectedSourceLang').textContent = languageLabel(
        pageLanguage.detectedSourceLang,
      )
    } else {
      el<HTMLElement>('detectedSourceLang').textContent = 'Unavailable'
    }
    translatePageBtn.addEventListener('click', async () => {
      try {
        el<HTMLElement>('error').hidden = true
        if (await openExternalConfigIfNeeded(settings)) return
        await togglePageTranslation(tabId)
        window.close()
      } catch (err) {
        const error = el<HTMLElement>('error')
        error.hidden = false
        error.textContent = err instanceof Error ? err.message : String(err)
      }
    })
  }

  if (!hostname) {
    hostnameEl.textContent = '(cannot read this page)'
    el<HTMLElement>('detectedSourceLang').textContent = 'Unavailable'
    pauseToggle.disabled = true
  } else {
    hostnameEl.textContent = hostname
    pauseToggle.disabled = false
  }

  let settings = await normalizeUnavailableEngine(await loadSettings())
  renderStatus(settings)

  if (hostname) {
    pauseToggle.checked = settings.pausedHostnames.includes(hostname)
    pauseToggle.addEventListener('change', async () => {
      try {
        el<HTMLElement>('error').hidden = true
        settings = await setHostnamePaused(hostname, pauseToggle.checked)
        renderStatus(settings)
      } catch (err) {
        pauseToggle.checked = !pauseToggle.checked
        const error = el<HTMLElement>('error')
        error.hidden = false
        error.textContent = err instanceof Error ? err.message : String(err)
      }
    })
  }

  pageAutoToggle.addEventListener('change', async () => {
    try {
      el<HTMLElement>('error').hidden = true
      const next: UserSettings = {
        ...settings,
        autoPageTranslation: pageAutoToggle.checked,
      }
      await saveSettings(next)
      settings = await loadSettings()
      renderStatus(settings)
      await openExternalConfigIfNeeded(settings)
    } catch (err) {
      pageAutoToggle.checked = !pageAutoToggle.checked
      const error = el<HTMLElement>('error')
      error.hidden = false
      error.textContent = err instanceof Error ? err.message : String(err)
    }
  })

  async function saveLanguageSetting(
    next: Partial<
      Pick<
        UserSettings,
        'sourceLang' | 'targetLang' | 'translationDisplayMode' | 'pageTranslationEngine'
      >
    >,
  ): Promise<void> {
    try {
      el<HTMLElement>('error').hidden = true
      if (next.pageTranslationEngine === 'external' && !isConfigured(settings)) {
        pageEngineSelect.value = settings.pageTranslationEngine
        await chrome.runtime.openOptionsPage()
        return
      }
      const nextSettings: UserSettings = {
        ...settings,
        ...next,
      }
      await saveSettings(nextSettings)
      settings = await loadSettings()
      renderStatus(settings)
      await openExternalConfigIfNeeded(settings)
    } catch (err) {
      setSourceLanguageValue(settings.sourceLang)
      setTargetLanguageValue(settings.targetLang)
      displayModeSelect.value = settings.translationDisplayMode
      pageEngineSelect.value = settings.pageTranslationEngine
      const error = el<HTMLElement>('error')
      error.hidden = false
      error.textContent = err instanceof Error ? err.message : String(err)
    }
  }

  sourceLangSelect.addEventListener('change', () => {
    void saveLanguageSetting({ sourceLang: sourceLangSelect.value || 'auto' })
  })

  targetLangSelect.addEventListener('change', () => {
    void saveLanguageSetting({ targetLang: targetLangSelect.value || DEFAULT_SETTINGS.targetLang })
  })

  displayModeSelect.addEventListener('change', () => {
    void saveLanguageSetting({
      translationDisplayMode: displayModeSelect.value as TranslationDisplayMode,
    })
  })

  configureCloudModel.addEventListener('click', () => {
    void chrome.runtime.openOptionsPage()
  })

  pageEngineSelect.addEventListener('change', () => {
    void saveLanguageSetting({
      pageTranslationEngine: pageEngineSelect.value as TranslationEngine,
    })
  })
}

void init()
