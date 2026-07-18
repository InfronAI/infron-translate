import type { ProviderId, ReasoningPref } from './providers'

export type TranslationEngine = 'external' | 'browser'
export type TranslationDisplayMode = 'bilingual' | 'translation-only'
export type UiLanguage = 'zh' | 'en'

export type UserSettings = {
  baseURL: string
  apiKey: string
  model: string
  /** Endpoint used by Meeting Assistant speech recognition. */
  asrEndpoint: string
  /** Model used by Meeting Assistant speech recognition. */
  asrModel: string
  /** API key used only by the speech recognition endpoint. */
  asrApiKey: string
  /** openai | infron | openrouter */
  provider: ProviderId
  /**
   * Thinking / reasoning preference for compatible providers.
   * Current presets do not inject provider-specific reasoning parameters.
   */
  reasoningPref: ReasoningPref
  /** auto means use the detected language for the active webpage. */
  sourceLang: string
  targetLang: string
  /** Engine used by full-page DOM translation. */
  pageTranslationEngine: TranslationEngine
  /** How translated page text is rendered. */
  translationDisplayMode: TranslationDisplayMode
  /** Automatically enable full-page translation after detecting the page language. */
  autoPageTranslation: boolean
  pageTranslationFontSizePx: number
  pageTranslationUseCustomColor: boolean
  pageTranslationTextColor: string
  pageTranslationUseBackground: boolean
  pageTranslationBackgroundColor: string
  pageTranslationBold: boolean
  pageTranslationItalic: boolean
  pageTranslationUnderline: boolean
  minTextLength: number
  batchCharLimit: number
  pausedHostnames: string[]
  /** UI language for extension pages and in-page controls. */
  uiLanguage: UiLanguage
}

export const DEFAULT_SETTINGS: UserSettings = {
  baseURL: 'https://llm.onerouter.pro/v1',
  apiKey: '',
  model: 'deepseek/deepseek-v3.2',
  asrEndpoint: 'wss://api.stepfun.com/v1/realtime/asr/stream',
  asrModel: 'stepaudio-2.5-asr-stream',
  asrApiKey: '',
  provider: 'infron',
  reasoningPref: 'off',
  sourceLang: 'auto',
  targetLang: 'cn',
  pageTranslationEngine: 'browser',
  translationDisplayMode: 'bilingual',
  autoPageTranslation: false,
  pageTranslationFontSizePx: 14,
  pageTranslationUseCustomColor: false,
  pageTranslationTextColor: '#0e7490',
  pageTranslationUseBackground: false,
  pageTranslationBackgroundColor: '#ecfeff',
  pageTranslationBold: false,
  pageTranslationItalic: false,
  pageTranslationUnderline: false,
  minTextLength: 10,
  batchCharLimit: 6000,
  pausedHostnames: [],
  uiLanguage: 'zh',
}

function asProviderId(v: unknown): ProviderId {
  if (v === 'openai' || v === 'infron' || v === 'openrouter') return v
  if (v === 'auto' || v === 'deepseek' || v === 'stepfun') return 'openai'
  return DEFAULT_SETTINGS.provider
}

function asReasoningPref(v: unknown): ReasoningPref {
  if (v === 'off' || v === 'low' || v === 'medium' || v === 'high') return v
  return DEFAULT_SETTINGS.reasoningPref
}

function asTranslationEngine(v: unknown, fallback: TranslationEngine): TranslationEngine {
  return v === 'browser' || v === 'external' ? v : fallback
}

function asTranslationDisplayMode(
  v: unknown,
  fallback: TranslationDisplayMode,
): TranslationDisplayMode {
  return v === 'bilingual' || v === 'translation-only' ? v : fallback
}

