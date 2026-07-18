import { splitIntoBatches } from '../shared/batch'
import {
  buildTranslateImagePrompt,
  buildTranslateUserPrompt,
  IMAGE_TRANSLATION_JSON_SCHEMA,
  parseImageTranslationResult,
  parseTranslateBatchResult,
} from '../shared/schema'
import type { TranslateBlock } from '../shared/messages'
import type { UserSettings } from '../shared/settings-defaults'
import { makeTranslationCacheKey } from '../shared/text-hash'
import { TranslationCache } from '../shared/translation-cache'
import { normalizeText } from '../shared/text'
import { chatCompletionsJson } from './openai'
import type { ChatJsonParams } from './openai'

const SYSTEM = 'You are a precise translation engine. Output JSON only.'
const IMAGE_SYSTEM = 'You are a precise image text translation engine. Output JSON only.'
const MAX_IMAGE_BYTES = 4_000_000
const VISION_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** Global bounded cache shared across tabs/pages (keys include pageKey). */
const textCache = new TranslationCache({
  maxEntries: 2500,
  maxTotalChars: 800_000,
})

// MV3 unloads the worker when idle, wiping the in-memory cache and forcing a full
// re-translation on the next event. Mirror it into session storage (in-memory,
// session-scoped) so it survives worker restarts within the same browsing session.
const CACHE_STORAGE_KEY = 'lens-translation-cache-v1'
let hydrationPromise: Promise<void> | null = null
let persistenceChain: Promise<void> = Promise.resolve()

function sessionStorage(): chrome.storage.StorageArea | undefined {
  try {
    return typeof chrome !== 'undefined' ? chrome.storage?.session : undefined
  } catch {
    return undefined
  }
}

/** Load the persisted cache once; safe to call on every request. */
export function ensureCacheHydrated(): Promise<void> {
  if (hydrationPromise) return hydrationPromise
  hydrationPromise = (async () => {
    const area = sessionStorage()
    if (!area) return
    try {
      const stored = await area.get(CACHE_STORAGE_KEY)
      const entries = stored?.[CACHE_STORAGE_KEY]
      if (Array.isArray(entries)) textCache.load(entries as [string, string][])
    } catch {
      // Best-effort: a cold cache just means we re-translate.
    }
  })()
  return hydrationPromise
}

/** Persist before the message handler resolves so MV3 worker suspension cannot drop updates. */
export async function persistTranslationCache(): Promise<void> {
  const area = sessionStorage()
  if (!area) return
  const snapshot = textCache.entries()
  const write = persistenceChain.then(() => area.set({ [CACHE_STORAGE_KEY]: snapshot }))
  persistenceChain = write.catch(() => undefined)
  await persistenceChain
}

export type TranslateAllResult =
  | { ok: true; translations: { id: string; translation: string }[] }
  | {
      ok: false
      error: string
      translations: { id: string; translation: string }[]
      failedIds: string[]
    }

type SharedTranslationOutcome =
  | { ok: true; translation: string }
  | { ok: false; error: string }

const inFlightTranslations = new Map<string, Promise<SharedTranslationOutcome>>()

