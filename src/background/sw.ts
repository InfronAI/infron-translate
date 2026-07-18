import { loadSettings, saveSettings, isConfigured, missingConfigFields } from '../shared/settings'
import type { UserSettings } from '../shared/settings'
import type {
  FromBackground,
  SettingsMsg,
  ToBackground,
  TranslateBlock,
} from '../shared/messages'
import {
  filterUncachedByText,
  expandTranslationsToAllIds,
  translateBlocksSingleFlight,
  testConnection,
  ensureCacheHydrated,
  persistTranslationCache,
} from './translate'
import { MeetingManager } from './meeting'
import { ensureNativeAsrRelayStarted } from './native-asr-relay'

const meetingManager = new MeetingManager()

chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !isToBackground(rawMessage)) {
    sendResponse({ type: 'translate-batch-result', ok: false, error: 'invalid message' })
    return false
  }
  void handle(rawMessage, sender).then(sendResponse, (error: unknown) => {
    sendResponse(errorResponse(rawMessage, error))
  })
  return true
})

function errorResponse(message: ToBackground, error: unknown): FromBackground {
  const detail = error instanceof Error ? error.message : String(error)
  if (message.type === 'translate-batch') {
    return {
      type: 'translate-batch-result',
      ok: false,
      error: detail,
      failedIds: message.blocks.map((block) => block.id),
    }
  }
  if (message.type === 'test-connection') {
    return { type: 'test-connection-result', ok: false, error: detail }
  }
  if (message.type === 'open-options') {
    return { type: 'open-options-result', ok: false }
  }
  if (
    message.type === 'start-meeting-assistant' ||
    message.type === 'stop-meeting-assistant'
  ) {
    return { type: 'meeting-assistant-control-result', ok: false, error: detail }
  }
  if (
    message.type === 'meeting-transcript-segment' ||
    message.type === 'meeting-transcript-partial' ||
    message.type === 'meeting-audio-chunk' ||
    message.type === 'meeting-audio-status' ||
    message.type === 'set-meeting-context'
  ) {
    return { type: 'meeting-internal-result', ok: false }
  }
  return {
    type: 'background-error',
    ok: false,
    requestType: message.type,
    error: detail,
  }
}

function isOptionsPageSender(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.url) return false
  try {
    const senderUrl = new URL(sender.url)
    const optionsUrl = new URL(chrome.runtime.getURL('src/options/index.html'))
    return senderUrl.origin === optionsUrl.origin && senderUrl.pathname === optionsUrl.pathname
  } catch {
    return false
  }
}

// Content scripts declared in the manifest only load on navigation, so tabs open
// before first install stay untranslatable until reloaded. Inject into them once.
chrome.runtime.onInstalled.addListener((details) => {
  // Updating cannot safely tear down content scripts from the previous version.
  // Existing tabs receive the new script on their next navigation.
  if (details.reason === 'install') void injectIntoOpenTabs()
})

async function injectIntoOpenTabs(): Promise<void> {
  const files = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((s) => s.js ?? [])
  if (!files.length) return
  let tabs: chrome.tabs.Tab[]
  try {
    tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
  } catch {
    return
  }
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files,
      })
    } catch {
      // Restricted pages (Web Store, PDF viewer, other extensions) reject injection.
    }
  }
}

/** The only settings shape allowed to cross from the trusted background boundary. */
function settingsForContent(settings: UserSettings, hostname = ''): SettingsMsg {
  const {
    sourceLang,
    targetLang,
    pageTranslationEngine,
    translationDisplayMode,
    autoPageTranslation,
    uiLanguage,
    pageTranslationFontSizePx,
    pageTranslationUseCustomColor,
    pageTranslationTextColor,
    pageTranslationUseBackground,
    pageTranslationBackgroundColor,
    pageTranslationBold,
    pageTranslationItalic,
    pageTranslationUnderline,
    minTextLength,
    batchCharLimit,
  } = settings
  return {
    type: 'settings',
    settings: {
      sourceLang,
      targetLang,
      pageTranslationEngine,
      translationDisplayMode,
      autoPageTranslation,
      uiLanguage,
      pageTranslationFontSizePx,
      pageTranslationUseCustomColor,
      pageTranslationTextColor,
      pageTranslationUseBackground,
      pageTranslationBackgroundColor,
      pageTranslationBold,
      pageTranslationItalic,
      pageTranslationUnderline,
      minTextLength,
      batchCharLimit,
      apiKey: '',
    },
    paused: hostname ? settings.pausedHostnames.includes(hostname) : false,
    configured: isConfigured(settings),
  }
}

