import {
  DEFAULT_SETTINGS,
  apiBaseUrlError,
  loadSettings,
  saveSettings,
  isConfigured,
  missingConfigFields,
  type TranslationEngine,
  type TranslationDisplayMode,
  type UserSettings,
} from '../shared/settings'
import {
  PROVIDER_PRESETS,
  type ProviderId,
  type ReasoningPref,
} from '../shared/providers'
import { browserLanguageCode, LANGUAGE_OPTIONS } from '../shared/languages'
import {
  BrowserTranslator,
  type BrowserTranslatorAvailability,
} from '../content/browser-translator'
import type { TestConnectionResult } from '../shared/messages'

const browserTranslator = new BrowserTranslator()
let browserCapability: BrowserTranslatorAvailability = 'unsupported'
let capabilityRequest = 0
let remoteModelCandidates: string[] = []

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node as T
}

function parsePausedHostnames(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function populateLanguageSelects(): void {
  const select = el<HTMLSelectElement>('targetLang')
  select.replaceChildren(
    ...LANGUAGE_OPTIONS.map(([code, name]) => {
      const option = document.createElement('option')
      option.value = code
      option.textContent = `${name} · ${code}`
      return option
    }),
  )
}

function setLanguageValue(id: 'targetLang', value: string): void {
  const select = el<HTMLSelectElement>(id)
  if (![...select.options].some((option) => option.value === value)) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = `Custom · ${value}`
    select.append(option)
  }
  select.value = value
}

function currentProviderPreset(provider: string): (typeof PROVIDER_PRESETS)[number] {
  return PROVIDER_PRESETS.find((preset) => preset.id === provider) ?? PROVIDER_PRESETS[0]
}

function updateModelCandidates(settings: UserSettings, extraModels = remoteModelCandidates): void {
  const preset = currentProviderPreset(settings.provider)
  const candidates = [
    settings.model,
    preset.modelHint,
    ...preset.modelCandidates,
    ...extraModels,
  ]
    .map((model) => model.trim())
    .filter(Boolean)
  const unique = [...new Set(candidates)].slice(0, 80)
  const datalist = el<HTMLDataListElement>('modelCandidates')
  datalist.replaceChildren(
    ...unique.map((model) => {
      const option = document.createElement('option')
      option.value = model
      return option
    }),
  )
}

function syncTranslationEngineAvailability(settings: UserSettings): void {
  const select = el<HTMLSelectElement>('pageTranslationEngine')
  const externalOption = select.querySelector<HTMLOptionElement>('option[value="external"]')
  const configured = isConfigured(settings)
  if (externalOption) externalOption.disabled = !configured
  if (!configured && select.value === 'external') select.value = 'browser'
}

function fillForm(s: UserSettings): void {
  el<HTMLSelectElement>('provider').value = s.provider
  el<HTMLInputElement>('baseURL').value = s.baseURL
  el<HTMLInputElement>('apiKey').value = s.apiKey
  el<HTMLInputElement>('apiKey').placeholder = s.apiKey
    ? 'Saved (leave blank when saving to keep the current key)'
    : 'sk-... or provider key'
  el<HTMLInputElement>('model').value = s.model
  el<HTMLSelectElement>('reasoningPref').value = s.reasoningPref
  setLanguageValue('targetLang', s.targetLang)
  el<HTMLSelectElement>('pageTranslationEngine').value = s.pageTranslationEngine
  el<HTMLSelectElement>('translationDisplayMode').value = s.translationDisplayMode
  el<HTMLInputElement>('autoPageTranslation').checked = s.autoPageTranslation
  el<HTMLInputElement>('pageTranslationFontSizePx').value = String(
    s.pageTranslationFontSizePx,
  )
  el<HTMLInputElement>('pageTranslationUseCustomColor').checked =
    s.pageTranslationUseCustomColor
  el<HTMLInputElement>('pageTranslationTextColor').value = s.pageTranslationTextColor
  el<HTMLInputElement>('pageTranslationUseBackground').checked =
    s.pageTranslationUseBackground
  el<HTMLInputElement>('pageTranslationBackgroundColor').value =
    s.pageTranslationBackgroundColor
  el<HTMLInputElement>('pageTranslationBold').checked = s.pageTranslationBold
  el<HTMLInputElement>('pageTranslationItalic').checked = s.pageTranslationItalic
  el<HTMLInputElement>('pageTranslationUnderline').checked = s.pageTranslationUnderline
  el<HTMLInputElement>('pausedHostnames').value = s.pausedHostnames.join(', ')
  updateModelCandidates(s, [])
  syncTranslationEngineAvailability(s)
  updateConfigBadge(s)
  updateProviderHint(s.provider)
  updateStyleControlStates()
  updateEngineSummary(readForm(s))
}

