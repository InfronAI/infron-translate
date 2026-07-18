import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  isConfigured,
  missingConfigFields,
  type HotkeyConfig,
  type TranslationEngine,
  type UserSettings,
} from '../shared/settings'
import { formatHotkeyLabel, hotkeyFromKeyboardEvent } from '../shared/hotkey'
import {
  PROVIDER_PRESETS,
  type ProviderId,
  type ReasoningPref,
} from '../shared/providers'
import {
  BrowserTranslator,
  type BrowserTranslatorAvailability,
} from '../content/browser-translator'
import type { TestConnectionResult } from '../shared/messages'

const browserTranslator = new BrowserTranslator()
let browserCapability: BrowserTranslatorAvailability = 'unsupported'
let capabilityRequest = 0

const LANGUAGE_OPTIONS = [
  ['ar', '阿拉伯语'],
  ['bg', '保加利亚语'],
  ['bn', '孟加拉语'],
  ['cs', '捷克语'],
  ['da', '丹麦语'],
  ['de', '德语'],
  ['el', '希腊语'],
  ['en', '英语'],
  ['es', '西班牙语'],
  ['fi', '芬兰语'],
  ['fr', '法语'],
  ['he', '希伯来语'],
  ['hi', '印地语'],
  ['hr', '克罗地亚语'],
  ['hu', '匈牙利语'],
  ['id', '印度尼西亚语'],
  ['it', '意大利语'],
  ['ja', '日语'],
  ['kn', '卡纳达语'],
  ['ko', '韩语'],
  ['lt', '立陶宛语'],
  ['mr', '马拉地语'],
  ['nl', '荷兰语'],
  ['no', '挪威语'],
  ['pl', '波兰语'],
  ['pt', '葡萄牙语'],
  ['ro', '罗马尼亚语'],
  ['ru', '俄语'],
  ['sk', '斯洛伐克语'],
  ['sl', '斯洛文尼亚语'],
  ['sv', '瑞典语'],
  ['ta', '泰米尔语'],
  ['te', '泰卢固语'],
  ['th', '泰语'],
  ['tr', '土耳其语'],
  ['uk', '乌克兰语'],
  ['vi', '越南语'],
  ['zh', '简体中文'],
  ['zh-Hant', '繁体中文'],
] as const

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
    option.textContent = `自定义 · ${value}`
    select.append(option)
  }
  select.value = value
}

function hotkeyFieldId(prefix: string, field: string): string {
  return `${prefix}${field}`
}

function readHotkeyFromHidden(prefix: string, fallback: HotkeyConfig): HotkeyConfig {
  return {
    altKey: el<HTMLInputElement>(hotkeyFieldId(prefix, 'Alt')).value === '1',
    shiftKey: el<HTMLInputElement>(hotkeyFieldId(prefix, 'Shift')).value === '1',
    ctrlKey: el<HTMLInputElement>(hotkeyFieldId(prefix, 'Ctrl')).value === '1',
    metaKey: el<HTMLInputElement>(hotkeyFieldId(prefix, 'Meta')).value === '1',
    code: el<HTMLInputElement>(hotkeyFieldId(prefix, 'Code')).value || fallback.code,
  }
}

function writeHotkeyHidden(prefix: string, h: HotkeyConfig): void {
  el<HTMLInputElement>(hotkeyFieldId(prefix, 'Alt')).value = h.altKey ? '1' : '0'
  el<HTMLInputElement>(hotkeyFieldId(prefix, 'Shift')).value = h.shiftKey ? '1' : '0'
  el<HTMLInputElement>(hotkeyFieldId(prefix, 'Ctrl')).value = h.ctrlKey ? '1' : '0'
  el<HTMLInputElement>(hotkeyFieldId(prefix, 'Meta')).value = h.metaKey ? '1' : '0'
  el<HTMLInputElement>(hotkeyFieldId(prefix, 'Code')).value = h.code
  el<HTMLElement>(hotkeyFieldId(prefix, 'Preview')).textContent = formatHotkeyLabel(h)
}

function updateHotkeyHelp(): void {
  const pageLabel = formatHotkeyLabel(
    readHotkeyFromHidden('pageHotkey', DEFAULT_SETTINGS.pageTranslationHotkey),
  )
  el<HTMLElement>('helpHotkey').textContent =
    `开启自动翻译后，鼠标移到文本或图片上会显示翻译；关闭时点击后翻译。${pageLabel} 切换整页双语翻译。`
}

