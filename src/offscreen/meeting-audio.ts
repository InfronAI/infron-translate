import type { MeetingSession } from '../shared/meeting'
import type { MeetingAudioStatusMsg, MeetingTranscriptSegmentMsg } from '../shared/messages'

type SpeechRecognitionResultItem = {
  transcript: string
}

type SpeechRecognitionResult = {
  isFinal: boolean
  length: number
  item(index: number): SpeechRecognitionResultItem
}

type SpeechRecognitionEventLike = {
  resultIndex: number
  results: {
    length: number
    item(index: number): SpeechRecognitionResult
  }
}

type SpeechRecognitionLike = EventTarget & {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

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
let activeSession: MeetingSession | null = null
let recognition: SpeechRecognitionLike | null = null
let recognitionShouldRun = false

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
  activeSession = session
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
      outputReady = true
    } catch (error) {
      console.warn(
        '[Infron Translate] meeting audio capture failed',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  let microphoneReady = false
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
      microphoneReady = true
      startBrowserSpeechRecognition(session)
    }
  } catch (error) {
    console.warn(
      '[Infron Translate] microphone capture failed',
      error instanceof Error ? error.message : String(error),
    )
  }
  await sendAudioStatus({
    type: 'meeting-audio-status',
    sessionId: session.id,
    microphone: microphoneReady,
    output: outputReady,
    transcription: microphoneReady
      ? {
          active: Boolean(recognition),
          source: recognition ? 'browser-speech' : 'none',
          message: recognition
            ? 'Live microphone transcription is running. Browser speech recognition cannot read desktop/system audio directly.'
            : 'Browser speech recognition is unavailable in this Chrome context.',
        }
      : {
          active: false,
          source: 'none',
          message:
            session.audioMode === 'tab-only'
              ? 'Tab audio is captured, but transcription requires an external STT adapter.'
              : 'Microphone permission was not granted, so no real transcription is running.',
        },
  })
}

function stopCapture(): void {
  recognitionShouldRun = false
  if (recognition) {
    recognition.onresult = null
    recognition.onerror = null
    recognition.onend = null
    recognition.abort()
    recognition = null
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
  activeSessionId = ''
  activeSession = null
}

function startBrowserSpeechRecognition(session: MeetingSession): void {
  const Recognition = speechRecognitionConstructor()
  if (!Recognition) return
  recognitionShouldRun = true
  const next = new Recognition()
  next.continuous = true
  next.interimResults = true
  next.lang = speechRecognitionLang(session.sourceLang)
  next.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results.item(index)
      if (!result.isFinal) continue
      const text = Array.from({ length: result.length }, (_, itemIndex) =>
        result.item(itemIndex).transcript,
      ).join(' ').trim()
      if (!text || !activeSession) continue
      const now = Date.now()
      void chrome.runtime.sendMessage({
        type: 'meeting-transcript-segment',
        sessionId: activeSession.id,
        channel: 'microphone',
        speakerLabel: 'You',
        sourceLang: activeSession.sourceLang,
        originalText: text,
        startedAt: now - 3000,
        endedAt: now,
      } satisfies MeetingTranscriptSegmentMsg)
    }
  }
  next.onerror = (event) => {
    if (!activeSession) return
    void sendAudioStatus({
      type: 'meeting-audio-status',
      sessionId: activeSession.id,
      transcription: {
        active: false,
        source: 'browser-speech',
        message: `Browser speech recognition error: ${event.error ?? 'unknown error'}`,
      },
    })
  }
  next.onend = () => {
    if (!recognitionShouldRun || !activeSession) return
    try {
      next.start()
    } catch {
      // Chrome may reject immediate restarts while the recognizer is still settling.
    }
  }
  recognition = next
  try {
    recognition.start()
  } catch {
    recognition = null
  }
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const scope = globalThis as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

function speechRecognitionLang(sourceLang: string): string {
  if (sourceLang === 'cn' || sourceLang === 'zh') return 'zh-CN'
  if (sourceLang === 'ja') return 'ja-JP'
  if (sourceLang === 'ko') return 'ko-KR'
  if (sourceLang === 'fr') return 'fr-FR'
  if (sourceLang === 'de') return 'de-DE'
  if (sourceLang === 'es') return 'es-ES'
  if (sourceLang === 'auto') return navigator.language || 'en-US'
  return `${sourceLang}-${sourceLang.toUpperCase()}`
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

void activeSessionId