function readForm(stored: UserSettings): UserSettings {
  const typedKey = el<HTMLInputElement>('apiKey').value
  const apiKey = typedKey.trim() ? typedKey : stored.apiKey
  const provider = el<HTMLSelectElement>('provider').value as ProviderId
  const reasoningPref = el<HTMLSelectElement>('reasoningPref').value as ReasoningPref

  return {
    ...stored,
    provider,
    reasoningPref,
    baseURL: el<HTMLInputElement>('baseURL').value.trim(),
    apiKey,
    model: el<HTMLInputElement>('model').value.trim(),
    targetLang: el<HTMLSelectElement>('targetLang').value || DEFAULT_SETTINGS.targetLang,
    pageTranslationEngine: el<HTMLSelectElement>('pageTranslationEngine')
      .value as TranslationEngine,
    translationDisplayMode: el<HTMLSelectElement>('translationDisplayMode')
      .value as TranslationDisplayMode,
    autoPageTranslation: el<HTMLInputElement>('autoPageTranslation').checked,
    pageTranslationFontSizePx: Number(
      el<HTMLInputElement>('pageTranslationFontSizePx').value,
    ),
    pageTranslationUseCustomColor: el<HTMLInputElement>('pageTranslationUseCustomColor').checked,
    pageTranslationTextColor: el<HTMLInputElement>('pageTranslationTextColor').value,
    pageTranslationUseBackground: el<HTMLInputElement>('pageTranslationUseBackground').checked,
    pageTranslationBackgroundColor: el<HTMLInputElement>('pageTranslationBackgroundColor').value,
    pageTranslationBold: el<HTMLInputElement>('pageTranslationBold').checked,
    pageTranslationItalic: el<HTMLInputElement>('pageTranslationItalic').checked,
    pageTranslationUnderline: el<HTMLInputElement>('pageTranslationUnderline').checked,
    pausedHostnames: parsePausedHostnames(el<HTMLInputElement>('pausedHostnames').value),
  }
}

function setStatus(text: string, ok = true): void {
  const node = el<HTMLElement>('status')
  node.textContent = text
  node.classList.toggle('status-error', !ok)
}

function setCloudConnectionStatus(
  text: string,
  state: 'ok' | 'warn' | 'testing' | 'error',
): void {
  const wrapper = el<HTMLElement>('cloudConnectionStatus')
  const label = el<HTMLElement>('configBadge')
  wrapper.className = `connection-status ${state}`
  label.textContent = text
}

function setModelFetchStatus(text: string, state: 'idle' | 'loading' | 'ok' | 'error' = 'idle'): void {
  const node = el<HTMLElement>('modelFetchStatus')
  node.textContent = text
  node.dataset.state = state === 'idle' ? '' : state
}

function isTestConnectionResult(value: unknown): value is TestConnectionResult {
  if (!value || typeof value !== 'object') return false
  const result = value as { type?: unknown; ok?: unknown; error?: unknown }
  if (result.type !== 'test-connection-result') return false
  return result.ok === true || (result.ok === false && typeof result.error === 'string')
}

