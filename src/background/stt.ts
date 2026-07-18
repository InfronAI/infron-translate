import type { UserSettings } from '../shared/settings-defaults'

const STEPFUN_ASR_MODEL = 'stepaudio-2.5-asr'
const STT_REQUEST_TIMEOUT_MS = 20_000

export type SttResult =
  | { ok: true; text: string }
  | { ok: false; error: string; status?: number }

type StepFunSseEvent = {
  type?: unknown
  delta?: unknown
  text?: unknown
  message?: unknown
}

export async function transcribeAudioChunk(input: {
  audioBase64: string
  mimeType: string
  sourceLang: string
  settings: UserSettings
}): Promise<SttResult> {
  const endpoint = input.settings.asrEndpoint.trim()
  const endpointError = asrEndpointError(endpoint)
  if (endpointError) return { ok: false, error: endpointError }
  if (!input.settings.asrApiKey.trim()) return { ok: false, error: 'ASR API Key is not configured' }
  if (!input.audioBase64.trim()) return { ok: true, text: '' }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(STT_REQUEST_TIMEOUT_MS),
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
              model: STEPFUN_ASR_MODEL,
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
        ? 'StepFun ASR request timed out'
        : error instanceof Error
          ? error.message
          : 'StepFun ASR network error',
    }
  }
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
    if (parsed.type === 'error') {
      return { ok: false, error: stringValue(parsed.message) || 'StepFun ASR returned an error event' }
    }
    if (parsed.type === 'transcript.text.delta') deltaText += stringValue(parsed.delta)
    if (parsed.type === 'transcript.text.done') doneText = stringValue(parsed.text)
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
    const events = splitBufferedSseEvents(buffer)
    for (const rawEvent of events) {
      const result = handleEvent(rawEvent)
      if (result) return result
    }
  }

  return { ok: true, text: doneText.length >= deltaText.length ? doneText : deltaText }
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

async function responseErrorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/g, ' ').trim()
    return text ? `: ${text.slice(0, 220)}` : ''
  } catch {
    return ''
  }
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

function extractTextFromPayload(payload: string): string {
  try {
    const data = JSON.parse(payload) as StepFunSseEvent
    return stringValue(data.text) || stringValue(data.delta)
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

function asrEndpointError(endpoint: string): string | null {
  if (!endpoint) return 'ASR endpoint is not configured'
  try {
    const url = new URL(endpoint)
    if (url.username || url.password) return 'ASR endpoint must not include credentials'
    if (url.protocol !== 'https:') return 'ASR endpoint must use HTTPS'
    return null
  } catch {
    return 'ASR endpoint is invalid'
  }
}

function languageConfig(sourceLang: string): { language?: string } {
  if (sourceLang === 'auto') return {}
  if (sourceLang === 'cn') return { language: 'zh' }
  return { language: sourceLang }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
