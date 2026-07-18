import { afterEach, describe, expect, it, vi } from 'vitest'
import { translateImage } from '../../src/background/translate'
import { DEFAULT_SETTINGS } from '../../src/shared/settings-defaults'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('translateImage', () => {
  it('embeds a fetched page image as multimodal model content', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"translation":"你好"}' } }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const result = await translateImage('https://images.example.test/promo.png', 'en', {
      ...DEFAULT_SETTINGS,
      apiKey: 'sk-test',
    })

    expect(result).toEqual({ ok: true, translation: '你好' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const modelRequest = fetchMock.mock.calls[1][1]
    if (!modelRequest || typeof modelRequest !== 'object' || !('body' in modelRequest)) {
      throw new Error('model request body missing')
    }
    const requestBody = JSON.parse(String(modelRequest.body))
    expect(requestBody.response_format.json_schema.name).toBe('image_translation_result')
    expect(requestBody.messages[1].content).toEqual([
      expect.objectContaining({ type: 'text' }),
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,iVBORw==' },
      },
    ])
  })

  it('rejects unsupported image MIME types before invoking the model', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      translateImage('https://images.example.test/vector.svg', 'en', {
        ...DEFAULT_SETTINGS,
        apiKey: 'sk-test',
      }),
    ).resolves.toEqual({ ok: false, error: 'unsupported image type: image/svg+xml' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects declared oversized images before buffering or model upload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1]), {
        headers: {
          'content-type': 'image/png',
          'content-length': '4000001',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      translateImage('https://images.example.test/huge.png', 'en', {
        ...DEFAULT_SETTINGS,
        apiKey: 'sk-test',
      }),
    ).resolves.toEqual({ ok: false, error: 'image is too large (max 4 MB)' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
