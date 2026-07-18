import type { MeetingSession } from '../shared/meeting'
import type {
  MeetingAudioChunkMsg,
  MeetingAudioStatusMsg,
  MeetingTranscriptSegmentMsg,
} from '../shared/messages'
import type { UserSettings } from '../shared/settings-defaults'
import { transcribeAudioChunkSse } from '../background/stt-stream'

const AUDIO_CHUNK_MS = 500
const SSE_REQUEST_INTERVAL_MS = 13_000
const SSE_RATE_LIMIT_BACKOFF_MS = 65_000

type InternalMeetingAudioStartMsg = {
  type: 'meeting-audio-start'
  session: MeetingSession
  outputStreamId?: string
}

type InternalMeetingAudioStopMsg = {
  type: 'meeting-audio-stop'
}

type InternalMeetingAsrAudioMsg = {
  type: 'meeting-asr-audio'
  settings: UserSettings
  chunk: MeetingAudioChunkMsg
  uiLanguage: MeetingSession['uiLanguage']
}

type InternalMeetingAsrStopMsg = {
  type: 'meeting-asr-stop'
  sessionId?: string
  channel?: MeetingAudioChunkMsg['channel']
}

let streams: MediaStream[] = []
let playback: HTMLAudioElement | null = null
let audioContext: AudioContext | null = null
let outputSource: MediaStreamAudioSourceNode | null = null
let levelTimer: ReturnType<typeof setInterval> | null = null
let pcmWorklet: AudioWorkletNode | null = null
let pcmSilentGain: GainNode | null = null
let pcmTimer: ReturnType<typeof setInterval> | null = null
let pcmBuffers: Int16Array[] = []
let chunkStartedAt = 0
let maxLevelSinceChunk = 0
const sseBuffers = new Map<string, SseBuffer>()

type SseBuffer = {
  messages: InternalMeetingAsrAudioMsg[]
  timer: ReturnType<typeof setTimeout> | null
  inFlight: boolean
  blockedUntil: number
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isRecord(message) || typeof message.type !== 'string') return false

  if (message.type === 'meeting-audio-start' && isMeetingAudioStart(message)) {
    void startCapture(message.session, message.outputStreamId)
    return false
  }

  if (message.type === 'meeting-audio-stop') {
    stopCapture()
    return false
  }

  if (message.type === 'meeting-asr-audio' && isMeetingAsrAudio(message)) {
    void appendAsrAudio(message)
    return false
  }

  if (message.type === 'meeting-asr-stop' && isMeetingAsrStop(message)) {
    stopAsr(message.sessionId, message.channel)
    return false
  }

  return false
})

async function startCapture(session: MeetingSession, outputStreamId?: string): Promise<void> {
  stopCapture()
  if (session.audioMode === 'mock') return

  let outputReady = false
  if (outputStreamId) {
    try {
      const tabAudio = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: outputStreamId,
          },
        } as MediaTrackConstraints,
        video: false,
      })
      streams.push(tabAudio)
      playback = new Audio()
      playback.srcObject = tabAudio
      await playback.play()
      startOutputLevelMeter(session.id, tabAudio)
      await startOutputRecorder(session, tabAudio)
      outputReady = true
    } catch (error) {
      console.warn(
        '[Infron Translate] meeting audio capture failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  await sendAudioStatus({
    type: 'meeting-audio-status',
    sessionId: session.id,
    microphone: false,
    output: outputReady,
    transcription: {
      active: false,
      source: 'none',
      message:
        session.audioMode === 'tab-only'
          ? 'Tab audio is captured. StepFun HTTP + SSE will receive collected audio chunks.'
          : 'Click Start mic in the visible Meeting Assistant window to begin microphone transcription.',
    },
  })
}

