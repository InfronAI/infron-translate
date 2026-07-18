import type { MeetingSession } from '../shared/meeting'
import type { MeetingAudioStatusMsg } from '../shared/messages'

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
          ? 'Tab audio is captured, but transcription requires an external STT adapter.'
          : 'Click Start mic in the visible Meeting Assistant window to begin real microphone transcription.',
    },
  })
}

function stopCapture(): void {
  if (levelTimer) {
    globalThis.clearInterval(levelTimer)
    levelTimer = null
  }
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
      outputLevel: rmsLevel(data),
    })
  }, 500)
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
