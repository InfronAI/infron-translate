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
import { uiText } from '../shared/i18n'

const browserTranslator = new BrowserTranslator()
let browserCapability: BrowserTranslatorAvailability = 'unsupported'
let capabilityRequest = 0
let remoteModelCandidates: string[] = []

const OPTIONS_COPY = {
  zh: {
    pageTitle: 'Infron Translate 设置',
    loadingSettings: '正在加载设置',
    navTranslation: '基础偏好',
    navPageMode: '网页翻译',
    navChrome: 'Chrome 内置翻译',
    navCloud: '云端翻译模型',
    navAsr: '会议转录',
    navRules: '网站规则',
    privacyTitle: '隐私',
    privacyText: '网页翻译和会议转录使用不同凭证；音频只会发送到你配置的 ASR 端点。',
    preferences: '偏好设置',
    settings: '设置',
    help: '配置网页翻译、会议转录、模型凭证和站点规则。',
    translationTitle: '基础偏好',
    translationHelp: '设置界面语言和默认译文语言。',
    targetTitle: '目标语言',
    targetHelp: '源语言会按页面自动检测。请选择默认输出语言。',
    uiHelp: '选择扩展页面和网页内控件使用的语言。',
    pageModeTitle: '网页翻译',
    pageModeHelp: '配置整页翻译的启动方式、展示模式和译文样式。',
    engineHelp: '选择网页翻译使用 Chrome 内置翻译还是云端翻译模型。',
    autoTitle: '自动网页翻译',
    global: '全局',
    autoHelp: '自动翻译支持的网页，也可以在插件弹框中手动控制。',
    privacyWarn: 'Cloud Model 会把匹配到的网页文本发送到你配置的模型端点。',
    enabled: '已启用',
    displayHelp: '同时显示原文和译文，或直接用译文替换原文。',
    styleTitle: '网页译文样式',
    styleHelp: '调整插入网页的译文字号、颜色和格式。',
    fontSize: '字号',
    customColor: '自定义文字颜色',
    backgroundColor: '显示背景色',
    textFormatting: '文字格式',
    bold: '加粗',
    italic: '斜体',
    underline: '下划线',
    translationTextColor: '译文文字颜色',
    translationBackgroundColor: '译文背景颜色',
    chromeTitle: 'Chrome 内置翻译',
    chromeHelp: '检查 Chrome 是否支持从英语翻译到你的目标语言。',
    checkingChromeTitle: '正在检查 Chrome 翻译',
    checkingChromeDescription: '正在检查当前语言对。',
    chromeReadyTitle: 'Chrome 翻译已就绪',
    chromeReadyDescription: '当前语言对可以在设备本地翻译。',
    languagePackTitle: '需要语言包',
    languagePackDescription: '请先下载语言包，再使用 Chrome 翻译。',
    downloadingPackTitle: '正在下载语言包',
    downloadingPackDescription: '请保持此页面打开。',
    pairUnavailableTitle: '当前语言对不可用',
    pairUnavailableDescription: '请选择其他目标语言，或改用 Cloud Model。',
    translatorApiUnavailableTitle: 'Chrome Translator API 不可用',
    translatorApiUnavailableDescription: '检测到 Chrome/Chromium {version}。内置翻译需要桌面版 Chrome 138+。',
    checkFailedTitle: '检查失败',
    checkFailedDescription: '请重试，或切换到 Cloud Model。',
    checkAgain: '重新检查',
    download: '下载',
    retry: '重试',
    preparingLanguagePack: '正在准备语言包...',
    downloadedPercent: '已下载 {percent}%',
    factChromeTitle: 'Chrome 138+',
    factChromeText: '需要桌面版 Chrome',
    factPackTitle: '语言包',
    factPackText: '部分语言对需要下载',
    factDeviceTitle: '设备本地',
    factDeviceText: '不会请求外部模型',
    cloudTitle: '云端翻译模型',
    cloudHelp: '仅当网页翻译引擎选择 Cloud Model 时使用。',
    test: '测试',
    testing: '测试中...',
    connected: '已连通',
    failed: '失败：{error}',
    unknownError: '未知错误',
    provider: '服务商',
    providerHelp: '选择网页翻译模型服务商，然后确认端点和模型。',
    infronHint: '推荐默认选项。基础 URL: https://llm.onerouter.pro/v1',
    openrouterHint: '使用 OpenRouter 模型。基础 URL: https://openrouter.ai/api/v1',
    openaiHint: '使用任意 OpenAI 兼容端点。',
    endpoint: '模型端点',
    endpointHelp: '网页翻译模型端点。远程端点需使用 HTTPS，本地 localhost HTTP 可用。',
    baseUrl: '基础 URL',
    model: '模型',
    models: '模型',
    apiKey: '模型 API Key',
    apiKeyHelp: '仅用于 Cloud Model 网页翻译。保存时留空会保留已保存的密钥。',
    savedKeyPlaceholder: '已保存（保存时留空会保留当前密钥）',
    apiKeyPlaceholder: 'sk-... 或服务商密钥',
    modelPlaceholder: 'deepseek/deepseek-v3.2',
    enterBaseUrlFirst: '请先填写基础 URL。',
    loadingModels: '正在加载模型...',
    noModelsFound: '没有找到模型',
    modelsLoaded: '已加载 {count} 个模型。',
    modelListUnavailable: '模型列表不可用：{error}',
    show: '显示',
    hide: '隐藏',
    reasoning: '推理强度',
    reasoningHelp: '较低推理强度通常能提升翻译速度。',
    asrTitle: '会议转录',
    asrHelp: '配置会议助手实时音频转录使用的 ASR WebSocket 连接。',
    asrEndpoint: 'WebSocket 连接',
    asrEndpointHelp: '用于实时全双工音频转录的 WebSocket 地址，默认使用 StepFun ASR Stream。',
    asrEndpointLabel: 'WebSocket',
    asrModel: '转录模型',
    asrModelHelp: '用于实时 ASR 的模型，默认使用 StepFun 推荐的 stream 模型。',
    asrApiKey: '转录 API Key',
    asrApiKeyHelp: '仅用于会议助手音频转录。保存时留空会保留已保存的密钥。',
    asrApiKeyPlaceholder: 'StepFun API Key',
    offLowest: '关闭 / 最低',
    low: '低',
    medium: '中',
    high: '高',
    rulesTitle: '网站规则',
    rulesHelp: '管理不应自动启动网页翻译的网站。',
    pausedSites: '暂停网站',
    pausedHelp: '使用英文逗号分隔域名，也可在扩展弹框中暂停当前网站。',
    pausedPlaceholder: 'example.com, news.ycombinator.com',
    completeCloudBeforeSelect: '请先完成云端翻译模型配置，再选择它。',
    completeCloudSetupAdd: '请完成云端翻译模型配置：补充 {fields}。',
    savedDownloadPack: '已保存。自动翻译前请先下载 Chrome 语言包。',
    savedCloudNeedsKey: '已保存，但云端翻译模型仍需要有效的 API Key。',
    resetConfirm: '恢复默认设置？这会清除 API 密钥。',
    baseUrlInvalid: 'Base URL 无效',
    baseUrlNoCredentials: '基础 URL 不能包含用户名或密码',
    baseUrlHttpsRequired: '远程基础 URL 必须使用 HTTPS',
    reset: '恢复默认',
    save: '保存设置',
  },
  en: {
    pageTitle: 'Infron Translate Settings',
    loadingSettings: 'Loading settings',
    navTranslation: 'General',
    navPageMode: 'Webpage Translation',
    navChrome: 'Chrome Translation',
    navCloud: 'Cloud Translation Model',
    navAsr: 'Meeting Transcription',
    navRules: 'Site rules',
    privacyTitle: 'Privacy',
    privacyText: 'Webpage translation and meeting transcription use separate credentials. Audio is sent only to your configured ASR endpoint.',
    preferences: 'PREFERENCES',
    settings: 'Settings',
    help: 'Configure webpage translation, meeting transcription, model credentials, and site rules.',
    translationTitle: 'General',
    translationHelp: 'Set the interface language and default translation target.',
    targetTitle: 'Target language',
    targetHelp: 'Source is detected per page. Choose the default output language.',
    uiHelp: 'Choose the language used by extension pages and in-page controls.',
    pageModeTitle: 'Webpage Translation',
    pageModeHelp: 'Configure full-page translation startup, display, and text styling.',
    engineHelp: 'Choose whether webpage translation uses Chrome built-in translation or a cloud model.',
    autoTitle: 'Auto-translate webpages',
    global: 'Global',
    autoHelp: 'Translate supported webpages automatically, or control it manually from the popup.',
    privacyWarn: 'Cloud Model sends matched webpage text to your configured model endpoint.',
    enabled: 'Enabled',
    displayHelp: 'Show source and translation together, or replace source text in place.',
    styleTitle: 'Webpage translation style',
    styleHelp: 'Adjust the appearance of translations inserted into webpages.',
    fontSize: 'Font size',
    customColor: 'Custom text color',
    backgroundColor: 'Show background color',
    textFormatting: 'Text formatting',
    bold: 'Bold',
    italic: 'Italic',
    underline: 'Underline',
    translationTextColor: 'Translation text color',
    translationBackgroundColor: 'Translation background color',
    chromeTitle: 'Chrome Built-in Translation',
    chromeHelp: 'Check whether Chrome supports English to your target language.',
    checkingChromeTitle: 'Checking Chrome translation',
    checkingChromeDescription: 'Checking the current language pair.',
    chromeReadyTitle: 'Chrome translation is ready',
    chromeReadyDescription: 'This language pair can translate on device.',
    languagePackTitle: 'Language pack required',
    languagePackDescription: 'Download it before using Chrome translation.',
    downloadingPackTitle: 'Downloading language pack',
    downloadingPackDescription: 'Keep this page open.',
    pairUnavailableTitle: 'Language pair unavailable',
    pairUnavailableDescription: 'Choose another target language or use Cloud Model.',
    translatorApiUnavailableTitle: 'Chrome Translator API unavailable',
    translatorApiUnavailableDescription: 'Detected Chrome/Chromium {version}. Use desktop Chrome 138+ for built-in translation.',
    checkFailedTitle: 'Check failed',
    checkFailedDescription: 'Try again or switch to Cloud Model.',
    checkAgain: 'Check again',
    download: 'Download',
    retry: 'Retry',
    preparingLanguagePack: 'Preparing language pack...',
    downloadedPercent: 'Downloaded {percent}%',
    factChromeTitle: 'Chrome 138+',
    factChromeText: 'Desktop Chrome required',
    factPackTitle: 'Language packs',
    factPackText: 'Some pairs require a download',
    factDeviceTitle: 'On device',
    factDeviceText: 'No external model request',
    cloudTitle: 'Cloud Translation Model',
    cloudHelp: 'Used only when Webpage Translation engine is set to Cloud Model.',
    test: 'Test',
    testing: 'Testing...',
    connected: 'Connected',
    failed: 'Failed: {error}',
    unknownError: 'Unknown error',
    provider: 'Provider',
    providerHelp: 'Choose a webpage translation model provider, then confirm the endpoint and model.',
    infronHint: 'Recommended default. Base URL: https://llm.onerouter.pro/v1',
    openrouterHint: 'Use OpenRouter models. Base URL: https://openrouter.ai/api/v1',
    openaiHint: 'Use any OpenAI-compatible endpoint.',
    endpoint: 'Model endpoint',
    endpointHelp: 'Endpoint for webpage translation models. Remote endpoints require HTTPS; localhost HTTP is allowed.',
    baseUrl: 'Base URL',
    model: 'Model',
    models: 'Models',
    apiKey: 'Model API Key',
    apiKeyHelp: 'Used only for Cloud Model webpage translation. Leave blank when saving to keep the saved key.',
    savedKeyPlaceholder: 'Saved (leave blank when saving to keep the current key)',
    apiKeyPlaceholder: 'sk-... or provider key',
    modelPlaceholder: 'deepseek/deepseek-v3.2',
    enterBaseUrlFirst: 'Enter a Base URL first.',
    loadingModels: 'Loading models...',
    noModelsFound: 'No models found',
    modelsLoaded: '{count} models loaded.',
    modelListUnavailable: 'Model list unavailable: {error}',
    show: 'Show',
    hide: 'Hide',
    reasoning: 'Reasoning effort',
    reasoningHelp: 'Lower reasoning usually improves translation speed.',
    asrTitle: 'Meeting Transcription',
    asrHelp: 'Configure the ASR WebSocket connection used by Meeting Assistant live audio transcription.',
    asrEndpoint: 'WebSocket Connection',
    asrEndpointHelp: 'WebSocket URL for realtime full-duplex audio transcription. StepFun ASR Stream is used by default.',
    asrEndpointLabel: 'WebSocket',
    asrModel: 'Transcription Model',
    asrModelHelp: 'Model used for realtime ASR. The recommended StepFun stream model is used by default.',
    asrApiKey: 'Transcription API Key',
    asrApiKeyHelp: 'Used only for Meeting Assistant audio transcription. Leave blank when saving to keep the saved key.',
    asrApiKeyPlaceholder: 'StepFun API Key',
    offLowest: 'Off / lowest',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    rulesTitle: 'Site Rules',
    rulesHelp: 'Manage sites where automatic webpage translation should stay off.',
    pausedSites: 'Paused sites',
    pausedHelp: 'Use comma-separated hostnames, or pause the current site from the popup.',
    pausedPlaceholder: 'example.com, news.ycombinator.com',
    completeCloudBeforeSelect: 'Complete Cloud Translation Model setup before selecting it.',
    completeCloudSetupAdd: 'Complete Cloud Translation Model setup: add {fields}.',
    savedDownloadPack: 'Saved. Download the Chrome language pack before auto-translation.',
    savedCloudNeedsKey: 'Saved, but Cloud Translation Model still needs a valid API key.',
    resetConfirm: 'Reset defaults? This will clear the API Key.',
    baseUrlInvalid: 'Base URL is invalid',
    baseUrlNoCredentials: 'Base URL must not include a username or password',
    baseUrlHttpsRequired: 'Remote Base URL must use HTTPS',
    reset: 'Reset defaults',
    save: 'Save settings',
  },
} as const

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
    option.textContent = `${uiText(currentUiLanguage(), 'customLanguage')} · ${value}`
    select.append(option)
  }
  select.value = value
}

