export type MeetingStatus = 'idle' | 'starting' | 'listening' | 'stopping' | 'stopped' | 'error'
export type MeetingAudioMode = 'tab-and-mic' | 'tab-only' | 'mock'
export type MeetingChannel = 'microphone' | 'meeting-output'

export type MeetingSession = {
  id: string
  tabId: number
  startedAt: number
  stoppedAt?: number
  status: MeetingStatus
  audioMode: MeetingAudioMode
  sourceLang: string
  targetLang: string
  error?: string
}

export type TranscriptSegment = {
  id: string
  sessionId: string
  channel: MeetingChannel
  speakerLabel: string
  startedAt: number
  endedAt: number
  sourceLang: string
  originalText: string
  translatedText: string
}

export type MeetingSummaryState = {
  sessionId: string
  currentTopic: string
  outline: string[]
  decisions: string[]
  actionItems: Array<{
    owner?: string
    task: string
    due?: string
  }>
  openQuestions: string[]
  updatedAt: number
}

export type MeetingContextAlignment = {
  hasMaterial: boolean
  strategyStatus: 'not-provided' | 'on-track' | 'at-risk' | 'off-track'
  completedGoals: string[]
  unmetGoals: string[]
  correctiveSuggestions: string[]
  evidence: string[]
  updatedAt: number
}

export type MeetingUpdatePayload = {
  session: MeetingSession
  segments: TranscriptSegment[]
  summary: MeetingSummaryState
}

export type MeetingRuntimeState = MeetingUpdatePayload & {
  audio: {
    microphone: boolean
    output: boolean
    microphoneLevel: number
    outputLevel: number
  }
  transcription: {
    active: boolean
    source: 'browser-speech' | 'external-stt' | 'mock' | 'none'
    message: string
  }
  preMeetingMaterial: string
  contextAlignment: MeetingContextAlignment
}
