import type { MeetingAudioChunkMsg } from '../shared/messages'
import type { UserSettings } from '../shared/settings-defaults'

const DNR_RULE_ID = 910_250
const WS_CONNECT_TIMEOUT_MS = 8_000
const SSE_ASR_ENDPOINT = 'https://api.stepfun.com/v1/audio/asr/sse'
const SSE_ASR_MODEL = 'stepaudio-2.5-asr'
const SSE_REQUEST_TIMEOUT_MS = 20_000

type RealtimeAsrEvent = {
  type?: unknown
  delta?: unknown
  text?: unknown
  transcript?: unknown
  message?: unknown
  error?: unknown
}

type RealtimeAsrCallbacks = {
  onDelta(text: string, message: MeetingAudioChunkMsg): void
  onCompleted(text: string, message: MeetingAudioChunkMsg): void
  onError(error: string, message: MeetingAudioChunkMsg): void
  onReady(message: MeetingAudioChunkMsg): void
}

export type SttResult =
  | { ok: true; text: string }
  | { ok: false; error: string; status?: number }

export class StepFunRealtimeAsrConnection {
  private ws: WebSocket | null = null
  private openPromise: Promise<void> | null = null
  private lastChunk: MeetingAudioChunkMsg | null = null
  private currentText = ''
  private currentStartedAt = 0
  private closed = false

  constructor(
    private readonly settings: UserSettings,
    private readonly callbacks: RealtimeAsrCallbacks,
  ) {}

  async append(message: MeetingAudioChunkMsg): Promise<void> {
    this.lastChunk = message
    if (!this.currentStartedAt) this.currentStartedAt = message.startedAt
    await this.ensureOpen(message)
    this.ws?.send(
      JSON.stringify({
        event_id: eventId('audio'),
        type: 'input_audio_buffer.append',
        audio: message.audioBase64,
      }),
    )
  }

  close(): void {
    this.closed = true
    this.ws?.close()
    this.ws = null
    this.openPromise = null
    this.currentText = ''
    this.currentStartedAt = 0
  }

  private async ensureOpen(message: MeetingAudioChunkMsg): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return
    if (this.openPromise) return this.openPromise

    const endpoint = this.settings.asrEndpoint.trim()
    const endpointError = asrStreamEndpointError(endpoint)
    if (endpointError) throw new Error(endpointError)
    const apiKey = this.settings.asrApiKey.trim()
    if (!apiKey) throw new Error('ASR API Key is not configured')

    this.closed = false
    this.openPromise = this.open(endpoint, apiKey, message)
    try {
      await this.openPromise
    } finally {
      this.openPromise = null
    }
  }

  private async open(endpoint: string, apiKey: string, message: MeetingAudioChunkMsg): Promise<void> {
    await ensureStepFunAsrAuthorizationRule(endpoint, apiKey)
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(endpoint)
      this.ws = ws
      let opened = false
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const timeout = globalThis.setTimeout(() => {
        fail(new Error('StepFun ASR WebSocket connection timed out'))
        ws.close()
      }, WS_CONNECT_TIMEOUT_MS)
      let errorFallback: ReturnType<typeof setTimeout> | null = null

      ws.addEventListener('open', () => {
        opened = true
        settled = true
        globalThis.clearTimeout(timeout)
        if (errorFallback) globalThis.clearTimeout(errorFallback)
        this.configureSession(message)
        this.callbacks.onReady(message)
        resolve()
      })
      ws.addEventListener('message', (event) => this.handleMessage(event))
      ws.addEventListener('error', () => {
        errorFallback = globalThis.setTimeout(() => {
          fail(new Error('StepFun ASR WebSocket connection failed before close details were available'))
        }, 750)
      })
      ws.addEventListener('close', (event) => {
        if (errorFallback) globalThis.clearTimeout(errorFallback)
        const detail = closeDetail(event)
        if (!opened) {
          globalThis.clearTimeout(timeout)
          fail(new Error(`StepFun ASR WebSocket closed during handshake${detail}`))
          return
        }
        if (!this.closed && this.lastChunk) {
          this.callbacks.onError(`StepFun ASR WebSocket closed${detail}`, this.lastChunk)
        }
        this.ws = null
      })
    })
  }

  private configureSession(message: MeetingAudioChunkMsg): void {
    this.ws?.send(
      JSON.stringify({
        event_id: eventId('session'),
        type: 'session.update',
        session: {
          audio: {
            input: {
              format: {
                type: 'pcm',
                codec: 'pcm_s16le',
                rate: 16000,
                bits: 16,
                channel: 1,
              },
              transcription: {
                model: this.settings.asrModel.trim() || 'stepaudio-2.5-asr-stream',
                prompt: 'Please transcribe the live meeting audio accurately.',
                full_rerun_on_commit: true,
                enable_itn: true,
                enable_timestamp_align: false,
                ...languageConfig(message.sourceLang),
              },
              turn_detection: {
                type: 'server_vad',
                silence_duration_ms: 800,
                threshold: 0.5,
              },
            },
          },
        },
      }),
    )
  }

  private handleMessage(event: MessageEvent): void {
    const payload = parseEvent(event.data)
    const type = stringValue(payload.type)
    if (type === 'error') {
      this.emitError(errorMessage(payload))
      return
    }

    if (type.includes('delta')) {
      const text = stringValue(payload.text)
      const delta = stringValue(payload.delta)
      if (!text && !delta) return
      this.currentText = text || `${this.currentText}${delta}`
      this.emitDelta(this.currentText)
      return
    }

    if (type.includes('completed') || type.includes('done')) {
      const text = eventText(payload) || this.currentText
      if (text.trim()) this.emitCompleted(text)
      this.currentText = ''
      this.currentStartedAt = 0
    }
  }

  private emitDelta(text: string): void {
    if (!this.lastChunk) return
    this.callbacks.onDelta(text, {
      ...this.lastChunk,
      startedAt: this.currentStartedAt || this.lastChunk.startedAt,
      endedAt: Date.now(),
    })
  }

  private emitCompleted(text: string): void {
    if (!this.lastChunk) return
    this.callbacks.onCompleted(text, {
      ...this.lastChunk,
      startedAt: this.currentStartedAt || this.lastChunk.startedAt,
      endedAt: Date.now(),
    })
  }

  private emitError(error: string): void {
    if (!this.lastChunk) return
    this.callbacks.onError(error, this.lastChunk)
  }
}