function currentUiLanguage(): UserSettings['uiLanguage'] {
  const select = document.getElementById('uiLanguage') as HTMLSelectElement | null
  return select?.value === 'en' ? 'en' : 'zh'
}

function optionsCopy(): (typeof OPTIONS_COPY)[UserSettings['uiLanguage']] {
  return OPTIONS_COPY[currentUiLanguage()]
}

function localizedBaseUrlError(error: string | null): string | null {
  if (!error) return null
  const copy = optionsCopy()
  if (error === 'Base URL is invalid') return copy.baseUrlInvalid
  if (error === 'Base URL must not include a username or password') return copy.baseUrlNoCredentials
  if (error === 'Remote Base URL must use HTTPS') return copy.baseUrlHttpsRequired
  return error
}

function localizedMissingFields(fields: string[]): string[] {
  const copy = optionsCopy()
  return fields.map((field) => {
    if (field === 'Base URL') return copy.baseUrl
    if (field === 'API Key') return copy.apiKey
    if (field === 'Model') return copy.model
    return localizedBaseUrlError(field) ?? field
  })
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
  el<HTMLSelectElement>('uiLanguage').value = s.uiLanguage
  el<HTMLSelectElement>('provider').value = s.provider
  el<HTMLInputElement>('baseURL').value = s.baseURL
  el<HTMLInputElement>('apiKey').value = s.apiKey
  el<HTMLInputElement>('apiKey').placeholder = s.apiKey
    ? OPTIONS_COPY[s.uiLanguage].savedKeyPlaceholder
    : OPTIONS_COPY[s.uiLanguage].apiKeyPlaceholder
  el<HTMLInputElement>('model').value = s.model
  el<HTMLInputElement>('asrEndpoint').value = s.asrEndpoint
  el<HTMLInputElement>('asrModel').value = s.asrModel
  el<HTMLInputElement>('asrApiKey').value = s.asrApiKey
  el<HTMLInputElement>('asrApiKey').placeholder = s.asrApiKey
    ? OPTIONS_COPY[s.uiLanguage].savedKeyPlaceholder
    : OPTIONS_COPY[s.uiLanguage].asrApiKeyPlaceholder
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
  applyStaticI18n(s)
  updateProviderHint(s.provider)
  updateStyleControlStates()
  updateEngineSummary(readForm(s))
}