/** Coalesce identical cache misses across concurrent lens/page/tab requests. */
export async function translateBlocksSingleFlight(
  pageKey: string,
  sourceLang: string,
  targetLang: string,
  blocks: TranslateBlock[],
  settings: UserSettings,
): Promise<TranslateAllResult> {
  const waiting: Array<{ block: TranslateBlock; outcome: Promise<SharedTranslationOutcome> }> = []
  const owned: Array<{
    block: TranslateBlock
    key: string
    promise: Promise<SharedTranslationOutcome>
    resolve: (outcome: SharedTranslationOutcome) => void
  }> = []

  for (const block of blocks) {
    const key = makeTranslationCacheKey(pageKey, sourceLang, targetLang, block.text)
    const existing = inFlightTranslations.get(key)
    if (existing) {
      waiting.push({ block, outcome: existing })
      continue
    }
    let resolve!: (outcome: SharedTranslationOutcome) => void
    const promise = new Promise<SharedTranslationOutcome>((done) => {
      resolve = done
    })
    inFlightTranslations.set(key, promise)
    owned.push({ block, key, promise, resolve })
    waiting.push({ block, outcome: promise })
  }

  if (owned.length) {
    void (async () => {
      let result: TranslateAllResult
      try {
        result = await translateAllBlocks(
          owned.map((entry) => entry.block),
          sourceLang,
          settings,
        )
      } catch (error) {
        result = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          translations: [],
          failedIds: owned.map((entry) => entry.block.id),
        }
      }
      const translated = new Map(result.translations.map((item) => [item.id, item.translation]))
      for (const entry of owned) {
        const translation = translated.get(entry.block.id)
        entry.resolve(
          translation
            ? { ok: true, translation }
            : { ok: false, error: result.ok ? 'missing translation' : result.error },
        )
        if (inFlightTranslations.get(entry.key) === entry.promise) {
          inFlightTranslations.delete(entry.key)
        }
      }
    })()
  }

  const outcomes = await Promise.all(
    waiting.map(async ({ block, outcome }) => ({ block, outcome: await outcome })),
  )
  const translations: { id: string; translation: string }[] = []
  const failedIds: string[] = []
  let firstError = 'partial failure'
  for (const { block, outcome } of outcomes) {
    if (outcome.ok) translations.push({ id: block.id, translation: outcome.translation })
    else {
      failedIds.push(block.id)
      if (firstError === 'partial failure') firstError = outcome.error
    }
  }
  return failedIds.length
    ? { ok: false, error: firstError, translations, failedIds }
    : { ok: true, translations }
}

export type TranslateImageResult =
  | { ok: true; translation: string }
  | { ok: false; error: string }

/** Fetch and upload one complete page image to the configured multimodal endpoint. */
export async function translateImage(
  imageUrl: string,
  sourceLang: string,
  settings: UserSettings,
): Promise<TranslateImageResult> {
  const imageDataUrl = await loadImageDataUrl(imageUrl)
  if (!imageDataUrl.ok) return imageDataUrl

  const userPrompt = buildTranslateImagePrompt(sourceLang, settings.targetLang)
  const request: Omit<ChatJsonParams, 'useJsonSchema'> = {
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: IMAGE_SYSTEM,
    userPrompt,
    userContent: [
      { type: 'text', text: userPrompt },
      { type: 'image_url', image_url: { url: imageDataUrl.dataUrl } },
    ],
    jsonSchema: IMAGE_TRANSLATION_JSON_SCHEMA,
    provider: settings.provider,
    reasoningPref: settings.reasoningPref,
  }
  let result = await chatCompletionsJson({ ...request, useJsonSchema: true })

  if (!result.ok && result.status === 400) {
    result = await chatCompletionsJson({ ...request, useJsonSchema: false })
  }

  if (!result.ok) {
    return {
      ok: false,
      error:
        result.status === 400
          ? `当前模型或服务商不支持图片输入：${result.error}`
          : result.error,
    }
  }

  try {
    return parseImageTranslationResult(JSON.parse(result.content))
  } catch {
    return { ok: false, error: 'invalid JSON from model' }
  }
}

/** Read supported image bytes with a hard streaming limit before base64 encoding. */
async function loadImageDataUrl(
  imageUrl: string,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  if (imageUrl.startsWith('data:')) {
    const mimeType = imageUrl.slice(5).split(/[;,]/, 1)[0].toLowerCase()
    if (!VISION_IMAGE_TYPES.has(mimeType)) {
      return { ok: false, error: `unsupported image type: ${mimeType || 'unknown'}` }
    }
    if (!/^data:image\/(?:jpeg|png|webp|gif);base64,/i.test(imageUrl)) {
      return { ok: false, error: 'image data URL must use base64 encoding' }
    }
    if (imageUrl.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3)) {
      return { ok: false, error: 'image is too large (max 4 MB)' }
    }
    return { ok: true, dataUrl: imageUrl }
  }
  if (!/^https?:\/\//i.test(imageUrl)) {
    return { ok: false, error: 'unsupported image resource URL' }
  }

  let response: Response
  try {
    response = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'could not fetch image resource',
    }
  }
  if (!response.ok) return { ok: false, error: `image fetch failed: HTTP ${response.status}` }

  const mimeType = response.headers.get('content-type')?.split(';', 1)[0].toLowerCase() ?? ''
  if (!VISION_IMAGE_TYPES.has(mimeType)) {
    return { ok: false, error: `unsupported image type: ${mimeType || 'unknown'}` }
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'image is too large (max 4 MB)' }
  }

  if (!response.body) return { ok: false, error: 'image response body missing' }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > MAX_IMAGE_BYTES) {
        await reader.cancel()
        return { ok: false, error: 'image is too large (max 4 MB)' }
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'image stream failed',
    }
  }

  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let binary = ''
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192))
  }
  return { ok: true, dataUrl: `data:${mimeType};base64,${btoa(binary)}` }
}