function stopCapture(): void {
  if (levelTimer) {
    globalThis.clearInterval(levelTimer)
    levelTimer = null
  }
  if (pcmTimer) {
    globalThis.clearInterval(pcmTimer)
    pcmTimer = null
  }
  if (pcmWorklet) {
    pcmWorklet.port.onmessage = null
    pcmWorklet.disconnect()
    pcmWorklet = null
  }
  if (pcmSilentGain) {
    pcmSilentGain.disconnect()
    pcmSilentGain = null
  }
  if (outputSource) {
    outputSource.disconnect()
    outputSource = null
  }
  pcmBuffers = []
  chunkStartedAt = 0
  maxLevelSinceChunk = 0
  if (audioContext) {
    void audioContext.close()
    audioContext = null
  }
  if (playback) {
    playback.pause()
    playback.srcObject = null
    playback = null
  }
  for (const stream of streams) {
    for (const track of stream.getTracks()) track.stop()
  }
  streams = []
}

function startOutputLevelMeter(sessionId: string, stream: MediaStream): void {
  if (levelTimer) globalThis.clearInterval(levelTimer)
  if (audioContext) void audioContext.close()
  audioContext = new AudioContext()
  outputSource = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 512
  outputSource.connect(analyser)
  const data = new Uint8Array(analyser.fftSize)
  levelTimer = globalThis.setInterval(() => {
    analyser.getByteTimeDomainData(data)
    void sendAudioStatus({
      type: 'meeting-audio-status',
      sessionId,
      output: true,
      outputLevel: updateChunkLevel(rmsLevel(data)),
    })
  }, 500)
}

async function startOutputRecorder(session: MeetingSession, stream: MediaStream): Promise<void> {
  if (!audioContext) return
  pcmBuffers = []
  chunkStartedAt = Date.now()
  outputSource ??= audioContext.createMediaStreamSource(stream)
  await ensurePcmWorklet(audioContext)
  pcmWorklet = new AudioWorkletNode(audioContext, 'pcm-capture-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  })
  pcmSilentGain = audioContext.createGain()
  pcmSilentGain.gain.value = 0
  pcmWorklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
    pcmBuffers.push(floatTo16kPcm(event.data, audioContext?.sampleRate ?? 48000))
  }
  outputSource.connect(pcmWorklet)
  pcmWorklet.connect(pcmSilentGain)
  pcmSilentGain.connect(audioContext.destination)
  pcmTimer = globalThis.setInterval(() => {
    const endedAt = Date.now()
    const startedAt = chunkStartedAt || endedAt - AUDIO_CHUNK_MS
    chunkStartedAt = endedAt
    maxLevelSinceChunk = 0
    const bytes = mergePcmBuffers(pcmBuffers)
    pcmBuffers = []
    if (bytes.byteLength < 8000) return
    void sendAudioChunk({
      type: 'meeting-audio-chunk',
      sessionId: session.id,
      channel: 'meeting-output',
      sourceLang: session.sourceLang,
      mimeType: 'audio/pcm',
      audioBase64: bytesToBase64(bytes),
      startedAt,
      endedAt,
    })
  }, AUDIO_CHUNK_MS)
}

async function ensurePcmWorklet(context: AudioContext): Promise<void> {
  await context.audioWorklet.addModule(chrome.runtime.getURL('worklets/pcm-capture.js'))
}

function updateChunkLevel(level: number): number {
  maxLevelSinceChunk = Math.max(maxLevelSinceChunk, level)
  return level
}

async function sendAudioChunk(message: MeetingAudioChunkMsg): Promise<void> {
  try {
    if (!message.audioBase64) return
    await chrome.runtime.sendMessage(message satisfies MeetingAudioChunkMsg)
  } catch {
    // Best-effort streaming: dropping one chunk should not stop capture.
  }
}

async function appendAsrAudio(message: InternalMeetingAsrAudioMsg): Promise<void> {
  queueSseTranscription(message)
}