/** Probe the currently entered endpoint/model/key (may be unsaved) via the background. */
async function runConnectionTest(settings: UserSettings): Promise<void> {
  const button = el<HTMLButtonElement>('testConnection')
  button.disabled = true
  setCloudConnectionStatus('Testing...', 'testing')
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: 'test-connection',
      baseURL: settings.baseURL,
      apiKey: settings.apiKey,
      model: settings.model,
      provider: settings.provider,
      reasoningPref: settings.reasoningPref,
    })
    if (isTestConnectionResult(response) && response.ok) {
      setCloudConnectionStatus('Connected', 'ok')
    } else {
      const error = isTestConnectionResult(response) && !response.ok ? response.error : 'Unknown error'
      setCloudConnectionStatus(`Failed: ${error}`, 'error')
    }
  } catch (err) {
    setCloudConnectionStatus(
      `Failed: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    )
  } finally {
    button.disabled = false
  }
}

function updateConfigBadge(s: UserSettings): void {
  if (isConfigured(s)) {
    setCloudConnectionStatus('Configured', 'ok')
  } else {
    setCloudConnectionStatus('Setup required', 'warn')
  }
}

async function normalizeUnavailableEngine(settings: UserSettings): Promise<UserSettings> {
  if (settings.pageTranslationEngine !== 'external' || isConfigured(settings)) return settings
  await saveSettings({ ...settings, pageTranslationEngine: 'browser' })
  return loadSettings()
}

function updateProviderHint(provider: string): void {
  const hint = el<HTMLElement>('providerHint')
  if (provider === 'infron') {
    hint.textContent = 'Recommended default. Base URL: https://llm.onerouter.pro/v1'
  } else if (provider === 'openrouter') {
    hint.textContent = 'Use OpenRouter models. Base URL: https://openrouter.ai/api/v1'
  } else {
    hint.textContent = 'Use any OpenAI-compatible endpoint.'
  }
}

function modelsEndpoint(baseURL: string): string {
  const url = new URL(baseURL)
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models`
  url.search = ''
  url.hash = ''
  return url.toString()
}

function parseModelList(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  const list = Array.isArray(data) ? data : Array.isArray(payload) ? payload : []
  return list
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
        return item.id
      }
      return ''
    })
    .map((model) => model.trim())
    .filter(Boolean)
}

