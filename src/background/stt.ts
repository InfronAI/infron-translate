import { apiBaseUrlError, type UserSettings } from '../shared/settings-defaults'

const STT_MODEL = 'openai/whisper-1/audio-to-text'

export type SttResult =
  | { ok: true; text: string }
  | { ok: false; error: string; status?: number }

function joinUrl(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

export async function transcribeAudioChunk(input: {
  audioBase64: string
  mimeType: string
  sourceLang: string
  settings: UserSettings
}): Promise<SttResult> {
  const baseUrlError = apiBaseUrlError(input.settings.baseURL)
  if (baseUrlError) return { ok: false, error: baseUrlError }
  if (!input.settings.apiKey.trim()) return { ok: false, error: 'Cloud Model API Key is not configured' }

  const bytes = base64ToBytes(input.audioBase64)
  if (bytes.byteLength < 800) return { ok: true, text: '' }
  const form = new FormData()
  const ext = extensionForMime(input.mimeType)
  const audioBuffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(audioBuffer).set(bytes)
  form.append('file', new Blob([audioBuffer], { type: input.mimeType }), `meeting-audio.${ext}`)
  form.append('model', STT_MODEL)
  form.append('response_format', 'json')
  const language = whisperLanguage(input.sourceLang)
  if (language) form.append('language', language)

  try {
    const response = await fetch(joinUrl(input.settings.baseURL, '/audio/transcriptions'), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(45_000),
      headers: {
        Authorization: `Bearer ${input.settings.apiKey}`,
      },
      body: form,
    })
    if (!response.ok) {
      return { ok: false, error: `STT HTTP ${response.status}`, status: response.status }
    }
    const data = await response.json()
    const text = extractText(data)
    return { ok: true, text }
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError'
    return {
      ok: false,
      error: timedOut ? 'STT request timed out' : error instanceof Error ? error.message : 'STT network error',
    }
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('wav')) return 'wav'
  return 'webm'
}

function whisperLanguage(sourceLang: string): string {
  if (sourceLang === 'auto') return ''
  if (sourceLang === 'cn') return 'zh'
  return sourceLang
}

function extractText(data: unknown): string {
  if (!data || typeof data !== 'object' || !('text' in data)) return ''
  const text = (data as { text?: unknown }).text
  return typeof text === 'string' ? text.trim() : ''
}