function queueSseTranscription(message: InternalMeetingAsrAudioMsg): void {
  const key = asrKey(message.chunk.sessionId, message.chunk.channel)
  const buffer = sseBuffers.get(key) ?? {
    messages: [],
    timer: null,
    inFlight: false,
    blockedUntil: 0,
  }
  buffer.messages.push(message)
  sseBuffers.set(key, buffer)
  void sendAudioStatus({
    type: 'meeting-audio-status',
    sessionId: message.chunk.sessionId,
    transcription: {
      active: true,
      source: 'external-stt',
      message: sseQueuedMessage(message.uiLanguage, message.chunk.channel),
    },
  })
  if (buffer.timer || buffer.inFlight) return
  const delay = Math.max(SSE_REQUEST_INTERVAL_MS, buffer.blockedUntil - Date.now())
  buffer.timer = globalThis.setTimeout(() => {
    buffer.timer = null
    void flushSseTranscription(key)
  }, delay)
}

async function flushSseTranscription(key: string): Promise<void> {
  const buffer = sseBuffers.get(key)
  if (!buffer || buffer.inFlight || !buffer.messages.length) return
  const message = mergeSseMessages(buffer.messages)
  buffer.messages = []
  buffer.inFlight = true
  try {
    await transcribeWithSse(message, key)
  } finally {
    buffer.inFlight = false
    if (buffer.messages.length) {
      const delay = Math.max(SSE_REQUEST_INTERVAL_MS, buffer.blockedUntil - Date.now())
      buffer.timer = globalThis.setTimeout(() => {
        buffer.timer = null
        void flushSseTranscription(key)
      }, delay)
    }
  }
}

function mergeSseMessages(messages: InternalMeetingAsrAudioMsg[]): InternalMeetingAsrAudioMsg {
  const first = messages[0]
  const last = messages[messages.length - 1]
  const bytes = mergeBase64Pcm(messages.map((item) => item.chunk.audioBase64))
  return {
    ...last,
    chunk: {
      ...last.chunk,
      audioBase64: bytesToBase64(bytes),
      startedAt: first.chunk.startedAt,
      endedAt: last.chunk.endedAt,
    },
  }
}

async function transcribeWithSse(message: InternalMeetingAsrAudioMsg, key: string): Promise<void> {
  const result = await transcribeAudioChunkSse({
    audioBase64: message.chunk.audioBase64,
    mimeType: message.chunk.mimeType,
    sourceLang: message.chunk.sourceLang,
    settings: message.settings,
  })
  if (!result.ok) {
    const buffer = sseBuffers.get(key)
    if (result.status === 429 && buffer) buffer.blockedUntil = Date.now() + SSE_RATE_LIMIT_BACKOFF_MS
    await sendAudioStatus({
      type: 'meeting-audio-status',
      sessionId: message.chunk.sessionId,
      transcription: {
        active: false,
        source: 'external-stt',
        message: asrFailedMessage(message.uiLanguage, result.error),
      },
    })
    return
  }
  const text = result.text.trim()
  if (!text) return
  await chrome.runtime.sendMessage({
    type: 'meeting-transcript-segment',
    sessionId: message.chunk.sessionId,
    channel: message.chunk.channel,
    speakerLabel: '',
    sourceLang: message.chunk.sourceLang,
    originalText: text,
    startedAt: message.chunk.startedAt,
    endedAt: message.chunk.endedAt,
  } satisfies MeetingTranscriptSegmentMsg)
}

function stopAsr(sessionId?: string, channel?: MeetingAudioChunkMsg['channel']): void {
  for (const key of sseBuffers.keys()) {
    const [streamSessionId, streamChannel] = key.split(':')
    if (sessionId && streamSessionId !== sessionId) continue
    if (channel && streamChannel !== channel) continue
    clearSseBuffer(key)
  }
}

function asrKey(sessionId: string, channel: MeetingAudioChunkMsg['channel']): string {
  return `${sessionId}:${channel}`
}

function clearSseBuffer(key: string): void {
  const buffer = sseBuffers.get(key)
  if (buffer?.timer) globalThis.clearTimeout(buffer.timer)
  sseBuffers.delete(key)
}

function asrFailedMessage(language: MeetingSession['uiLanguage'], error: string): string {
  return language === 'zh' ? `StepFun ASR 失败：${error}` : `StepFun ASR failed: ${error}`
}

