import type { MeetingSession } from '../shared/meeting'
import type { MeetingAudioChunkMsg, MeetingAudioStatusMsg } from '../shared/messages'

type InternalMeetingAudioStartMsg = {
  type: 'meeting-audio-start'
  session: MeetingSession
  outputStreamId?: string
}

type InternalMeetingAudioStopMsg = {
  type: 'meeting-audio-stop'
}

let streams: MediaStream[] = []
let playback: HTMLAudioElement | null = null
let audioContext: AudioContext | null = null
let levelTimer: ReturnType<typeof setInterval> | null = null
let pcmProcessor: ScriptProcessorNode | null = null
let pcmSilentGain: GainNode | null = null
let pcmTimer: ReturnType<typeof setInterval> | null = null
let pcmBuffers: Int16Array[] = []
let chunkStartedAt = 0
let maxLevelSinceChunk = 0

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
      startOutputRecorder(session, tabAudio)
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
          ? 'Tab audio is captured. StepFun ASR transcription will start when audio chunks are available.'
          : 'Click Start mic in the visible Meeting Assistant window to begin real microphone transcription.',
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
  if (pcmProcessor) {
    pcmProcessor.disconnect()
    pcmProcessor = null
  }
  if (pcmSilentGain) {
    pcmSilentGain.disconnect()
    pcmSilentGain = null
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
  const source = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 512
  source.connect(analyser)
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

function startOutputRecorder(session: MeetingSession, stream: MediaStream): void {
  if (!audioContext) return
  pcmBuffers = []
  chunkStartedAt = Date.now()
  const source = audioContext.createMediaStreamSource(stream)
  pcmProcessor = audioContext.createScriptProcessor(4096, 1, 1)
  pcmSilentGain = audioContext.createGain()
  pcmSilentGain.gain.value = 0
  pcmProcessor.onaudioprocess = (event) => {
    pcmBuffers.push(floatTo16kPcm(event.inputBuffer.getChannelData(0), audioContext?.sampleRate ?? 48000))
  }
  source.connect(pcmProcessor)
  pcmProcessor.connect(pcmSilentGain)
  pcmSilentGain.connect(audioContext.destination)
  pcmTimer = globalThis.setInterval(() => {
    const endedAt = Date.now()
    const startedAt = chunkStartedAt || endedAt - 4000
    chunkStartedAt = endedAt
    const shouldSend = maxLevelSinceChunk > 0.025
    maxLevelSinceChunk = 0
    const bytes = mergePcmBuffers(pcmBuffers)
    pcmBuffers = []
    if (!shouldSend) return
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
  }, 4000)
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}