async function fetchModels(settings: UserSettings): Promise<void> {
  const button = el<HTMLButtonElement>('fetchModels')
  const baseURL = settings.baseURL.trim()
  const baseError = apiBaseUrlError(baseURL)
  if (!baseURL || baseError) {
    setModelFetchStatus(baseError || 'Enter a Base URL first.', 'error')
    return
  }
  button.disabled = true
  setModelFetchStatus('Loading models...', 'loading')
  try {
    const response = await fetch(modelsEndpoint(baseURL), {
      headers: settings.apiKey.trim()
        ? { Authorization: `Bearer ${settings.apiKey.trim()}` }
        : undefined,
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const models = parseModelList(await response.json())
    if (!models.length) throw new Error('No models found')
    remoteModelCandidates = models
    updateModelCandidates(readForm(settings), models)
    setModelFetchStatus(`${models.length} models loaded.`, 'ok')
  } catch (error) {
    setModelFetchStatus(
      `Model list unavailable: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    )
  } finally {
    button.disabled = false
  }
}

function updateStyleControlStates(): void {
  el<HTMLInputElement>('pageTranslationTextColor').disabled =
    !el<HTMLInputElement>('pageTranslationUseCustomColor').checked
  el<HTMLInputElement>('pageTranslationBackgroundColor').disabled =
    !el<HTMLInputElement>('pageTranslationUseBackground').checked
}

function updateEngineSummary(settings: UserSettings): void {
  const page = settings.pageTranslationEngine === 'browser' ? 'Chrome built-in' : 'Cloud Model'
  el<HTMLElement>('engineSummary').textContent = `Engine: ${page}`
}

function browserVersion(): string {
  return navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/u)?.[1] ?? 'unknown'
}

function renderBrowserCapability(
  availability: BrowserTranslatorAvailability | 'checking' | 'error',
  detail?: string,
): void {
  const panel = el<HTMLElement>('browserCapability')
  const title = el<HTMLElement>('browserCapabilityTitle')
  const description = el<HTMLElement>('browserCapabilityDescription')
  const action = el<HTMLButtonElement>('browserCapabilityAction')
  panel.dataset.state = availability
  action.hidden = availability === 'checking'
  action.disabled = availability === 'checking'

  const content = {
    checking: ['Checking Chrome translation', 'Checking this language pair.'],
    available: ['Chrome translation is ready', 'This language pair can translate on device.'],
    downloadable: ['Language pack required', 'Download it before using Chrome translation.'],
    downloading: ['Downloading language pack', detail || 'Keep this page open.'],
    unavailable: ['Language pair unavailable', 'Choose another target language or use Cloud Model.'],
    unsupported: [
      'Chrome Translator API unavailable',
      `Detected Chrome/Chromium ${browserVersion()}. Use desktop Chrome 138+ for built-in translation.`,
    ],
    error: ['Check failed', detail || 'Try again or switch to Cloud Model.'],
  } as const
  title.textContent = content[availability][0]
  description.textContent = detail || content[availability][1]
  action.textContent =
    availability === 'downloadable' || availability === 'downloading' ? 'Download' : 'Retry'
}

async function checkBrowserCapability(prepare = false): Promise<void> {
  const request = ++capabilityRequest
  const target = browserLanguageCode(
    el<HTMLSelectElement>('targetLang').value || DEFAULT_SETTINGS.targetLang,
  )
  renderBrowserCapability('checking')
  try {
    browserCapability = await browserTranslator.availability('en', target)
    if (request !== capabilityRequest) return
    if (prepare && (browserCapability === 'downloadable' || browserCapability === 'downloading')) {
      renderBrowserCapability('downloading', 'Preparing language pack...')
      const ready = await browserTranslator.prepare('en', target, (progress) => {
        if (request !== capabilityRequest) return
        renderBrowserCapability('downloading', `Downloaded ${Math.round(progress * 100)}%`)
      })
      if (request !== capabilityRequest) return
      browserCapability = ready ? 'available' : 'unavailable'
    }
    renderBrowserCapability(browserCapability)
  } catch (error) {
    if (request !== capabilityRequest) return
    renderBrowserCapability('error', error instanceof Error ? error.message : String(error))
  }
}

function applyProviderPreset(id: string): void {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id)
  if (!preset) return
  const base = el<HTMLInputElement>('baseURL')
  const model = el<HTMLInputElement>('model')
  // Only fill empty or previous default-looking fields
  if (!base.value.trim() || /openai\.com|onerouter\.pro|openrouter\.ai/i.test(base.value)) {
    base.value = preset.baseURL
  }
  if (!model.value.trim() || /gpt-4o-mini|deepseek\/deepseek|openai\/gpt/i.test(model.value)) {
    model.value = preset.modelHint
  }
  remoteModelCandidates = []
  updateModelCandidates(readForm(DEFAULT_SETTINGS), [])
  setModelFetchStatus('')
}

function setupSectionNavigation(): void {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.section-nav a')]
  const sections = links
    .map((link) => document.querySelector<HTMLElement>(link.hash))
    .filter((section): section is HTMLElement => Boolean(section))
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0]
      if (!visible) return
      for (const link of links) link.classList.toggle('active', link.hash === `#${visible.target.id}`)
    },
    { rootMargin: '-20% 0px -65% 0px', threshold: [0, 0.2, 0.6] },
  )
  for (const section of sections) observer.observe(section)
}

async function init(): Promise<void> {
  populateLanguageSelects()
  let stored = await normalizeUnavailableEngine(await loadSettings())
  fillForm(stored)
  void checkBrowserCapability()
  setupSectionNavigation()
  el<HTMLInputElement>('pageTranslationUseCustomColor').addEventListener(
    'change',
    updateStyleControlStates,
  )
  el<HTMLInputElement>('pageTranslationUseBackground').addEventListener(
    'change',
    updateStyleControlStates,
  )
  el<HTMLButtonElement>('browserCapabilityAction').addEventListener('click', () => {
    void checkBrowserCapability(
      browserCapability === 'downloadable' || browserCapability === 'downloading',
    )
  })
  el<HTMLSelectElement>('targetLang').addEventListener('change', () => void checkBrowserCapability())
  for (const id of ['pageTranslationEngine']) {
    el<HTMLSelectElement>(id).addEventListener('change', () => {
      const next = readForm(stored)
      if (next.pageTranslationEngine === 'external' && !isConfigured(next)) {
        el<HTMLSelectElement>('pageTranslationEngine').value = 'browser'
        setStatus('Complete Cloud Model setup before selecting it.', false)
      }
      updateEngineSummary(readForm(stored))
    })
  }

  for (const id of ['baseURL', 'apiKey', 'model']) {
    el<HTMLInputElement>(id).addEventListener('input', () => {
      const next = readForm(stored)
      syncTranslationEngineAvailability(next)
      updateConfigBadge(next)
      updateModelCandidates(next)
      updateEngineSummary(readForm(stored))
    })
  }

  el<HTMLSelectElement>('provider').addEventListener('change', () => {
    const v = el<HTMLSelectElement>('provider').value
    updateProviderHint(v)
    applyProviderPreset(v)
    const next = readForm(stored)
    syncTranslationEngineAvailability(next)
    updateConfigBadge(next)
    updateEngineSummary(next)
  })

  el<HTMLButtonElement>('fetchModels').addEventListener('click', () => {
    void fetchModels(readForm(stored))
  })

  el<HTMLButtonElement>('toggleApiKey').addEventListener('click', () => {
    const input = el<HTMLInputElement>('apiKey')
    const button = el<HTMLButtonElement>('toggleApiKey')
    const visible = input.type === 'text'
    input.type = visible ? 'password' : 'text'
    button.textContent = visible ? 'Show' : 'Hide'
  })

  el<HTMLFormElement>('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      const next = readForm(stored)
      const usesExternal = next.pageTranslationEngine === 'external'
      const missing = usesExternal ? missingConfigFields(next) : []
      if (missing.length) {
        el<HTMLSelectElement>('pageTranslationEngine').value = 'browser'
        syncTranslationEngineAvailability(readForm(stored))
        updateEngineSummary(readForm(stored))
        setStatus(`Complete Cloud Model setup: add ${missing.join(', ')}.`, false)
        return
      }
      await saveSettings(next)
      stored = await loadSettings()
      fillForm(stored)
      const usesBrowser = stored.pageTranslationEngine === 'browser'
      if (usesBrowser && (browserCapability === 'unsupported' || browserCapability === 'unavailable')) {
        setStatus('Saved. Chrome translation is unavailable for this language pair.', false)
      } else if (
        usesBrowser &&
        (browserCapability === 'downloadable' || browserCapability === 'downloading')
      ) {
        setStatus('Saved. Download the Chrome language pack before auto-translation.', false)
      } else if (isConfigured(stored)) {
        setStatus('Saved. Open pages are synced.', true)
      } else if (!usesExternal) {
        setStatus('Saved. Chrome translation is ready.', true)
      } else {
        setStatus('Saved, but Cloud Model still needs a valid API key.', false)
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), false)
    }
  })

  el<HTMLButtonElement>('testConnection').addEventListener('click', () => {
    void runConnectionTest(readForm(stored))
  })

  el<HTMLButtonElement>('reset').addEventListener('click', async () => {
    if (!confirm('Reset defaults? This will clear the API Key.')) return
    await saveSettings({ ...DEFAULT_SETTINGS })
    location.reload()
  })
}

void init()