export async function clearStepFunAsrAuthorizationRule(): Promise<void> {
  await updateDnrRules({ removeRuleIds: [DNR_RULE_ID] })
}

export async function transcribeAudioChunkSse(input: {
  audioBase64: string
  mimeType: string
  sourceLang: string
  settings: UserSettings
}): Promise<SttResult> {
  if (!input.settings.asrApiKey.trim()) return { ok: false, error: 'ASR API Key is not configured' }
  if (!input.audioBase64.trim()) return { ok: true, text: '' }

  try {
    const response = await fetch(SSE_ASR_ENDPOINT, {
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
              model: SSE_ASR_MODEL,
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
        ? 'StepFun ASR fallback request timed out'
        : error instanceof Error
          ? error.message
          : 'StepFun ASR fallback network error',
    }
  }
}

export async function ensureSystemProxyMode(): Promise<void> {
  const proxySettings = chrome.proxy?.settings
  if (!proxySettings?.set) return
  await new Promise<void>((resolve, reject) => {
    proxySettings.set(
      {
        value: { mode: 'system' },
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

export async function ensureStepFunAsrAuthorizationRule(
  endpoint: string,
  apiKey: string,
): Promise<void> {
  if (!hasDnrApi()) return
  const url = new URL(endpoint)
  await updateDnrRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [
      {
        id: DNR_RULE_ID,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            {
              header: 'Authorization',
              operation: 'set',
              value: `Bearer ${apiKey}`,
            },
          ],
        },
        condition: {
          regexFilter: `^${escapeRegex(`${url.protocol}//${url.host}${url.pathname}`)}(?:\\?.*)?$`,
          resourceTypes: ['websocket'],
        },
      },
    ],
  })
}

async function updateDnrRules(options: {
  removeRuleIds?: number[]
  addRules?: unknown[]
}): Promise<void> {
  if (!hasDnrApi()) return
  const dnr = chrome.declarativeNetRequest as {
    updateDynamicRules(options: unknown): Promise<void>
  }
  await dnr.updateDynamicRules(options)
}

function hasDnrApi(): boolean {
  return Boolean(chrome.declarativeNetRequest?.updateDynamicRules)
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
    for (const rawEvent of splitBufferedSseEvents(buffer)) {
      const result = handleEvent(rawEvent)
      if (result) return result
    }
  }

  return { ok: true, text: doneText.length >= deltaText.length ? doneText : deltaText }
}

function parseSseEvent(rawEvent: string): RealtimeAsrEvent {
  const data = rawEvent
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
    .trim()
  if (!data || data === '[DONE]') return {}
  try {
    const value = JSON.parse(data)
    return value && typeof value === 'object' ? (value as RealtimeAsrEvent) : {}
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
    const data = JSON.parse(payload) as RealtimeAsrEvent
    return stringValue(data.text) || stringValue(data.delta) || stringValue(data.transcript)
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

function asrStreamEndpointError(endpoint: string): string | null {
  if (!endpoint) return 'ASR WebSocket endpoint is not configured'
  try {
    const url = new URL(endpoint)
    if (url.username || url.password) return 'ASR WebSocket endpoint must not include credentials'
    if (url.protocol !== 'wss:') return 'ASR WebSocket endpoint must use WSS'
    return null
  } catch {
    return 'ASR WebSocket endpoint is invalid'
  }
}

function parseEvent(data: unknown): RealtimeAsrEvent {
  if (typeof data !== 'string') return {}
  try {
    const value = JSON.parse(data)
    return value && typeof value === 'object' ? (value as RealtimeAsrEvent) : {}
  } catch {
    return {}
  }
}

function eventText(payload: RealtimeAsrEvent): string {
  return (
    stringValue(payload.transcript) ||
    stringValue(payload.text) ||
    stringValue(payload.delta)
  )
}

function errorMessage(payload: RealtimeAsrEvent): string {
  const error = payload.error
  if (error && typeof error === 'object' && 'message' in error) {
    return stringValue((error as { message?: unknown }).message) || 'StepFun ASR returned an error'
  }
  return stringValue(payload.message) || 'StepFun ASR returned an error'
}

function languageConfig(sourceLang: string): { language?: string } {
  if (sourceLang === 'auto') return {}
  if (sourceLang === 'cn') return { language: 'zh' }
  return { language: sourceLang }
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function eventId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function closeDetail(event: CloseEvent): string {
  const reason = event.reason.trim()
  return ` (code ${event.code}${reason ? `, ${reason}` : ''})`
}
