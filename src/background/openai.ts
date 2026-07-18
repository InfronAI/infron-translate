import { TRANSLATE_BATCH_JSON_SCHEMA } from '../shared/schema'
import {
  applyProviderRequestBody,
  resolveProvider,
  type ProviderId,
  type ReasoningPref,
} from '../shared/providers'
import { apiBaseUrlError } from '../shared/settings-defaults'

export type ChatUserContent =
  | string
  | { type: 'text'; text: string }[]

export type ChatJsonParams = {
  baseURL: string
  apiKey: string
  model: string
  systemPrompt: string
  userPrompt: string
  /** Optional structured user content; defaults to userPrompt. */
  userContent?: ChatUserContent
  useJsonSchema: boolean
  jsonSchema?: Readonly<Record<string, unknown>>
  /** auto / openai / deepseek / stepfun */
  provider?: ProviderId
  /** off = disable or lowest reasoning (default) */
  reasoningPref?: ReasoningPref
  requestTimeoutMs?: number
}

export type ChatJsonResult =
  | { ok: true; content: string }
  | { ok: false; error: string; status?: number }

function joinUrl(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

/** Send one validated Chat Completions request; secrets remain in the service worker. */
export async function chatCompletionsJson(params: ChatJsonParams): Promise<ChatJsonResult> {
  const baseUrlError = apiBaseUrlError(params.baseURL)
  if (baseUrlError) return { ok: false, error: baseUrlError }

  const url = joinUrl(params.baseURL, '/chat/completions')
  const provider = resolveProvider(params.provider, params.baseURL, params.model)
  const reasoning = params.reasoningPref ?? 'off'
  const body: Record<string, unknown> = {
    model: params.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userContent ?? params.userPrompt },
    ],
  }

  applyProviderRequestBody(body, provider, reasoning)
  body.response_format = params.useJsonSchema
    ? {
        type: 'json_schema',
        json_schema: params.jsonSchema ?? TRANSLATE_BATCH_JSON_SCHEMA,
      }
    : { type: 'json_object' }

  let response = await postCompletion(url, params.apiKey, body, params.requestTimeoutMs)
  if (!response.ok) return response

  if (
    response.response.status === 400 &&
    (body.thinking !== undefined || body.reasoning_effort !== undefined)
  ) {
    const stripped = { ...body }
    delete stripped.thinking
    delete stripped.reasoning_effort
    response = await postCompletion(url, params.apiKey, stripped, params.requestTimeoutMs)
    if (!response.ok) return response
  }

  if (!response.response.ok) {
    return {
      ok: false,
      error: `HTTP ${response.response.status}`,
      status: response.response.status,
    }
  }

  try {
    return extractContent(await response.response.json())
  } catch {
    return { ok: false, error: 'invalid JSON response' }
  }
}

async function postCompletion(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<{ ok: true; response: Response } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })
    return { ok: true, response }
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return {
      ok: false,
      error: timedOut ? 'request timed out' : error instanceof Error ? error.message : 'network error',
    }
  }
}

/** Validate the small network response surface before reading model content. */
function extractContent(data: unknown): ChatJsonResult {
  if (!data || typeof data !== 'object' || !('choices' in data) || !Array.isArray(data.choices)) {
    return { ok: false, error: 'completion choices missing' }
  }
  const first = data.choices[0]
  if (!first || typeof first !== 'object' || !('message' in first)) {
    return { ok: false, error: 'completion message missing' }
  }
  const message = first.message
  if (!message || typeof message !== 'object' || !('content' in message)) {
    return { ok: false, error: 'completion content missing' }
  }
  return typeof message.content === 'string' && message.content.trim()
    ? { ok: true, content: message.content }
    : { ok: false, error: 'empty completion content' }
}