function senderHostname(sender: chrome.runtime.MessageSender): string {
  if (!sender.tab?.url) return ''
  try {
    const url = new URL(sender.tab.url)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : ''
  } catch {
    return ''
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isTranslateBlock(value: unknown): value is TranslateBlock {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length <= 256 &&
    typeof value.tag === 'string' &&
    value.tag.length <= 64 &&
    typeof value.text === 'string' &&
    value.text.length <= 20_000
  )
}

function isLanguageCode(value: unknown): value is string {
  return typeof value === 'string' && (value === 'auto' || /^[a-z]{2,3}$/u.test(value))
}

function isMeetingChannel(value: unknown): value is 'microphone' | 'meeting-output' {
  return value === 'microphone' || value === 'meeting-output'
}

function isMeetingTranscription(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.active === 'boolean' &&
    typeof value.message === 'string' &&
    value.message.length <= 500 &&
    (value.source === 'browser-speech' ||
      value.source === 'external-stt' ||
      value.source === 'mock' ||
      value.source === 'none')
  )
}

function isAudioLevel(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Runtime validation prevents internal pages from turning the worker into an unbounded fetch proxy. */
function isToBackground(value: unknown): value is ToBackground {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'get-settings' || value.type === 'open-options') return true
  if (value.type === 'set-hostname-paused') {
    return (
      typeof value.hostname === 'string' &&
      value.hostname.length > 0 &&
      value.hostname.length <= 253 &&
      typeof value.paused === 'boolean'
    )
  }
  if (value.type === 'set-auto-page-translation') {
    return typeof value.enabled === 'boolean'
  }
  if (value.type === 'start-meeting-assistant') {
    return (
      typeof value.tabId === 'number' &&
      Number.isInteger(value.tabId) &&
      value.tabId >= 0 &&
      typeof value.sourceLang === 'string' &&
      value.sourceLang.length <= 64 &&
      typeof value.targetLang === 'string' &&
      value.targetLang.length <= 64 &&
      (value.audioMode === 'tab-and-mic' ||
        value.audioMode === 'tab-only' ||
        value.audioMode === 'mock')
    )
  }
  if (value.type === 'stop-meeting-assistant') {
    return value.sessionId === undefined || typeof value.sessionId === 'string'
  }
  if (value.type === 'set-meeting-system-audio') {
    return (
      typeof value.sessionId === 'string' &&
      value.sessionId.length <= 128 &&
      typeof value.enabled === 'boolean'
    )
  }
  if (value.type === 'set-meeting-context') {
    return (
      typeof value.sessionId === 'string' &&
      value.sessionId.length <= 128 &&
      typeof value.material === 'string' &&
      value.material.length <= 20_000
    )
  }
  if (value.type === 'get-meeting-assistant-state') return true
  if (value.type === 'meeting-transcript-segment') {
    return (
      typeof value.sessionId === 'string' &&
      value.sessionId.length <= 128 &&
      isMeetingChannel(value.channel) &&
      typeof value.speakerLabel === 'string' &&
      value.speakerLabel.length <= 80 &&
      typeof value.sourceLang === 'string' &&
      value.sourceLang.length <= 64 &&
      typeof value.originalText === 'string' &&
      value.originalText.length <= 20_000 &&
      typeof value.startedAt === 'number' &&
      typeof value.endedAt === 'number'
    )
  }
  if (value.type === 'meeting-transcript-partial') {
    return (
      typeof value.sessionId === 'string' &&
      value.sessionId.length <= 128 &&
      isMeetingChannel(value.channel) &&
      typeof value.speakerLabel === 'string' &&
      value.speakerLabel.length <= 80 &&
      typeof value.sourceLang === 'string' &&
      value.sourceLang.length <= 64 &&
      typeof value.text === 'string' &&
      value.text.length <= 20_000 &&
      typeof value.startedAt === 'number' &&
      typeof value.updatedAt === 'number'
    )
  }
  if (value.type === 'meeting-audio-chunk') {
    return (
      typeof value.sessionId === 'string' &&
      value.sessionId.length <= 128 &&
      isMeetingChannel(value.channel) &&
      typeof value.sourceLang === 'string' &&
      value.sourceLang.length <= 64 &&
      typeof value.mimeType === 'string' &&
      value.mimeType.length <= 128 &&
      typeof value.audioBase64 === 'string' &&
      value.audioBase64.length <= 4_500_000 &&
      /^[A-Za-z0-9+/=]+$/u.test(value.audioBase64) &&
      typeof value.startedAt === 'number' &&
      typeof value.endedAt === 'number'
    )
  }
  if (value.type === 'meeting-audio-status') {
    return (
      typeof value.sessionId === 'string' &&
      value.sessionId.length <= 128 &&
      (value.microphone === undefined || typeof value.microphone === 'boolean') &&
      (value.output === undefined || typeof value.output === 'boolean') &&
      (value.microphoneLevel === undefined || isAudioLevel(value.microphoneLevel)) &&
      (value.outputLevel === undefined || isAudioLevel(value.outputLevel)) &&
      (value.microphoneLabel === undefined ||
        (typeof value.microphoneLabel === 'string' && value.microphoneLabel.length <= 256)) &&
      (value.outputLabel === undefined ||
        (typeof value.outputLabel === 'string' && value.outputLabel.length <= 256)) &&
      (value.transcription === undefined || isMeetingTranscription(value.transcription))
    )
  }
  if (value.type === 'translate-batch') {
    if (
      typeof value.pageKey !== 'string' ||
      value.pageKey.length > 4096 ||
      !isLanguageCode(value.sourceLang) ||
      !Array.isArray(value.blocks) ||
      value.blocks.length > 500
    ) {
      return false
    }
    let totalChars = 0
    for (const block of value.blocks) {
      if (!isTranslateBlock(block)) return false
      totalChars += block.text.length
      if (totalChars > 500_000) return false
    }
    return true
  }
  if (value.type === 'test-connection') {
    return (
      typeof value.baseURL === 'string' &&
      value.baseURL.length <= 2048 &&
      typeof value.apiKey === 'string' &&
      value.apiKey.length <= 512 &&
      typeof value.model === 'string' &&
      value.model.length <= 256 &&
      (value.provider === 'openai' ||
        value.provider === 'infron' ||
        value.provider === 'openrouter') &&
      (value.reasoningPref === 'off' ||
        value.reasoningPref === 'low' ||
        value.reasoningPref === 'medium' ||
        value.reasoningPref === 'high')
    )
  }
  return false
}

