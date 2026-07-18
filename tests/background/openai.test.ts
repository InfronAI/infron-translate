import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatCompletionsJson } from '../../src/background/openai'

describe('chatCompletionsJson', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [{ id: 'a', translation: '你好' }],
                }),
              },
            },
          ],
        }),
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to baseURL/chat/completions with Authorization', async () => {
    const result = await chatCompletionsJson({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      model: 'gpt-test',
      systemPrompt: 'sys',
      userPrompt: 'user',
      useJsonSchema: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toContain('你好')
    }
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-x')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('gpt-test')
    expect(body.response_format.type).toBe('json_schema')
  })

  it('does not inject provider-specific fields for Infron', async () => {
    await chatCompletionsJson({
      baseURL: 'https://llm.onerouter.pro/v1',
      apiKey: 'sk-x',
      model: 'deepseek/deepseek-v3.2',
      systemPrompt: 'sys',
      userPrompt: 'user',
      useJsonSchema: false,
      provider: 'infron',
      reasoningPref: 'off',
    })
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('does not inject provider-specific fields for OpenRouter', async () => {
    await chatCompletionsJson({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-x',
      model: 'openai/gpt-4o-mini',
      systemPrompt: 'sys',
      userPrompt: 'user',
      useJsonSchema: false,
      provider: 'openrouter',
      reasoningPref: 'off',
    })
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('returns error on non-OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      }),
    )
    const result = await chatCompletionsJson({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'bad',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      useJsonSchema: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/401/)
  })

  it('rejects insecure remote endpoints before sending the API key', async () => {
    const result = await chatCompletionsJson({
      baseURL: 'http://api.example.com/v1',
      apiKey: 'sk-secret',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      useJsonSchema: false,
    })

    expect(result).toEqual({ ok: false, error: 'Remote Base URL must use HTTPS' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects malformed completion JSON at the network boundary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ choices: null }),
      }),
    )
    const result = await chatCompletionsJson({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      useJsonSchema: false,
    })

    expect(result).toEqual({ ok: false, error: 'completion choices missing' })
  })
})