function readForm(stored: UserSettings): UserSettings {
  const typedKey = el<HTMLInputElement>('apiKey').value
  const apiKey = typedKey.trim() ? typedKey : stored.apiKey
  const typedAsrKey = el<HTMLInputElement>('asrApiKey').value
  const asrApiKey = typedAsrKey.trim() ? typedAsrKey : stored.asrApiKey
  const provider = el<HTMLSelectElement>('provider').value as ProviderId
  const reasoningPref = el<HTMLSelectElement>('reasoningPref').value as ReasoningPref

  return {
    ...stored,
    provider,
    reasoningPref,
    baseURL: el<HTMLInputElement>('baseURL').value.trim(),
    apiKey,
    model: el<HTMLInputElement>('model').value.trim(),
    asrEndpoint:
      el<HTMLInputElement>('asrEndpoint').value.trim() || DEFAULT_SETTINGS.asrEndpoint,
    asrModel: el<HTMLInputElement>('asrModel').value.trim() || DEFAULT_SETTINGS.asrModel,
    asrApiKey,
    uiLanguage: el<HTMLSelectElement>('uiLanguage').value as UserSettings['uiLanguage'],
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
  const copy = OPTIONS_COPY[settings.uiLanguage]
  button.disabled = true
  setCloudConnectionStatus(copy.testing, 'testing')
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
      setCloudConnectionStatus(copy.connected, 'ok')
    } else {
      const error = isTestConnectionResult(response) && !response.ok ? response.error : copy.unknownError
      setCloudConnectionStatus(copy.failed.replace('{error}', error), 'error')
    }
  } catch (err) {
    setCloudConnectionStatus(
      copy.failed.replace('{error}', err instanceof Error ? err.message : String(err)),
      'error',
    )
  } finally {
    button.disabled = false
  }
}

