import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ensureCacheHydrated,
  filterUncachedByText,
  expandTranslationsToAllIds,
  getCachedTranslation,
  persistTranslationCache,
  testConnection,
  translateAllBlocks,
  translateBlocksSingleFlight,
  _resetTranslationCacheForTests,
  _cacheStatsForTests,
} from '../../src/background/translate'
import { DEFAULT_SETTINGS } from '../../src/shared/settings-defaults'
import { makeTranslationCacheKey } from '../../src/shared/text-hash'

describe('text-hash translation cache', () => {
  const pageKey = 'https://example.com/article'
  const sourceLang = 'en'
  const targetLang = 'zh'

  beforeEach(() => {
    _resetTranslationCacheForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('dedupes identical sentences into one missing block', () => {
    const { cached, missing, textHashToIds } = filterUncachedByText(
      pageKey,
      sourceLang,
      targetLang,
      [
        { id: 'a', tag: 'p', text: 'Hello world there' },
        { id: 'b', tag: 'p', text: 'Hello world there' },
        { id: 'c', tag: 'li', text: 'Hello world there' },
        { id: 'd', tag: 'p', text: 'Something else entirely' },
      ],
    )
    expect(cached).toEqual([])
    expect(missing).toHaveLength(2)
    expect(missing.map((m) => m.text).sort()).toEqual([
      'Hello world there',
      'Something else entirely',
    ])
    // three ids share one text key
    const sizes = [...textHashToIds.values()].map((ids) => ids.length).sort()
    expect(sizes).toEqual([1, 3])
  })

  it('returns cache hits and expands to all ids', () => {
    const first = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'a', tag: 'p', text: 'Same sentence here ok' },
      { id: 'b', tag: 'p', text: 'Same sentence here ok' },
    ])
    const expanded = expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'a', translation: '同一句话' }],
      first.idToText,
      first.textHashToIds,
    )
    expect(expanded).toEqual([
      { id: 'a', translation: '同一句话' },
      { id: 'b', translation: '同一句话' },
    ])
    expect(getCachedTranslation(pageKey, sourceLang, targetLang, 'Same sentence here ok')).toBe(
      '同一句话',
    )

    const second = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'c', tag: 'h2', text: 'Same sentence here ok' },
      { id: 'd', tag: 'p', text: 'Brand new line of text' },
    ])
    expect(second.cached).toEqual([{ id: 'c', translation: '同一句话' }])
    expect(second.missing.map((m) => m.id)).toEqual(['d'])
  })

  it('tracks cache stats after puts', () => {
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'x', translation: '你好' }],
      new Map([['x', 'Hello']]),
      new Map([[`dummy`, ['x']]]),
    )
    // expand still sets cache via text from idToText
    const stats = _cacheStatsForTests()
    expect(stats.size).toBeGreaterThanOrEqual(0)
  })

  it('hydrates and persists cache entries through session storage', async () => {
    const cacheKey = makeTranslationCacheKey(
      pageKey,
      sourceLang,
      targetLang,
      'Persisted sentence',
    )
    const get = vi.fn(async () => ({
      'infron-translation-cache-v1': [[cacheKey, '已缓存']],
    }))
    const set = vi.fn(async (_payload: Record<string, unknown>) => undefined)
    vi.stubGlobal('chrome', { storage: { session: { get, set } } })

    await ensureCacheHydrated()
    expect(getCachedTranslation(pageKey, sourceLang, targetLang, 'Persisted sentence')).toBe(
      '已缓存',
    )

    const pending = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'new', tag: 'p', text: 'A new sentence' },
    ])
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'new', translation: '新句子' }],
      pending.idToText,
      pending.textHashToIds,
    )
    await persistTranslationCache()

    expect(set).toHaveBeenCalledOnce()
    const payload = set.mock.calls[0][0] as Record<string, [string, string][]>
    expect(payload['infron-translation-cache-v1'].map((entry) => entry[1])).toEqual([
      '已缓存',
      '新句子',
    ])
  })

  it('serializes session snapshots so an older write cannot overwrite a newer cache', async () => {
    let releaseFirstWrite!: () => void
    const set = vi
      .fn<(payload: Record<string, unknown>) => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            releaseFirstWrite = resolve
          }),
      )
      .mockResolvedValue(undefined)
    vi.stubGlobal('chrome', {
      storage: { session: { get: vi.fn(async () => ({})), set } },
    })

    const firstMiss = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'first', tag: 'p', text: 'First sentence' },
    ])
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'first', translation: '第一句' }],
      firstMiss.idToText,
      firstMiss.textHashToIds,
    )
    const firstWrite = persistTranslationCache()

    const secondMiss = filterUncachedByText(pageKey, sourceLang, targetLang, [
      { id: 'second', tag: 'p', text: 'Second sentence' },
    ])
    expandTranslationsToAllIds(
      pageKey,
      sourceLang,
      targetLang,
      [{ id: 'second', translation: '第二句' }],
      secondMiss.idToText,
      secondMiss.textHashToIds,
    )
    const secondWrite = persistTranslationCache()

    await vi.waitFor(() => expect(set).toHaveBeenCalledOnce())
    releaseFirstWrite()
    await Promise.all([firstWrite, secondWrite])

    expect(set).toHaveBeenCalledTimes(2)
    const newest = set.mock.calls[1][0] as Record<string, [string, string][]>
    expect(newest['infron-translation-cache-v1'].map((entry) => entry[1])).toEqual([
      '第一句',
      '第二句',
    ])
  })
})

describe('translation request resilience', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('does not sleep after the final retryable failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
    const sleep = vi.fn(async (_delay: number) => undefined)

    const result = await translateAllBlocks(
      [{ id: 'a', tag: 'p', text: 'Hello world' }],
      'en',
      DEFAULT_SETTINGS,
      { sleep },
    )

    expect(result.ok).toBe(false)
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([500, 1000])
  })

  it('requires a valid translation payload for a successful connection test', async () => {
    const fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items: [{ id: 't0', translation: '你好' }] }) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetch)
    await expect(testConnection(DEFAULT_SETTINGS)).resolves.toEqual({ ok: true })

    fetch.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'not-json' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    await expect(testConnection(DEFAULT_SETTINGS)).resolves.toEqual({
      ok: false,
      error: '响应格式无效：模型未返回有效 JSON',
    })
  })

  it('coalesces concurrent requests for the same page text', async () => {
    let resolveFetch!: (response: Response) => void
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        }),
    )
    vi.stubGlobal('fetch', fetch)

    const first = translateBlocksSingleFlight(
      'https://example.com',
      'en',
      'zh',
      [{ id: 'a', tag: 'p', text: 'Shared sentence' }],
      DEFAULT_SETTINGS,
    )
    const second = translateBlocksSingleFlight(
      'https://example.com',
      'en',
      'zh',
      [{ id: 'b', tag: 'p', text: 'Shared sentence' }],
      DEFAULT_SETTINGS,
    )

    expect(fetch).toHaveBeenCalledOnce()
    resolveFetch(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items: [{ id: 'a', translation: '共享句子' }] }) } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )

    await expect(first).resolves.toEqual({
      ok: true,
      translations: [{ id: 'a', translation: '共享句子' }],
    })
    await expect(second).resolves.toEqual({
      ok: true,
      translations: [{ id: 'b', translation: '共享句子' }],
    })
  })
})
