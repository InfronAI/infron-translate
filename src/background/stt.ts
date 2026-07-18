import type { UserSettings } from '../shared/settings-defaults'

const STEPFUN_ASR_SSE_URL = 'https://api.stepfun.com/v1/audio/asr/sse'
const STEPFUN_ASR_MODEL = 'stepaudio-2.5-asr'

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
  if (!input.settings.apiKey.trim()) return { ok: false, error: 'StepFun API Key is not configured' }
  if (!input.audioBase64.trim()) return { ok: true, text: '' }

  try {
    const response = await fetch(STEPFUN_ASR_SSE_URL, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(45_000),
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${input.settings.apiKey.trim()}`,
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

  while (true) {
    const { done, value } = await reader.read()
    if (value) buffer += decoder.decode(value, { stream: !done })
    buffer = buffer.replace(/\r\n/gu, '\n')
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const rawEvent = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const parsed = parseSseEvent(rawEvent)
      if (parsed.type === 'error') {
        return { ok: false, error: stringValue(parsed.message) || 'StepFun ASR returned an error event' }
      }
      if (parsed.type === 'transcript.text.delta') deltaText += stringValue(parsed.delta)
      if (parsed.type === 'transcript.text.done') doneText = stringValue(parsed.text)
      boundary = buffer.indexOf('\n\n')
    }
    if (done) break
  }

  if (buffer.trim()) {
    const parsed = parseSseEvent(buffer)
    if (parsed.type === 'error') {
      return { ok: false, error: stringValue(parsed.message) || 'StepFun ASR returned an error event' }
    }
    if (parsed.type === 'transcript.text.done') doneText = stringValue(parsed.text)
    if (parsed.type === 'transcript.text.delta') deltaText += stringValue(parsed.delta)
  }

  return { ok: true, text: doneText || deltaText }
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

function languageConfig(sourceLang: string): { language?: string } {
  if (sourceLang === 'auto') return {}
  if (sourceLang === 'cn') return { language: 'zh' }
  return { language: sourceLang }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