/** Translate batches with bounded retries and preserve partial successes. */
export async function translateAllBlocks(
  blocks: TranslateBlock[],
  sourceLang: string,
  settings: UserSettings,
  opts?: { useJsonSchema?: boolean; sleep?: (ms: number) => Promise<void> },
): Promise<TranslateAllResult> {
  const useJsonSchema = opts?.useJsonSchema ?? true
  const sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const batches = splitIntoBatches(blocks, settings.batchCharLimit, 40)
  const translations: { id: string; translation: string }[] = []
  const failedIds: string[] = []

  for (const batch of batches) {
    const allowed = new Set(batch.map((b) => b.id))
    let attempt = 0
    let batchOk = false
    let lastError = 'unknown'

    while (attempt < 3 && !batchOk) {
      attempt++
      const userPrompt = buildTranslateUserPrompt(
        sourceLang,
        settings.targetLang,
        batch,
      )
      let result = await chatCompletionsJson({
        baseURL: settings.baseURL,
        apiKey: settings.apiKey,
        model: settings.model,
        systemPrompt: SYSTEM,
        userPrompt,
        useJsonSchema,
        provider: settings.provider,
        reasoningPref: settings.reasoningPref,
      })

      if (!result.ok && result.status === 400 && useJsonSchema && attempt === 1) {
        result = await chatCompletionsJson({
          baseURL: settings.baseURL,
          apiKey: settings.apiKey,
          model: settings.model,
          systemPrompt: SYSTEM,
          userPrompt,
          useJsonSchema: false,
          provider: settings.provider,
          reasoningPref: settings.reasoningPref,
        })
      }

      if (!result.ok) {
        lastError = result.error
        if (result.status === 401 || result.status === 403) {
          return {
            ok: false,
            error: lastError,
            translations,
            failedIds: blocks.map((b) => b.id),
          }
        }
        if (
          result.status === 429 ||
          (result.status !== undefined && result.status >= 500) ||
          result.status === undefined
        ) {
          if (attempt < 3) {
            // Silent exponential backoff for rate limits / upstream hiccups: 500ms, 1000ms.
            await sleep(500 * 2 ** (attempt - 1))
            continue
          }
        }
        break
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(result.content)
      } catch {
        lastError = 'invalid JSON from model'
        continue
      }
      const parsed = parseTranslateBatchResult(parsedJson, allowed)
      if (!parsed.ok) {
        lastError = parsed.error
        continue
      }
      if (parsed.items.length === 0 && batch.length > 0) {
        lastError = 'empty translation items'
        continue
      }
      translations.push(...parsed.items)
      const got = new Set(parsed.items.map((i) => i.id))
      for (const b of batch) {
        if (!got.has(b.id)) failedIds.push(b.id)
      }
      batchOk = true
    }

    if (!batchOk) {
      for (const b of batch) failedIds.push(b.id)
      return { ok: false, error: lastError, translations, failedIds: [...new Set(failedIds)] }
    }
  }

  return failedIds.length
    ? { ok: false, error: 'partial failure', translations, failedIds: [...new Set(failedIds)] }
    : { ok: true, translations }
}

export type ConnectionTestResult = { ok: true } | { ok: false; error: string }

/** Turn a raw upstream error/status into an actionable Chinese message for the options UI. */
function describeUpstreamError(error: string, status?: number): string {
  if (status === 401 || status === 403) return `鉴权失败（HTTP ${status}）：请检查 API Key 是否正确。`
  if (status === 404) return 'HTTP 404：接口地址或模型名可能不正确。'
  if (status === 429) return 'HTTP 429：请求过于频繁或额度不足，请稍后再试。'
  if (status !== undefined && status >= 500) return `上游服务异常（HTTP ${status}），请稍后再试。`
  if (error === 'request timed out') return '请求超时：请检查网络或接口地址是否可达。'
  return error
}

/**
 * Fire one minimal translation request to verify the endpoint, key, and model.
 * Used by the options page's “测试连接” button; never writes to the cache.
 */