function sseQueuedMessage(
  language: MeetingSession['uiLanguage'],
  channel: MeetingAudioChunkMsg['channel'],
): string {
  const zh = language === 'zh'
  const source = zh
    ? channel === 'microphone'
      ? '麦克风'
      : '系统音频'
    : channel === 'microphone'
      ? 'microphone'
      : 'system audio'
  return zh
    ? `正在收集${source}音频，并通过 StepFun HTTP + SSE 识别。`
    : `Collecting ${source} audio for StepFun HTTP + SSE transcription.`
}

function mergeBase64Pcm(chunks: string[]): Uint8Array {
  const buffers = chunks.map(base64ToBytes)
  const byteLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0)
  const merged = new Uint8Array(byteLength)
  let offset = 0
  for (const buffer of buffers) {
    merged.set(buffer, offset)
    offset += buffer.byteLength
  }
  return merged
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function mergePcmBuffers(buffers: Int16Array[]): Uint8Array {
  const sampleCount = buffers.reduce((sum, buffer) => sum + buffer.length, 0)
  const bytes = new Uint8Array(sampleCount * 2)
  let offset = 0
  for (const buffer of buffers) {
    bytes.set(new Uint8Array(buffer.buffer), offset)
    offset += buffer.byteLength
  }
  return bytes
}

function floatTo16kPcm(input: Float32Array, inputSampleRate: number): Int16Array {
  const ratio = inputSampleRate / 16000
  const outputLength = Math.max(1, Math.floor(input.length / ratio))
  const output = new Int16Array(outputLength)
  for (let index = 0; index < outputLength; index += 1) {
    const sample = input[Math.min(input.length - 1, Math.floor(index * ratio))]
    const clamped = Math.max(-1, Math.min(1, sample))
    output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return output
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function rmsLevel(data: Uint8Array): number {
  let sum = 0
  for (const value of data) {
    const centered = (value - 128) / 128
    sum += centered * centered
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 4)
}

async function sendAudioStatus(message: MeetingAudioStatusMsg): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message)
  } catch {
    // The service worker may have stopped between capture events.
  }
}

function isMeetingAudioStart(value: unknown): value is InternalMeetingAudioStartMsg {
  if (!isRecord(value) || value.type !== 'meeting-audio-start') return false
  return (
    isRecord(value.session) &&
    typeof value.session.id === 'string' &&
    (value.outputStreamId === undefined || typeof value.outputStreamId === 'string')
  )
}

function isMeetingAsrAudio(value: unknown): value is InternalMeetingAsrAudioMsg {
  return (
    isRecord(value) &&
    value.type === 'meeting-asr-audio' &&
    isRecord(value.settings) &&
    typeof value.settings.asrEndpoint === 'string' &&
    typeof value.settings.asrModel === 'string' &&
    typeof value.settings.asrApiKey === 'string' &&
    (value.uiLanguage === 'zh' || value.uiLanguage === 'en') &&
    isMeetingAudioChunk(value.chunk)
  )
}

function isMeetingAsrStop(value: unknown): value is InternalMeetingAsrStopMsg {
  return (
    isRecord(value) &&
    value.type === 'meeting-asr-stop' &&
    (value.sessionId === undefined || typeof value.sessionId === 'string') &&
    (value.channel === undefined || isMeetingChannel(value.channel))
  )
}

function isMeetingAudioChunk(value: unknown): value is MeetingAudioChunkMsg {
  return (
    isRecord(value) &&
    value.type === 'meeting-audio-chunk' &&
    typeof value.sessionId === 'string' &&
    isMeetingChannel(value.channel) &&
    typeof value.sourceLang === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.audioBase64 === 'string' &&
    typeof value.startedAt === 'number' &&
    typeof value.endedAt === 'number'
  )
}

function isMeetingChannel(value: unknown): value is MeetingAudioChunkMsg['channel'] {
  return value === 'microphone' || value === 'meeting-output'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}
