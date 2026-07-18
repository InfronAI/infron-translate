import type { UserSettings } from '../shared/settings-defaults'

const DEFAULT_SSE_ASR_ENDPOINT = 'https://api.stepfun.com/step_plan/v1/audio/asr/sse'
const SSE_REQUEST_TIMEOUT_MS = 30_000

type StepFunSseEvent = {
  type?: unknown
  delta?: unknown
  text?: unknown
  transcript?: unknown
  message?: unknown
  error?: unknown
}

export type SttResult =
  | { ok: true; text: string }
  | { ok: false; error: string; status?: number }

export async function transcribeAudioChunkSse(input: {
  audioBase64: string
  mimeType: string
  sourceLang: string
  settings: UserSettings
}): Promise<SttResult> {
  if (!input.settings.asrApiKey.trim()) return { ok: false, error: 'ASR API Key is not configured' }
  if (!input.audioBase64.trim()) return { ok: true, text: '' }

  const endpoint = input.settings.asrEndpoint.trim() || DEFAULT_SSE_ASR_ENDPOINT
  const endpointError = sseEndpointError(endpoint)
  if (endpointError) return { ok: false, error: endpointError }

  try {
    await applyAsrProxyMode(input.settings.asrUseSystemProxy)
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(SSE_REQUEST_TIMEOUT_MS),
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${input.settings.asrApiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audio: {
          data: input.audioBase64,
          input: {
            transcription: {
              model: input.settings.asrModel.trim() || 'stepaudio-2.5-asr',
              enable_itn: true,
              enable_timestamp: false,
              ...languageConfig(input.sourceLang),
            },
            format: audioFormat(input.mimeType),
          },
        },
      }),
    })
    if (!response.ok) {
      return {
        ok: false,
        error: `StepFun ASR HTTP ${response.status}${await responseErrorDetail(response)}`,
        status: response.status,
      }
    }
    const parsed = await parseStepFunSse(response)
    return parsed.ok ? { ok: true, text: parsed.text.trim() } : parsed
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return {
      ok: false,
      error: timedOut
        ? 'StepFun ASR SSE request timed out'
        : error instanceof Error
          ? error.message
          : 'StepFun ASR SSE network error',
    }
  }
}

async function applyAsrProxyMode(useSystemProxy: boolean): Promise<void> {
  const proxySettings = chrome.proxy?.settings
  if (!proxySettings?.set) return
  await new Promise<void>((resolve, reject) => {
    proxySettings.set(
      {
        value: { mode: useSystemProxy ? 'system' : 'direct' },
        scope: 'regular',
      },
      () => {
        const error = chrome.runtime.lastError
        if (error) reject(new Error(error.message))
        else resolve()
      },
    )
  })
}

async function parseStepFunSse(response: Response): Promise<SttResult> {
  if (!response.body) {
    const data = await response.text()
    return { ok: true, text: extractTextFromPayload(data) }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let deltaText = ''
  let doneText = ''

  const handleEvent = (rawEvent: string): SttResult | null => {
    const parsed = parseSseEvent(rawEvent)
    if (parsed.type === 'error') return { ok: false, error: errorMessage(parsed) }
    if (stringValue(parsed.type).includes('delta')) {
      deltaText = stringValue(parsed.text) || `${deltaText}${stringValue(parsed.delta)}`
    }
    if (stringValue(parsed.type).includes('done') || stringValue(parsed.type).includes('completed')) {
      doneText = eventText(parsed) || doneText
    }
    return null
  }

  while (true) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: !done })
    buffer = buffer.replace(/\r\n/gu, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const result = handleEvent(rawEvent)
      if (result) return result
      boundary = buffer.indexOf('\n\n')
    }
    if (done) break
  }

  if (buffer.trim()) {
    for (const rawEvent of splitBufferedSseEvents(buffer)) {
      const result = handleEvent(rawEvent)
      if (result) return result
    }
  }

  return { ok: true, text: doneText.length >= deltaText.length ? doneText : deltaText }
}

function parseSseEvent(rawEvent: string): StepFunSseEvent {
  const data = rawEvent
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()
  if (!data || data === '[DONE]') return {}
  try {
    const value = JSON.parse(data)
    return value && typeof value === 'object' ? (value as StepFunSseEvent) : {}
  } catch {
    return {}
  }
}

function splitBufferedSseEvents(buffer: string): string[] {
  const lines = buffer
    .split(/\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
  const dataLines = lines.filter((line) => line.startsWith('data:'))
  if (dataLines.length > 1) return dataLines
  if (dataLines.length === 1) return [buffer]
  return lines.filter((line) => line.startsWith('{')).map((line) => `data: ${line}`)
}

function extractTextFromPayload(payload: string): string {
  try {
    const data = JSON.parse(payload) as StepFunSseEvent
    return eventText(data)
  } catch {
    return ''
  }
}

async function responseErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text ? `: ${text.slice(0, 220)}` : ''
  } catch {
    return ''
  }
}

function audioFormat(mimeType: string): Record<string, string | number> {
  if (mimeType.includes('wav')) return { type: 'wav' }
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return { type: 'mp3' }
  if (mimeType.includes('ogg')) return { type: 'ogg' }
  return {
    type: 'pcm',
    codec: 'pcm_s16le',
    rate: 16000,
    bits: 16,
    channel: 1,
  }
}

function sseEndpointError(endpoint: string): string | null {
  try {
    const url = new URL(endpoint)
    if (url.username || url.password) return 'ASR SSE endpoint must not include credentials'
    if (url.protocol !== 'https:') return 'ASR SSE endpoint must use HTTPS'
    return null
  } catch {
    return 'ASR SSE endpoint is invalid'
  }
}

function eventText(payload: StepFunSseEvent): string {
  return (
    stringValue(payload.transcript) ||
    stringValue(payload.text) ||
    stringValue(payload.delta)
  )
}

function errorMessage(payload: StepFunSseEvent): string {
  const error = payload.error
  if (error && typeof error === 'object' && 'message' in error) {
    return stringValue((error as { message?: unknown }).message) || 'StepFun ASR returned an error event'
  }
  return stringValue(payload.message) || 'StepFun ASR returned an error event'
}

function languageConfig(sourceLang: string): { language?: string } {
  if (sourceLang === 'auto') return {}
  if (sourceLang === 'cn') return { language: 'zh' }
  return { language: sourceLang }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
