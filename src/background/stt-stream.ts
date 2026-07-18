import type { MeetingAudioChunkMsg } from '../shared/messages'
import type { UserSettings } from '../shared/settings-defaults'

const WS_CONNECT_TIMEOUT_MS = 8_000
const LOCAL_ASR_RELAY_ENDPOINT = 'ws://127.0.0.1:8787/realtime/asr/stream'

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
    const connectEndpoint = websocketConnectEndpoint(endpoint)
    const usesLocalRelay = isLocalRelayEndpoint(connectEndpoint)
    const needsRelayConnect = connectEndpoint !== endpoint || usesLocalRelay
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(connectEndpoint)
      this.ws = ws
      let connected = false
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      const timeout = globalThis.setTimeout(() => {
        fail(new Error(connectionFailureMessage(usesLocalRelay, 'timed out')))
        ws.close()
      }, WS_CONNECT_TIMEOUT_MS)
      let errorFallback: ReturnType<typeof setTimeout> | null = null

      ws.addEventListener('open', () => {
        if (needsRelayConnect) {
          ws.send(
            JSON.stringify({
              type: 'relay.connect',
              upstream: endpoint,
              apiKey,
            }),
          )
          return
        }
        connected = true
        settled = true
        globalThis.clearTimeout(timeout)
        if (errorFallback) globalThis.clearTimeout(errorFallback)
        this.configureSession(message)
        this.callbacks.onReady(message)
        resolve()
      })
      ws.addEventListener('message', (event) => {
        if (needsRelayConnect && !connected) {
          const relayPayload = parseEvent(event.data)
          const relayType = stringValue(relayPayload.type)
          if (relayType === 'relay.ready') {
            connected = true
            settled = true
            globalThis.clearTimeout(timeout)
            if (errorFallback) globalThis.clearTimeout(errorFallback)
            this.configureSession(message)
            this.callbacks.onReady(message)
            resolve()
            return
          }
          if (relayType === 'error') {
            fail(new Error(errorMessage(relayPayload)))
            ws.close()
            return
          }
        }
        this.handleMessage(event)
      })
      ws.addEventListener('error', () => {
        errorFallback = globalThis.setTimeout(() => {
          fail(new Error(connectionFailureMessage(usesLocalRelay, 'failed before close details were available')))
        }, 750)
      })
      ws.addEventListener('close', (event) => {
        if (errorFallback) globalThis.clearTimeout(errorFallback)
        const detail = closeDetail(event)
        if (!connected) {
          globalThis.clearTimeout(timeout)
          fail(new Error(`${connectionFailureMessage(usesLocalRelay, 'closed during handshake')}${detail}`))
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

function asrStreamEndpointError(endpoint: string): string | null {
  if (!endpoint) return 'ASR WebSocket endpoint is not configured'
  try {
    const url = new URL(endpoint)
    if (url.username || url.password) return 'ASR WebSocket endpoint must not include credentials'
    if (url.protocol === 'wss:') return null
    if (url.protocol === 'ws:' && isLoopbackHost(url.hostname)) return null
    return 'ASR WebSocket endpoint must use WSS, except loopback relay endpoints'
  } catch {
    return 'ASR WebSocket endpoint is invalid'
  }
}

function websocketConnectEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'wss:' && url.hostname === 'api.stepfun.com'
      ? LOCAL_ASR_RELAY_ENDPOINT
      : endpoint
  } catch {
    return endpoint
  }
}

function isLocalRelayEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    return url.protocol === 'ws:' && isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
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

function eventId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

function closeDetail(event: CloseEvent): string {
  const reason = event.reason.trim()
  return ` (code ${event.code}${reason ? `, ${reason}` : ''})`
}

function connectionFailureMessage(usesLocalRelay: boolean, detail: string): string {
  if (!usesLocalRelay) return `StepFun ASR WebSocket connection ${detail}`
  return `Local ASR relay connection ${detail}. Start it with: npm run asr:relay`
}
