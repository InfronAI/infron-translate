import { isConfigured, loadSettings, saveSettings, missingConfigFields, type UserSettings } from '../shared/settings'
import type {
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

function renderStatus(settings: UserSettings): void {
  const configured = isConfigured(settings)
  const pageEngine = el<HTMLElement>('pageEngineStatus')
  pageEngine.textContent =
    settings.pageTranslationEngine === 'browser' ? 'Chrome 内置' : '外部 LLM'
  pageEngine.className =
    settings.pageTranslationEngine === 'browser' || configured ? 'pill ok' : 'pill warn'

  const pageAuto = el<HTMLInputElement>('pageAutoToggle')
  pageAuto.checked = settings.autoPageTranslation
  el<HTMLElement>('pageAutoDesc').textContent = settings.autoPageTranslation
    ? '开：检测到网页语言后自动开启'
    : '关：使用按钮手动开启'

  el<HTMLElement>('modeHint').textContent = '整页双语翻译'

  const tip = el<HTMLElement>('unconfiguredTip')
  const needsExternal = true
  if (configured || !needsExternal) {
    tip.hidden = true
  } else {
    tip.hidden = false
    const miss = missingConfigFields(settings)
    tip.textContent = miss.length
      ? `尚未配置完整：请填写 ${miss.join('、')}`
      : '尚未配置 API，请打开设置填写并保存。'
  }

  el<HTMLElement>('usageHint').textContent = '使用下方按钮切换整页中英双语翻译。'
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
    throw new Error('更新暂停状态失败')
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
    if (!files.length) throw new Error('无法在此页面运行')
    await chrome.scripting.executeScript({ target: { tabId }, files })
    await new Promise((resolve) => setTimeout(resolve, 120))
    response = await chrome.tabs.sendMessage(tabId, message)
  }
  if (!isTogglePageTranslationResult(response)) {
    throw new Error('页面翻译脚本未返回有效结果')
  }
  if (!response.ok) throw new Error(response.error)
}

function isTogglePageTranslationResult(value: unknown): value is TogglePageTranslationResult {
  if (!value || typeof value !== 'object' || !('ok' in value)) return false
  if (value.ok === true) return true
  return value.ok === false && 'error' in value && typeof value.error === 'string'
}

async function init(): Promise<void> {
  el<HTMLButtonElement>('openOptions').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage()
  })

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const hostname = hostnameFromUrl(tab?.url)
  const hostnameEl = el<HTMLElement>('hostname')
  const pauseToggle = el<HTMLInputElement>('pauseToggle')
  const pageAutoToggle = el<HTMLInputElement>('pageAutoToggle')

  const translatePageBtn = el<HTMLButtonElement>('translatePage')
  if (tab?.id === undefined || !hostname) {
    translatePageBtn.disabled = true
  } else {
    const tabId = tab.id
    translatePageBtn.addEventListener('click', async () => {
      try {
        el<HTMLElement>('error').hidden = true
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
    hostnameEl.textContent = '（无法读取此页）'
    pauseToggle.disabled = true
  } else {
    hostnameEl.textContent = hostname
    pauseToggle.disabled = false
  }

  let settings = await loadSettings()
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
    } catch (err) {
      pageAutoToggle.checked = !pageAutoToggle.checked
      const error = el<HTMLElement>('error')
      error.hidden = false
      error.textContent = err instanceof Error ? err.message : String(err)
    }
  })
}

void init()
