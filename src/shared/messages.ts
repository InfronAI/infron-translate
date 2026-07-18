import type { UserSettings } from './settings-defaults'
import type {
  MeetingAudioMode,
  MeetingChannel,
  MeetingRuntimeState,
  MeetingSession,
  MeetingUpdatePayload,
} from './meeting'

export type TranslateBlock = {
  id: string
  tag: string
  text: string
}

export type TranslateBatchRequestMsg = {
  type: 'translate-batch'
  pageKey: string
  sourceLang: string
  blocks: TranslateBlock[]
}

export type TranslateBatchResultOk = {
  type: 'translate-batch-result'
  ok: true
  translations: { id: string; translation: string }[]
}

export type TranslateBatchResultErr = {
  type: 'translate-batch-result'
  ok: false
  error: string
  failedIds?: string[]
  /** Partial successes still applied by content script */
  translations?: { id: string; translation: string }[]
}

export type GetSettingsMsg = { type: 'get-settings' }
export type ContentSettings = Pick<
  UserSettings,
  | 'sourceLang'
  | 'targetLang'
  | 'pageTranslationEngine'
  | 'translationDisplayMode'
  | 'autoPageTranslation'
  | 'uiLanguage'
  | 'pageTranslationFontSizePx'
  | 'pageTranslationUseCustomColor'
  | 'pageTranslationTextColor'
  | 'pageTranslationUseBackground'
  | 'pageTranslationBackgroundColor'
  | 'pageTranslationBold'
  | 'pageTranslationItalic'
  | 'pageTranslationUnderline'
  | 'minTextLength'
  | 'batchCharLimit'
> & { apiKey: '' }

export type SettingsMsg = {
  type: 'settings'
  /** Minimal content-script settings: no endpoint, model, provider, or secret fields. */
  settings: ContentSettings
  /** Pause state only for the requesting tab; the full hostname list stays in background storage. */
  paused: boolean
  /** Computed against complete background settings before minimization. */
  configured: boolean
}

export type PauseHostnameMsg = {
  type: 'set-hostname-paused'
  hostname: string
  paused: boolean
}

export type SetAutoPageTranslationMsg = {
  type: 'set-auto-page-translation'
  enabled: boolean
}

export type OpenOptionsMsg = { type: 'open-options' }

/**
 * Options-page-only reachability probe. Carries the credentials currently typed
 * into the form (which may be unsaved) so the user can verify before saving; the
 * background rejects it unless it originates from a trusted extension page.
 */
export type TestConnectionMsg = {
  type: 'test-connection'
  baseURL: string
  apiKey: string
  model: string
  provider: UserSettings['provider']
  reasoningPref: UserSettings['reasoningPref']
}

export type TestConnectionResult =
  | { type: 'test-connection-result'; ok: true }
  | { type: 'test-connection-result'; ok: false; error: string }

export type TogglePageTranslationMsg = { type: 'toggle-page-translation' }
export type TogglePageTranslationResult =
  | { ok: true }
  | { ok: false; error: string }

export type GetPageLanguageMsg = { type: 'get-page-language' }
export type PageLanguageResult = {
  type: 'page-language-result'
  detectedSourceLang: string
  effectiveSourceLang: string
}

export type StartMeetingAssistantMsg = {
  type: 'start-meeting-assistant'
  tabId: number
  sourceLang: string
  targetLang: string
  audioMode: MeetingAudioMode
}

export type StopMeetingAssistantMsg = {
  type: 'stop-meeting-assistant'
  sessionId?: string
}

export type SetMeetingSystemAudioMsg = {
  type: 'set-meeting-system-audio'
  sessionId: string
  enabled: boolean
}

export type SetMeetingContextMsg = {
  type: 'set-meeting-context'
  sessionId: string
  material: string
}

export type GetMeetingAssistantStateMsg = { type: 'get-meeting-assistant-state' }

export type MeetingTranscriptSegmentMsg = {
  type: 'meeting-transcript-segment'
  sessionId: string
  channel: MeetingChannel
  speakerLabel: string
  sourceLang: string
  originalText: string
  startedAt: number
  endedAt: number
}

export type MeetingTranscriptPartialMsg = {
  type: 'meeting-transcript-partial'
  sessionId: string
  channel: MeetingChannel
  speakerLabel: string
  sourceLang: string
  text: string
  startedAt: number
  updatedAt: number
}

export type MeetingAudioChunkMsg = {
  type: 'meeting-audio-chunk'
  sessionId: string
  channel: MeetingChannel
  sourceLang: string
  mimeType: string
  audioBase64: string
  startedAt: number
  endedAt: number
}

export type MeetingAudioStatusMsg = {
  type: 'meeting-audio-status'
  sessionId: string
  microphone?: boolean
  output?: boolean
  microphoneLevel?: number
  outputLevel?: number
  microphoneLabel?: string
  outputLabel?: string
  transcription?: MeetingRuntimeState['transcription']
}

export type MeetingAssistantControlResult =
  | { type: 'meeting-assistant-control-result'; ok: true; session: MeetingSession }
  | { type: 'meeting-assistant-control-result'; ok: false; error: string }

export type MeetingAssistantStateResult = {
  type: 'meeting-assistant-state'
  state: MeetingRuntimeState | null
}

export type ShowMeetingAssistantMsg = {
  type: 'show-meeting-assistant'
  state: MeetingRuntimeState
}

export type MeetingAssistantUpdateMsg = {
  type: 'meeting-assistant-update'
  update: MeetingRuntimeState
}

export type HideMeetingAssistantMsg = { type: 'hide-meeting-assistant' }

export type MeetingInternalResult = { type: 'meeting-internal-result'; ok: boolean }

export type BackgroundErrorResult = {
  type: 'background-error'
  ok: false
  requestType: ToBackground['type']
  error: string
}

export type ToBackground =
  | TranslateBatchRequestMsg
  | GetSettingsMsg
  | PauseHostnameMsg
  | SetAutoPageTranslationMsg
  | StartMeetingAssistantMsg
  | StopMeetingAssistantMsg
  | SetMeetingSystemAudioMsg
  | SetMeetingContextMsg
  | GetMeetingAssistantStateMsg
  | MeetingTranscriptSegmentMsg
  | MeetingTranscriptPartialMsg
  | MeetingAudioChunkMsg
  | MeetingAudioStatusMsg
  | OpenOptionsMsg
  | TestConnectionMsg
export type FromBackground =
  | TranslateBatchResultOk
  | TranslateBatchResultErr
  | SettingsMsg
  | MeetingAssistantControlResult
  | MeetingAssistantStateResult
  | MeetingInternalResult
  | TestConnectionResult
  | BackgroundErrorResult
  | { type: 'open-options-result'; ok: boolean }