function fillForm(s: UserSettings): void {
  el<HTMLSelectElement>('provider').value = s.provider
  el<HTMLInputElement>('baseURL').value = s.baseURL
  el<HTMLInputElement>('apiKey').value = s.apiKey
  el<HTMLInputElement>('apiKey').placeholder = s.apiKey
    ? '已保存（留空再保存可保留原 Key）'
    : 'sk-... 或供应商密钥'
  el<HTMLInputElement>('model').value = s.model
  el<HTMLSelectElement>('reasoningPref').value = s.reasoningPref
  setLanguageValue('targetLang', s.targetLang)
  el<HTMLInputElement>('autoTranslate').checked = s.autoTranslate
  el<HTMLSelectElement>('pageTranslationEngine').value = s.pageTranslationEngine
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
  el<HTMLInputElement>('lensWidthPx').value = String(s.lensWidthPx)
  writeHotkeyHidden('pageHotkey', s.pageTranslationHotkey)
  updateHotkeyHelp()
  el<HTMLInputElement>('pausedHostnames').value = s.pausedHostnames.join(', ')
  updateConfigBadge(s)
  updateProviderHint(s.provider)
  updateStyleControlStates()
  updateEngineSummary(s)
}

function readForm(stored: UserSettings): UserSettings {
  const lensWidth = Number(el<HTMLInputElement>('lensWidthPx').value)
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
    autoTranslate: el<HTMLInputElement>('autoTranslate').checked,
    pageTranslationEngine: el<HTMLSelectElement>('pageTranslationEngine')
      .value as TranslationEngine,
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
    lensWidthPx:
      Number.isFinite(lensWidth) && lensWidth > 0
        ? Math.round(lensWidth)
        : DEFAULT_SETTINGS.lensWidthPx,
    pageTranslationHotkey: readHotkeyFromHidden(
      'pageHotkey',
      DEFAULT_SETTINGS.pageTranslationHotkey,
    ),
    pausedHostnames: parsePausedHostnames(el<HTMLInputElement>('pausedHostnames').value),
  }
}

function setStatus(text: string, ok = true): void {
  const node = el<HTMLElement>('status')
  node.textContent = text
  node.classList.toggle('status-error', !ok)
}

function setTestStatus(text: string, state: 'testing' | 'ok' | 'error'): void {
  const node = el<HTMLElement>('testConnectionStatus')
  node.textContent = text
  node.dataset.state = state
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
  setTestStatus('正在测试连接…', 'testing')
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
      setTestStatus('连接成功 · 接口可正常翻译', 'ok')
    } else {
      const error = isTestConnectionResult(response) && !response.ok ? response.error : '未知错误'
      setTestStatus(`连接失败：${error}`, 'error')
    }
  } catch (err) {
    setTestStatus(`连接失败：${err instanceof Error ? err.message : String(err)}`, 'error')
  } finally {
    button.disabled = false
  }
}

function updateConfigBadge(s: UserSettings): void {
  const badge = el<HTMLElement>('configBadge')
  if (isConfigured(s)) {
    badge.textContent = '状态：已配置 ✓'
    badge.className = 'config-badge ok'
  } else {
    const miss = missingConfigFields(s).join('、')
    badge.textContent = `状态：未完成（缺少 ${miss || '配置'}）`
    badge.className = 'config-badge warn'
  }
}

function updateProviderHint(provider: string): void {
  const hint = el<HTMLElement>('providerHint')
  if (provider === 'deepseek') {
    hint.textContent =
      'DeepSeek：默认写入 thinking.type=disabled（关思考）。Base 常用 https://api.deepseek.com'
  } else if (provider === 'stepfun') {
    hint.textContent =
      'StepFun：默认 reasoning_effort=low（最低推理）。Base 常用 https://api.stepfun.com/v1 或 https://api.stepfun.ai/v1'
  } else if (provider === 'openai') {
    hint.textContent = '通用 OpenAI 兼容接口，不附加特殊思考参数。'
  } else {
    hint.textContent =
      '自动识别 Base URL / 模型：DeepSeek 关 thinking；StepFun 用 reasoning_effort=low。'
  }
}

function updateStyleControlStates(): void {
  el<HTMLInputElement>('pageTranslationTextColor').disabled =
    !el<HTMLInputElement>('pageTranslationUseCustomColor').checked
  el<HTMLInputElement>('pageTranslationBackgroundColor').disabled =
    !el<HTMLInputElement>('pageTranslationUseBackground').checked
}

function updateEngineSummary(settings: UserSettings): void {
  const page = settings.pageTranslationEngine === 'browser' ? 'Chrome' : '外部 LLM'
  el<HTMLElement>('engineSummary').textContent = `透镜 外部 LLM · 整页 ${page}`
}

function browserVersion(): string {
  return navigator.userAgent.match(/(?:Chrome|Chromium)\/(\d+)/u)?.[1] ?? '未知'
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
    checking: ['正在检测 Chrome 内置翻译', '正在检查 API 和当前语言对。'],
    available: ['Chrome 内置翻译已就绪', '当前语言对可直接在设备侧翻译。'],
    downloadable: ['需要下载语言包', '点击下载并测试；完成后可用于网页自动翻译。'],
    downloading: ['语言包正在下载', detail || '请保持此页面打开。'],
    unavailable: ['当前语言对不可用', '可更换语言代码，或将对应翻译引擎切换为外部 LLM。'],
    unsupported: [
      '当前环境未提供 Translator API',
      `检测到 Chrome/Chromium ${browserVersion()}。该能力要求桌面版 Chrome 138+，其他 Chromium 浏览器不保证支持。`,
    ],
    error: ['检测失败', detail || '请重新检测；持续失败时可改用外部 LLM。'],
  } as const
  title.textContent = content[availability][0]
  description.textContent = detail || content[availability][1]
  action.textContent =
    availability === 'downloadable' || availability === 'downloading' ? '下载并测试' : '重新检测'
}