export async function testConnection(settings: UserSettings): Promise<ConnectionTestResult> {
  const userPrompt = buildTranslateUserPrompt('en', settings.targetLang, [
    { id: 't0', tag: 'p', text: 'Hello' },
  ])
  const request = {
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: SYSTEM,
    userPrompt,
    provider: settings.provider,
    reasoningPref: settings.reasoningPref,
    requestTimeoutMs: 15_000,
  }
  let result = await chatCompletionsJson({ ...request, useJsonSchema: true })
  // Some OpenAI-compatible servers reject json_schema; retry once with plain json_object.
  if (!result.ok && result.status === 400) {
    result = await chatCompletionsJson({ ...request, useJsonSchema: false })
  }
  if (!result.ok) {
    return { ok: false, error: describeUpstreamError(result.error, result.status) }
  }
  try {
    const parsed = parseTranslateBatchResult(JSON.parse(result.content), new Set(['t0']))
    if (!parsed.ok) return { ok: false, error: `响应格式无效：${parsed.error}` }
    const translation = parsed.items.find((item) => item.id === 't0')?.translation.trim()
    return translation
      ? { ok: true }
      : { ok: false, error: '响应格式无效：未返回测试翻译' }
  } catch {
    return { ok: false, error: '响应格式无效：模型未返回有效 JSON' }
  }
}

export function getCachedTranslation(
  pageKey: string,
  sourceLang: string,
  targetLang: string,
  text: string,
): string | undefined {
  const key = makeTranslationCacheKey(pageKey, sourceLang, targetLang, text)
  return textCache.get(key)
}


/**
 * Resolve cache hits by **normalized text** (not DOM id).
 * Dedupes API work: identical sentences → one missing representative.
 */
export function filterUncachedByText(
  pageKey: string,
  sourceLang: string,
  targetLang: string,
  blocks: TranslateBlock[],
): {
  cached: { id: string; translation: string }[]
  /** Unique texts only (one block per identical sentence). */
  missing: TranslateBlock[]
  /** hash → all block ids that share this text (for expanding results). */
  textHashToIds: Map<string, string[]>
  idToText: Map<string, string>
} {
  const cached: { id: string; translation: string }[] = []
  const missing: TranslateBlock[] = []
  const textHashToIds = new Map<string, string[]>()
  const idToText = new Map<string, string>()
  const seenMissingHash = new Set<string>()

  for (const b of blocks) {
    const norm = normalizeText(b.text)
    idToText.set(b.id, norm)
    const cacheKey = makeTranslationCacheKey(pageKey, sourceLang, targetLang, norm)
    const hit = textCache.get(cacheKey)
    if (hit !== undefined) {
      cached.push({ id: b.id, translation: hit })
      continue
    }

    // Group identical texts
    const h = cacheKey // full key already includes text hash
    const list = textHashToIds.get(h) ?? []
    list.push(b.id)
    textHashToIds.set(h, list)

    if (!seenMissingHash.has(h)) {
      seenMissingHash.add(h)
      // Representative for API (first id)
      missing.push({ id: b.id, tag: b.tag, text: norm })
    }
  }

  return { cached, missing, textHashToIds, idToText }
}

/** Expand API results for representative ids to every id sharing the same text. */
export function expandTranslationsToAllIds(
  pageKey: string,
  sourceLang: string,
  targetLang: string,
  representativeResults: { id: string; translation: string }[],
  idToText: Map<string, string>,
  textHashToIds: Map<string, string[]>,
): { id: string; translation: string }[] {
  const out: { id: string; translation: string }[] = []
  const written = new Set<string>()

  for (const r of representativeResults) {
    const text = idToText.get(r.id) ?? ''
    const cacheKey = makeTranslationCacheKey(pageKey, sourceLang, targetLang, text)
    textCache.set(cacheKey, r.translation)

    const ids = textHashToIds.get(cacheKey) ?? [r.id]
    for (const id of ids) {
      if (written.has(id)) continue
      written.add(id)
      out.push({ id, translation: r.translation })
    }
  }
  return out
}

/** Test helpers */
export function _resetTranslationCacheForTests(): void {
  textCache.clear()
  hydrationPromise = null
  persistenceChain = Promise.resolve()
  inFlightTranslations.clear()
}

export function _cacheStatsForTests(): { size: number; chars: number } {
  return { size: textCache.size, chars: textCache.charCount }
}