function asUiLanguage(v: unknown): UiLanguage {
  return v === 'en' || v === 'zh' ? v : DEFAULT_SETTINGS.uiLanguage
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function stringValue(value: unknown, fallback: string): string {
  return value === null || value === undefined ? fallback : String(value)
}

function languageValue(value: unknown, fallback: string): string {
  const language = stringValue(value, fallback).slice(0, 64)
  return language === 'zh' ? 'cn' : language
}

function colorValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

/** Validate persisted/untrusted settings and fill every omitted or malformed field. */
export function mergeSettings(partial: unknown): UserSettings {
  const p = isRecord(partial) ? partial : {}
  return {
    baseURL: stringValue(p.baseURL, DEFAULT_SETTINGS.baseURL),
    apiKey: stringValue(p.apiKey, DEFAULT_SETTINGS.apiKey),
    model: stringValue(p.model, DEFAULT_SETTINGS.model),
    asrEndpoint: stringValue(p.asrEndpoint, DEFAULT_SETTINGS.asrEndpoint),
    asrModel: stringValue(p.asrModel, DEFAULT_SETTINGS.asrModel),
    asrApiKey: stringValue(p.asrApiKey, DEFAULT_SETTINGS.asrApiKey),
    provider: asProviderId(p.provider),
    reasoningPref: asReasoningPref(p.reasoningPref),
    sourceLang: languageValue(p.sourceLang, DEFAULT_SETTINGS.sourceLang),
    targetLang: languageValue(p.targetLang, DEFAULT_SETTINGS.targetLang),
    pageTranslationEngine: asTranslationEngine(
      p.pageTranslationEngine,
      DEFAULT_SETTINGS.pageTranslationEngine,
    ),
    translationDisplayMode: asTranslationDisplayMode(
      p.translationDisplayMode,
      DEFAULT_SETTINGS.translationDisplayMode,
    ),
    autoPageTranslation:
      typeof p.autoPageTranslation === 'boolean'
        ? p.autoPageTranslation
        : DEFAULT_SETTINGS.autoPageTranslation,
    pageTranslationFontSizePx: finiteNumber(
      p.pageTranslationFontSizePx,
      DEFAULT_SETTINGS.pageTranslationFontSizePx,
      10,
      32,
    ),
    pageTranslationUseCustomColor:
      typeof p.pageTranslationUseCustomColor === 'boolean'
        ? p.pageTranslationUseCustomColor
        : DEFAULT_SETTINGS.pageTranslationUseCustomColor,
    pageTranslationTextColor: colorValue(
      p.pageTranslationTextColor,
      DEFAULT_SETTINGS.pageTranslationTextColor,
    ),
    pageTranslationUseBackground:
      typeof p.pageTranslationUseBackground === 'boolean'
        ? p.pageTranslationUseBackground
        : DEFAULT_SETTINGS.pageTranslationUseBackground,
    pageTranslationBackgroundColor: colorValue(
      p.pageTranslationBackgroundColor,
      DEFAULT_SETTINGS.pageTranslationBackgroundColor,
    ),
    pageTranslationBold:
      typeof p.pageTranslationBold === 'boolean'
        ? p.pageTranslationBold
        : DEFAULT_SETTINGS.pageTranslationBold,
    pageTranslationItalic:
      typeof p.pageTranslationItalic === 'boolean'
        ? p.pageTranslationItalic
        : DEFAULT_SETTINGS.pageTranslationItalic,
    pageTranslationUnderline:
      typeof p.pageTranslationUnderline === 'boolean'
        ? p.pageTranslationUnderline
        : DEFAULT_SETTINGS.pageTranslationUnderline,
    minTextLength: finiteNumber(p.minTextLength, DEFAULT_SETTINGS.minTextLength, 1, 1000),
    batchCharLimit: finiteNumber(
      p.batchCharLimit,
      DEFAULT_SETTINGS.batchCharLimit,
      100,
      100_000,
    ),
    pausedHostnames: Array.isArray(p.pausedHostnames)
      ? p.pausedHostnames
          .filter((hostname): hostname is string => typeof hostname === 'string')
          .slice(0, 1000)
      : DEFAULT_SETTINGS.pausedHostnames,
    uiLanguage: asUiLanguage(p.uiLanguage),
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Remote endpoints require TLS; loopback HTTP remains available for local model servers. */
export function apiBaseUrlError(baseURL: string): string | null {
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    return 'Base URL is invalid'
  }
  if (url.username || url.password) return 'Base URL must not include a username or password'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return null
  return 'Remote Base URL must use HTTPS'
}

export function isConfigured(settings: UserSettings): boolean {
  const baseURL = settings.baseURL?.trim() ?? ''
  const apiKey = settings.apiKey?.trim() ?? ''
  const model = settings.model?.trim() ?? ''
  return (
    baseURL.length > 0 &&
    apiBaseUrlError(baseURL) === null &&
    apiKey.length > 0 &&
    model.length > 0
  )
}

/** Human-readable list of missing required API fields. */
export function missingConfigFields(settings: UserSettings): string[] {
  const missing: string[] = []
  if (!(settings.baseURL?.trim() ?? '')) missing.push('Base URL')
  else {
    const baseUrlError = apiBaseUrlError(settings.baseURL.trim())
    if (baseUrlError) missing.push(baseUrlError)
  }
  if (!(settings.apiKey?.trim() ?? '')) missing.push('API Key')
  if (!(settings.model?.trim() ?? '')) missing.push('Model')
  return missing
}