async function checkBrowserCapability(prepare = false): Promise<void> {
  const request = ++capabilityRequest
  const target = el<HTMLSelectElement>('targetLang').value || DEFAULT_SETTINGS.targetLang
  renderBrowserCapability('checking')
  try {
    browserCapability = await browserTranslator.availability('en', target)
    if (request !== capabilityRequest) return
    if (prepare && (browserCapability === 'downloadable' || browserCapability === 'downloading')) {
      renderBrowserCapability('downloading', '准备语言包…')
      const ready = await browserTranslator.prepare('en', target, (progress) => {
        if (request !== capabilityRequest) return
        renderBrowserCapability('downloading', `语言包下载进度 ${Math.round(progress * 100)}%`)
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
  if (!base.value.trim() || /openai\.com|deepseek\.com|stepfun\./i.test(base.value)) {
    base.value = preset.baseURL
  }
  if (!model.value.trim() || /gpt-4o-mini|deepseek|step-/i.test(model.value)) {
    model.value = preset.modelHint
  }
}

function setupHotkeyCapture(prefix: string, buttonId: string, hintId: string): void {
  const btn = el<HTMLButtonElement>(buttonId)
  const hint = el<HTMLElement>(hintId)
  let capturing = false

  const onKey = (e: KeyboardEvent) => {
    if (!capturing) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      stopCapture()
      setStatus('已取消录制')
      return
    }
    const hk = hotkeyFromKeyboardEvent(e)
    if (!hk) return
    writeHotkeyHidden(prefix, hk)
    updateHotkeyHelp()
    stopCapture()
    setStatus(`已录制：${formatHotkeyLabel(hk)}（记得点保存）`)
  }

  const stopCapture = () => {
    capturing = false
    hint.hidden = true
    btn.textContent = '录制快捷键'
    btn.classList.remove('recording')
    window.removeEventListener('keydown', onKey, true)
  }

  btn.addEventListener('click', () => {
    if (capturing) {
      stopCapture()
      return
    }
    capturing = true
    hint.hidden = false
    btn.textContent = '录制中…'
    btn.classList.add('recording')
    setStatus('')
    window.addEventListener('keydown', onKey, true)
  })
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
  let stored = await loadSettings()
  fillForm(stored)
  void checkBrowserCapability()
  setupSectionNavigation()
  setupHotkeyCapture('pageHotkey', 'capturePageHotkey', 'capturePageHint')
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
      updateEngineSummary(readForm(stored))
    })
  }

  el<HTMLSelectElement>('provider').addEventListener('change', () => {
    const v = el<HTMLSelectElement>('provider').value
    updateProviderHint(v)
    if (v !== 'auto') applyProviderPreset(v)
  })

  el<HTMLFormElement>('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault()
    try {
      const next = readForm(stored)
      const usesExternal = true
      const missing = usesExternal ? missingConfigFields(next) : []
      if (missing.length) {
        await saveSettings(next)
        stored = await loadSettings()
        fillForm(stored)
        setStatus(`已保存，但尚未完成配置：请填写 ${missing.join('、')}`, false)
        return
      }
      await saveSettings(next)
      stored = await loadSettings()
      fillForm(stored)
      const usesBrowser = stored.pageTranslationEngine === 'browser'
      if (usesBrowser && (browserCapability === 'unsupported' || browserCapability === 'unavailable')) {
        setStatus('已保存，但当前 Chrome 内置翻译不可用；请查看能力诊断或改用外部 LLM。', false)
      } else if (
        usesBrowser &&
        (browserCapability === 'downloadable' || browserCapability === 'downloading')
      ) {
        setStatus('已保存 · 使用自动翻译前，请先在 Chrome 能力区下载语言包。', false)
      } else if (isConfigured(stored)) {
        setStatus('已保存 · 已同步到打开的网页。', true)
      } else if (!usesExternal) {
        setStatus('已保存 · Chrome 内置翻译已就绪。', true)
      } else {
        setStatus('保存后校验失败，请重新填写 API Key 并保存。', false)
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), false)
    }
  })

  el<HTMLButtonElement>('testConnection').addEventListener('click', () => {
    void runConnectionTest(readForm(stored))
  })

  el<HTMLButtonElement>('reset').addEventListener('click', async () => {
    if (!confirm('确定恢复默认？API Key 会被清空。')) return
    await saveSettings({ ...DEFAULT_SETTINGS })
    location.reload()
  })
}

void init()
