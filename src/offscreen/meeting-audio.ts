import type { MeetingSession } from '../shared/meeting'

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
let activeSessionId = ''

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
  activeSessionId = session.id
  if (session.audioMode === 'mock') return

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
    } catch (error) {
      console.warn(
        '[Infron Translate] meeting audio capture failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  try {
    if (session.audioMode !== 'tab-only') {
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
      streams.push(mic)
    }
  } catch (error) {
    console.warn(
      '[Infron Translate] microphone capture failed',
      error instanceof Error ? error.message : String(error),
    )
  }
}

function stopCapture(): void {
  if (playback) {
    playback.pause()
    playback.srcObject = null
    playback = null
  }
  for (const stream of streams) {
    for (const track of stream.getTracks()) track.stop()
  }
  streams = []
  activeSessionId = ''
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

void activeSessionId