async function handle(
  message: ToBackground,
  sender: chrome.runtime.MessageSender,
): Promise<FromBackground> {
  if (message.type === 'get-settings') {
    const settings = await loadSettings()
    return settingsForContent(settings, senderHostname(sender))
  }

  if (message.type === 'set-hostname-paused') {
    const settings = await loadSettings()
    const set = new Set(settings.pausedHostnames)
    if (message.paused) set.add(message.hostname)
    else set.delete(message.hostname)
    const next = { ...settings, pausedHostnames: [...set] }
    await saveSettings(next)
    return settingsForContent(next, message.hostname)
  }

  if (message.type === 'set-auto-page-translation') {
    const settings = await loadSettings()
    const next = { ...settings, autoPageTranslation: message.enabled }
    await saveSettings(next)
    return settingsForContent(next, senderHostname(sender))
  }

  if (message.type === 'open-options') {
    try {
      await chrome.runtime.openOptionsPage()
      return { type: 'open-options-result', ok: true }
    } catch {
      return { type: 'open-options-result', ok: false }
    }
  }

  if (message.type === 'start-meeting-assistant') {
    if (message.audioMode !== 'mock') await ensureNativeAsrRelayStarted()
    const session = await meetingManager.start({
      tabId: message.tabId,
      sourceLang: message.sourceLang,
      targetLang: message.targetLang,
      audioMode: message.audioMode,
    })
    return { type: 'meeting-assistant-control-result', ok: true, session }
  }

  if (message.type === 'stop-meeting-assistant') {
    await meetingManager.stop()
    return {
      type: 'meeting-assistant-control-result',
      ok: true,
      session: {
        id: message.sessionId ?? 'stopped',
        tabId: sender.tab?.id ?? -1,
        startedAt: Date.now(),
        stoppedAt: Date.now(),
        status: 'stopped',
        audioMode: 'mock',
        sourceLang: 'auto',
        targetLang: 'cn',
        uiLanguage: 'zh',
      },
    }
  }

  if (message.type === 'get-meeting-assistant-state') {
    return { type: 'meeting-assistant-state', state: meetingManager.getState() }
  }

  if (message.type === 'set-meeting-system-audio') {
    await meetingManager.setSystemAudioEnabled(message.sessionId, message.enabled)
    return { type: 'meeting-internal-result', ok: true }
  }

  if (message.type === 'set-meeting-context') {
    await meetingManager.setPreMeetingMaterial(message.sessionId, message.material)
    return { type: 'meeting-internal-result', ok: true }
  }

  if (message.type === 'meeting-audio-status') {
    await meetingManager.updateAudioStatus(message)
    return { type: 'meeting-internal-result', ok: true }
  }

  if (message.type === 'meeting-transcript-segment') {
    await meetingManager.ingestTranscript(message)
    return { type: 'meeting-internal-result', ok: true }
  }

  if (message.type === 'meeting-transcript-partial') {
    await meetingManager.ingestTranscriptPartial(message)
    return { type: 'meeting-internal-result', ok: true }
  }

  if (message.type === 'meeting-audio-chunk') {
    await meetingManager.ingestAudioChunk(message)
    return { type: 'meeting-internal-result', ok: true }
  }

  if (message.type === 'translate-batch') {
    const settings = await loadSettings()
    if (!isConfigured(settings)) {
      try {
        await chrome.runtime.openOptionsPage()
      } catch {
        // The content script still receives the configuration error below.
      }
      return {
        type: 'translate-batch-result',
        ok: false,
        error: 'Cloud AI model needs to be configured first',
        failedIds: message.blocks.map((b) => b.id),
      }
    }

    await ensureCacheHydrated()
    const { cached, missing, textHashToIds, idToText } = filterUncachedByText(
      message.pageKey,
      message.sourceLang,
      settings.targetLang,
      message.blocks,
    )

    if (missing.length === 0) {
      return { type: 'translate-batch-result', ok: true, translations: cached }
    }

    const result = await translateBlocksSingleFlight(
      message.pageKey,
      message.sourceLang,
      settings.targetLang,
      missing,
      settings,
    )
    const expanded = expandTranslationsToAllIds(
      message.pageKey,
      message.sourceLang,
      settings.targetLang,
      result.translations,
      idToText,
      textHashToIds,
    )
    if (result.translations.length) await persistTranslationCache()
    const translations = [...cached, ...expanded]

    if (result.ok) {
      return { type: 'translate-batch-result', ok: true, translations }
    }

    const cacheKeyById = new Map<string, string>()
    for (const [cacheKey, ids] of textHashToIds) {
      for (const id of ids) cacheKeyById.set(id, cacheKey)
    }
    const failedSet = new Set<string>()
    for (const failedId of result.failedIds) {
      const cacheKey = cacheKeyById.get(failedId)
      if (!cacheKey) {
        failedSet.add(failedId)
        continue
      }
      for (const id of textHashToIds.get(cacheKey) ?? [failedId]) failedSet.add(id)
    }
    return {
      type: 'translate-batch-result',
      ok: false,
      error: result.error,
      failedIds: [...failedSet],
      translations,
    }
  }

  if (message.type === 'test-connection') {
    // Only the extension's settings page may supply an arbitrary endpoint/key;
    // otherwise a content script could turn the worker into a fetch proxy.
    if (!isOptionsPageSender(sender)) {
      return { type: 'test-connection-result', ok: false, error: 'Open settings to test Cloud Model connection' }
    }
    const stored = await loadSettings()
    const probe: UserSettings = {
      ...stored,
      baseURL: message.baseURL.trim(),
      apiKey: message.apiKey.trim() || stored.apiKey,
      model: message.model.trim(),
      provider: message.provider,
      reasoningPref: message.reasoningPref,
    }
    const missing = missingConfigFields(probe)
    if (missing.length) {
      return { type: 'test-connection-result', ok: false, error: `Add ${missing.join(', ')} first` }
    }
    const result = await testConnection(probe)
    return result.ok
      ? { type: 'test-connection-result', ok: true }
      : { type: 'test-connection-result', ok: false, error: result.error }
  }

  return { type: 'translate-batch-result', ok: false, error: 'unknown message' }
}