function updateConfigBadge(s: UserSettings): void {
  if (isConfigured(s)) {
    setCloudConnectionStatus(uiText(s.uiLanguage, 'configured'), 'ok')
  } else {
    setCloudConnectionStatus(uiText(s.uiLanguage, 'setupRequired'), 'warn')
  }
}

async function normalizeUnavailableEngine(settings: UserSettings): Promise<UserSettings> {
  if (settings.pageTranslationEngine !== 'external' || isConfigured(settings)) return settings
  await saveSettings({ ...settings, pageTranslationEngine: 'browser' })
  return loadSettings()
}

function updateProviderHint(provider: string): void {
  const hint = el<HTMLElement>('providerHint')
  const copy = optionsCopy()
  if (provider === 'infron') {
    hint.textContent = copy.infronHint
  } else if (provider === 'openrouter') {
    hint.textContent = copy.openrouterHint
  } else {
    hint.textContent = copy.openaiHint
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
  const copy = OPTIONS_COPY[settings.uiLanguage]
  if (!baseURL || baseError) {
    setModelFetchStatus(localizedBaseUrlError(baseError) || copy.enterBaseUrlFirst, 'error')
    return
  }
  button.disabled = true
  setModelFetchStatus(copy.loadingModels, 'loading')
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
    if (!models.length) throw new Error(copy.noModelsFound)
    remoteModelCandidates = models
    updateModelCandidates(readForm(settings), models)
    setModelFetchStatus(copy.modelsLoaded.replace('{count}', String(models.length)), 'ok')
  } catch (error) {
    setModelFetchStatus(
      copy.modelListUnavailable.replace(
        '{error}',
        error instanceof Error ? error.message : String(error),
      ),
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
  const copy = OPTIONS_COPY[settings.uiLanguage]
  const page =
    settings.pageTranslationEngine === 'browser'
      ? uiText(settings.uiLanguage, 'browserEngine')
      : copy.cloudTitle
  el<HTMLElement>('engineSummary').textContent = uiText(settings.uiLanguage, 'engineSummary', {
    engine: page,
  })
}

function applyStaticI18n(settings: UserSettings): void {
  const lang = settings.uiLanguage
  const copy = OPTIONS_COPY[lang]
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  document.title = copy.pageTitle
  el<HTMLElement>('uiLanguageTitle').textContent = uiText(lang, 'interfaceLanguage')
  el<HTMLElement>('uiLanguageLabel').textContent = uiText(lang, 'interfaceLanguage')
  el<HTMLElement>('uiLanguageHelp').textContent = copy.uiHelp
  el<HTMLElement>('engineSummary').textContent = uiText(lang, 'engineSummary', {
    engine:
      settings.pageTranslationEngine === 'browser'
        ? uiText(lang, 'browserEngine')
        : copy.cloudTitle,
  })
  const brandSub = document.querySelector<HTMLElement>('.brand-copy span')
  if (brandSub) brandSub.textContent = uiText(lang, 'extensionSettings')
  const nav = document.querySelectorAll<HTMLAnchorElement>('.section-nav a')
  if (nav[0]) nav[0].textContent = copy.navTranslation
  if (nav[1]) nav[1].textContent = copy.navPageMode
  if (nav[2]) nav[2].textContent = copy.navChrome
  if (nav[3]) nav[3].textContent = copy.navCloud
  if (nav[4]) nav[4].textContent = copy.navAsr
  if (nav[5]) nav[5].textContent = copy.navRules
  const sidebarTitle = document.querySelector<HTMLElement>('.sidebar-note span')
  const sidebarText = document.querySelector<HTMLElement>('.sidebar-note p')
  if (sidebarTitle) sidebarTitle.textContent = copy.privacyTitle
  if (sidebarText) sidebarText.textContent = copy.privacyText
  const heading = document.querySelector<HTMLElement>('.content-heading')
  if (heading) {
    heading.querySelector<HTMLElement>('.eyebrow')!.textContent = copy.preferences
    heading.querySelector<HTMLElement>('h1')!.textContent = copy.settings
    heading.querySelector<HTMLElement>('#helpSummary')!.textContent = copy.help
  }
  const sections = document.querySelectorAll<HTMLElement>('.settings-section')
  const sectionHeaders = [
    [copy.translationTitle, copy.translationHelp],
    [copy.pageModeTitle, copy.pageModeHelp],
    [copy.chromeTitle, copy.chromeHelp],
    [copy.cloudTitle, copy.cloudHelp],
    [copy.asrTitle, copy.asrHelp],
    [copy.rulesTitle, copy.rulesHelp],
  ] as const
  sections.forEach((section, index) => {
    const title = section.querySelector<HTMLElement>('.section-heading h2')
    const help = section.querySelector<HTMLElement>('.section-heading p')
    if (title && sectionHeaders[index]) title.textContent = sectionHeaders[index][0]
    if (help && sectionHeaders[index]) help.textContent = sectionHeaders[index][1]
  })
  const rows = document.querySelectorAll<HTMLElement>('.setting-row')
  const rowCopy = [
    [copy.targetTitle, copy.targetHelp],
    [uiText(lang, 'interfaceLanguage'), copy.uiHelp],
    [uiText(lang, 'translationEngine'), copy.engineHelp],
    [copy.autoTitle, copy.autoHelp],
    [uiText(lang, 'displayMode'), copy.displayHelp],
    [copy.styleTitle, copy.styleHelp],
    [copy.provider, copy.providerHelp],
    [copy.endpoint, copy.endpointHelp],
    [copy.apiKey, copy.apiKeyHelp],
    [copy.reasoning, copy.reasoningHelp],
    [copy.asrEndpoint, copy.asrEndpointHelp],
    [copy.asrModel, copy.asrModelHelp],
    [copy.asrApiKey, copy.asrApiKeyHelp],
    [copy.pausedSites, copy.pausedHelp],
  ] as const
  rows.forEach((row, index) => {
    const title = row.querySelector<HTMLElement>('.setting-copy h3')
    const help = row.querySelector<HTMLElement>('.setting-copy p')
    if (title && rowCopy[index]) title.textContent = rowCopy[index][0]
    if (help && rowCopy[index]) help.textContent = rowCopy[index][1]
  })
  const smallBadge = document.querySelector<HTMLElement>('.small-badge')
  if (smallBadge) smallBadge.textContent = copy.global
  const switchLabel = document.querySelector<HTMLElement>('.switch-label')
  if (switchLabel) switchLabel.textContent = copy.enabled
  const privacyWarning = document.querySelector<HTMLElement>('.privacy-warning')
  if (privacyWarning) privacyWarning.textContent = copy.privacyWarn
  const labels = document.querySelectorAll<HTMLElement>('label > span')
  for (const node of labels) {
    if (node.id === 'uiLanguageLabel') continue
    if (node.id === 'asrModelLabel') {
      node.textContent = copy.asrModel
      continue
    }
    const text = node.textContent ?? ''
    if (/Target language|目标语言/u.test(text)) node.textContent = uiText(lang, 'targetLanguage')
    else if (/Font size|字号/u.test(text)) node.textContent = copy.fontSize
    else if (/Base URL|基础 URL/u.test(text)) node.textContent = copy.baseUrl
    else if (/Endpoint|WebSocket/u.test(text)) node.textContent = copy.asrEndpointLabel
    else if (/Model/u.test(text)) node.textContent = copy.model
  }
  const colorLabels = document.querySelectorAll<HTMLElement>('.color-option > span')
  if (colorLabels[0]) colorLabels[0].textContent = copy.customColor
  if (colorLabels[1]) colorLabels[1].textContent = copy.backgroundColor
  const formatControls = document.querySelector<HTMLElement>('.format-controls')
  if (formatControls) formatControls.setAttribute('aria-label', copy.textFormatting)
  const formatChoices = document.querySelectorAll<HTMLElement>('.format-choice')
  if (formatChoices[0]) formatChoices[0].title = copy.bold
  if (formatChoices[1]) formatChoices[1].title = copy.italic
  if (formatChoices[2]) formatChoices[2].title = copy.underline
  el<HTMLInputElement>('pageTranslationTextColor').setAttribute(
    'aria-label',
    copy.translationTextColor,
  )
  el<HTMLInputElement>('pageTranslationBackgroundColor').setAttribute(
    'aria-label',
    copy.translationBackgroundColor,
  )
  el<HTMLInputElement>('apiKey').placeholder = el<HTMLInputElement>('apiKey').value
    ? copy.savedKeyPlaceholder
    : copy.apiKeyPlaceholder
  el<HTMLInputElement>('asrApiKey').placeholder = el<HTMLInputElement>('asrApiKey').value
    ? copy.savedKeyPlaceholder
    : copy.asrApiKeyPlaceholder
  el<HTMLInputElement>('model').placeholder = copy.modelPlaceholder
  el<HTMLInputElement>('pausedHostnames').placeholder = copy.pausedPlaceholder
  const facts = document.querySelectorAll<HTMLElement>('.runtime-facts div')
  if (facts[0]) {
    facts[0].querySelector<HTMLElement>('strong')!.textContent = copy.factChromeTitle
    facts[0].querySelector<HTMLElement>('span')!.textContent = copy.factChromeText
  }
  if (facts[1]) {
    facts[1].querySelector<HTMLElement>('strong')!.textContent = copy.factPackTitle
    facts[1].querySelector<HTMLElement>('span')!.textContent = copy.factPackText
  }
  if (facts[2]) {
    facts[2].querySelector<HTMLElement>('strong')!.textContent = copy.factDeviceTitle
    facts[2].querySelector<HTMLElement>('span')!.textContent = copy.factDeviceText
  }
  el<HTMLButtonElement>('browserCapabilityAction').textContent = copy.checkAgain
  el<HTMLButtonElement>('testConnection').textContent = copy.test
  el<HTMLButtonElement>('fetchModels').textContent = copy.models
  const apiToggle = el<HTMLButtonElement>('toggleApiKey')
  apiToggle.textContent = el<HTMLInputElement>('apiKey').type === 'text' ? copy.hide : copy.show
  const asrApiToggle = el<HTMLButtonElement>('toggleAsrApiKey')
  asrApiToggle.textContent =
    el<HTMLInputElement>('asrApiKey').type === 'text' ? copy.hide : copy.show
  el<HTMLButtonElement>('reset').textContent = copy.reset
  el<HTMLButtonElement>('save').textContent = copy.save
  const displayMode = el<HTMLSelectElement>('translationDisplayMode')
  displayMode.options[0].textContent = uiText(lang, 'bilingual')
  displayMode.options[1].textContent = uiText(lang, 'translationOnly')
  const engine = el<HTMLSelectElement>('pageTranslationEngine')
  engine.options[0].textContent = uiText(lang, 'browserEngine')
  engine.options[1].textContent = copy.cloudTitle
  const provider = el<HTMLSelectElement>('provider')
  provider.options[0].textContent = lang === 'zh' ? 'OpenAI 兼容' : 'OpenAI Compatible'
  provider.options[1].textContent = 'Infron.ai'
  provider.options[2].textContent = 'OpenRouter.ai'
  const reasoning = el<HTMLSelectElement>('reasoningPref')
  reasoning.options[0].textContent = copy.offLowest
  reasoning.options[1].textContent = copy.low
  reasoning.options[2].textContent = copy.medium
  reasoning.options[3].textContent = copy.high
}

function browserVersion(): string {
  return navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/u)?.[1] ?? 'unknown'
}

function renderBrowserCapability(
  availability: BrowserTranslatorAvailability | 'checking' | 'error',
  detail?: string,
): void {
  const copy = optionsCopy()
  const panel = el<HTMLElement>('browserCapability')
  const title = el<HTMLElement>('browserCapabilityTitle')
  const description = el<HTMLElement>('browserCapabilityDescription')
  const action = el<HTMLButtonElement>('browserCapabilityAction')
  panel.dataset.state = availability
  action.hidden = availability === 'checking'
  action.disabled = availability === 'checking'

  const content = {
    checking: [copy.checkingChromeTitle, copy.checkingChromeDescription],
    available: [copy.chromeReadyTitle, copy.chromeReadyDescription],
    downloadable: [copy.languagePackTitle, copy.languagePackDescription],
    downloading: [copy.downloadingPackTitle, detail || copy.downloadingPackDescription],
    unavailable: [copy.pairUnavailableTitle, copy.pairUnavailableDescription],
    unsupported: [
      copy.translatorApiUnavailableTitle,
      copy.translatorApiUnavailableDescription.replace('{version}', browserVersion()),
    ],
    error: [copy.checkFailedTitle, detail || copy.checkFailedDescription],
  } as const
  title.textContent = content[availability][0]
  description.textContent = detail || content[availability][1]
  action.textContent =
    availability === 'downloadable' || availability === 'downloading' ? copy.download : copy.retry
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
      renderBrowserCapability('downloading', optionsCopy().preparingLanguagePack)
      const ready = await browserTranslator.prepare('en', target, (progress) => {
        if (request !== capabilityRequest) return
        renderBrowserCapability(
          'downloading',
          optionsCopy().downloadedPercent.replace('{percent}', String(Math.round(progress * 100))),
        )
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
        setStatus(OPTIONS_COPY[next.uiLanguage].completeCloudBeforeSelect, false)
      }
      updateEngineSummary(readForm(stored))
    })
  }

  el<HTMLSelectElement>('uiLanguage').addEventListener('change', () => {
    const next = readForm(stored)
    applyStaticI18n(next)
    updateProviderHint(next.provider)
    updateConfigBadge(next)
    updateEngineSummary(next)
    renderBrowserCapability(browserCapability)
  })

  for (const id of ['baseURL', 'apiKey', 'model']) {
    el<HTMLInputElement>(id).addEventListener('input', () => {
      const next = readForm(stored)
      syncTranslationEngineAvailability(next)
      updateConfigBadge(next)
      updateModelCandidates(next)
      updateEngineSummary(readForm(stored))
    })
  }

  for (const id of ['asrEndpoint', 'asrModel', 'asrApiKey']) {
    el<HTMLInputElement>(id).addEventListener('input', () => {
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
    const copy = optionsCopy()
    button.textContent = visible ? copy.show : copy.hide
  })

  el<HTMLButtonElement>('toggleAsrApiKey').addEventListener('click', () => {
    const input = el<HTMLInputElement>('asrApiKey')
    const button = el<HTMLButtonElement>('toggleAsrApiKey')
    const visible = input.type === 'text'
    input.type = visible ? 'password' : 'text'
    const copy = optionsCopy()
    button.textContent = visible ? copy.show : copy.hide
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
        setStatus(
          OPTIONS_COPY[next.uiLanguage].completeCloudSetupAdd.replace(
            '{fields}',
            localizedMissingFields(missing).join(', '),
          ),
          false,
        )
        return
      }
      await saveSettings(next)
      stored = await loadSettings()
      fillForm(stored)
      const usesBrowser = stored.pageTranslationEngine === 'browser'
      if (usesBrowser && (browserCapability === 'unsupported' || browserCapability === 'unavailable')) {
        setStatus(uiText(stored.uiLanguage, 'chromeUnavailable'), false)
      } else if (
        usesBrowser &&
        (browserCapability === 'downloadable' || browserCapability === 'downloading')
      ) {
        setStatus(OPTIONS_COPY[stored.uiLanguage].savedDownloadPack, false)
      } else if (isConfigured(stored)) {
        setStatus(uiText(stored.uiLanguage, 'settingsSaved'), true)
      } else if (!usesExternal) {
        setStatus(uiText(stored.uiLanguage, 'engineBrowserReady'), true)
      } else {
        setStatus(OPTIONS_COPY[stored.uiLanguage].savedCloudNeedsKey, false)
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), false)
    }
  })

  el<HTMLButtonElement>('testConnection').addEventListener('click', () => {
    void runConnectionTest(readForm(stored))
  })

  el<HTMLButtonElement>('reset').addEventListener('click', async () => {
    if (!confirm(optionsCopy().resetConfirm)) return
    await saveSettings({ ...DEFAULT_SETTINGS })
    location.reload()
  })
}

void init()
