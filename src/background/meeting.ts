import type {
  MeetingAudioMode,
  MeetingRuntimeState,
  MeetingSession,
  MeetingSummaryState,
  MeetingUpdatePayload,
  TranscriptSegment,
} from '../shared/meeting'
import type {
  MeetingAudioStatusMsg,
  MeetingTranscriptSegmentMsg,
  HideMeetingAssistantMsg,
  MeetingAssistantUpdateMsg,
  ShowMeetingAssistantMsg,
} from '../shared/messages'
import { isConfigured, loadSettings } from '../shared/settings'
import {
  ensureCacheHydrated,
  persistTranslationCache,
  translateBlocksSingleFlight,
} from './translate'

const OFFSCREEN_URL = 'src/offscreen/meeting-audio.html'
const MOCK_LINES = [
  {
    channel: 'meeting-output',
    speakerLabel: 'Speaker 1',
    originalText: 'Let us align on the product scope and confirm the launch sequence.',
    translatedText: '我们先对齐产品范围，并确认上线顺序。',
  },
  {
    channel: 'microphone',
    speakerLabel: 'You',
    originalText: 'The extension should keep the transcript live while the summary stays structured.',
    translatedText: '扩展需要保持转写实时更新，同时让总结保持结构化。',
  },
  {
    channel: 'meeting-output',
    speakerLabel: 'Speaker 2',
    originalText: 'The main risk is audio permission and making sure the capture state is visible.',
    translatedText: '主要风险是音频权限，以及确保采集状态清晰可见。',
  },
  {
    channel: 'meeting-output',
    speakerLabel: 'Speaker 1',
    originalText: 'We should ship the meeting assistant in phases and keep the first version focused.',
    translatedText: '我们应该分阶段发布会议助手，并让第一版保持聚焦。',
  },
] as const

export class MeetingManager {
  private state: MeetingRuntimeState | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private cursor = 0

  getState(): MeetingRuntimeState | null {
    return this.state
  }

  async start(input: {
    tabId: number
    sourceLang: string
    targetLang: string
    audioMode: MeetingAudioMode
  }): Promise<MeetingSession> {
    await this.stop()
    const now = Date.now()
    const session: MeetingSession = {
      id: `meeting-${now}-${Math.random().toString(36).slice(2, 8)}`,
      tabId: input.tabId,
      startedAt: now,
      status: 'starting',
      audioMode: input.audioMode,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
    }
    const summary = this.initialSummary(session.id)
    this.state = {
      session,
      segments: [],
      summary,
      audio: { microphone: false, output: false },
      transcription: {
        active: input.audioMode === 'mock',
        source: input.audioMode === 'mock' ? 'mock' : 'none',
        message:
          input.audioMode === 'mock'
            ? 'Demo transcript stream is running.'
            : 'Waiting for real speech recognition from the microphone.',
      },
    }

    await this.ensureOffscreen()
    const outputStreamId =
      input.audioMode !== 'mock' ? await this.getTabAudioStreamId(input.tabId) : undefined
    await this.notifyOffscreenStart(session, outputStreamId)
    this.state = {
      ...this.state,
      session: { ...session, status: 'listening' },
      audio: { microphone: input.audioMode !== 'tab-only', output: Boolean(outputStreamId) },
    }
    await this.showOverlay()
    if (input.audioMode === 'mock') this.startMockUpdates()
    return this.state.session
  }

  async updateAudioStatus(message: MeetingAudioStatusMsg): Promise<void> {
    if (!this.state || this.state.session.id !== message.sessionId) return
    this.state = {
      ...this.state,
      audio: {
        microphone: message.microphone ?? this.state.audio.microphone,
        output: message.output ?? this.state.audio.output,
      },
      transcription: message.transcription ?? this.state.transcription,
    }
    await this.broadcastUpdate()
  }

  async ingestTranscript(message: MeetingTranscriptSegmentMsg): Promise<void> {
    if (!this.state || this.state.session.id !== message.sessionId) return
    const originalText = message.originalText.trim()
    if (!originalText) return
    const translatedText = await this.translateTranscriptText(originalText)
    const segment: TranscriptSegment = {
      id: `${message.sessionId}-${message.endedAt}-${Math.random().toString(36).slice(2, 7)}`,
      sessionId: message.sessionId,
      channel: message.channel,
      speakerLabel: message.speakerLabel,
      startedAt: message.startedAt,
      endedAt: message.endedAt,
      sourceLang: message.sourceLang,
      originalText,
      translatedText,
    }
    const segments = [...this.state.segments, segment].slice(-120)
    const summary = this.summarize(this.state.summary.sessionId, segments)
    this.state = {
      ...this.state,
      segments,
      summary,
      transcription: {
        active: true,
        source: 'browser-speech',
        message: 'Live microphone transcription is running.',
      },
    }
    await this.broadcastUpdate()
  }

  async stop(): Promise<void> {
    if (!this.state) return
    if (this.timer) globalThis.clearInterval(this.timer)
    this.timer = null
    const stopped: MeetingRuntimeState = {
      ...this.state,
      session: { ...this.state.session, status: 'stopped', stoppedAt: Date.now() },
    }
    this.state = stopped
    await this.safeSendTab(stopped.session.tabId, { type: 'hide-meeting-assistant' })
    try {
      await chrome.runtime.sendMessage({ type: 'meeting-audio-stop' })
    } catch {
      // The offscreen document may not exist yet or may already be closed.
    }
    this.state = null
  }

  private initialSummary(sessionId: string): MeetingSummaryState {
    return {
      sessionId,
      currentTopic: 'Waiting for real meeting audio',
      outline: ['No real transcript has been captured yet.'],
      decisions: [],
      actionItems: [],
      openQuestions: ['Allow microphone permission, then speak to test live transcription.'],
      updatedAt: Date.now(),
    }
  }

  private startMockUpdates(): void {
    if (this.timer) globalThis.clearInterval(this.timer)
    this.emitMockSegment()
    this.timer = globalThis.setInterval(() => this.emitMockSegment(), 4200)
  }

  private emitMockSegment(): void {
    if (!this.state || this.state.session.status !== 'listening') return
    const line = MOCK_LINES[this.cursor % MOCK_LINES.length]
    this.cursor++
    const now = Date.now()
    const segment: TranscriptSegment = {
      id: `${this.state.session.id}-${this.cursor}`,
      sessionId: this.state.session.id,
      channel: line.channel,
      speakerLabel: line.speakerLabel,
      startedAt: now - 3000,
      endedAt: now,
      sourceLang: this.state.session.sourceLang,
      originalText: line.originalText,
      translatedText: line.translatedText,
    }
    const segments = [...this.state.segments, segment].slice(-80)
    const summary = this.summarize(this.state.summary.sessionId, segments)
    this.state = { ...this.state, segments, summary }
    void this.broadcastUpdate()
  }

  private summarize(sessionId: string, segments: TranscriptSegment[]): MeetingSummaryState {
    const recent = segments.slice(-6)
    return {
      sessionId,
      currentTopic:
        recent.at(-1)?.originalText.replace(/\.$/u, '') ?? 'Meeting assistant is listening',
      outline: [
        ...recent.map((segment) => `${segment.speakerLabel}: ${segment.originalText}`),
      ].slice(-5),
      decisions:
        segments.length >= 3 ? ['Live transcript is being captured from real speech.'] : [],
      actionItems:
        segments.length >= 2
          ? [{ task: 'Review transcript accuracy and connect production STT for meeting output audio.' }]
          : [],
      openQuestions:
        segments.length >= 4
          ? ['Should desktop/system audio capture be added through a dedicated STT provider?']
          : ['Is the microphone permission granted and receiving speech?'],
      updatedAt: Date.now(),
    }
  }

  private async translateTranscriptText(text: string): Promise<string> {
    if (!this.state) return text
    const settings = await loadSettings()
    if (!isConfigured(settings)) return text
    const sourceLang = this.state.session.sourceLang === 'auto' ? 'en' : this.state.session.sourceLang
    const targetLang = this.state.session.targetLang
    await ensureCacheHydrated()
    const result = await translateBlocksSingleFlight(
      `meeting:${this.state.session.id}`,
      sourceLang,
      targetLang,
      [{ id: 'segment', tag: 'speech', text }],
      { ...settings, targetLang },
    )
    if (result.translations.length) await persistTranslationCache()
    return result.translations[0]?.translation || text
  }

  private async showOverlay(): Promise<void> {
    if (!this.state) return
    await this.safeSendTab(this.state.session.tabId, {
      type: 'show-meeting-assistant',
      state: this.state,
    })
  }

  private async broadcastUpdate(): Promise<void> {
    if (!this.state) return
    const update: MeetingUpdatePayload = {
      session: this.state.session,
      segments: this.state.segments,
      summary: this.state.summary,
    }
    await this.safeSendTab(this.state.session.tabId, {
      type: 'meeting-assistant-update',
      update,
    })
  }

  private async safeSendTab(
    tabId: number,
    message: ShowMeetingAssistantMsg | MeetingAssistantUpdateMsg | HideMeetingAssistantMsg,
  ): Promise<void> {
    try {
      await chrome.tabs.sendMessage(tabId, message)
    } catch {
      const files = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((s) => s.js ?? [])
      if (!files.length) return
      await chrome.scripting.executeScript({ target: { tabId }, files })
      await new Promise((resolve) => setTimeout(resolve, 120))
      await chrome.tabs.sendMessage(tabId, message)
    }
  }

  private async ensureOffscreen(): Promise<void> {
    if (!chrome.offscreen) return
    const url = chrome.runtime.getURL(OFFSCREEN_URL)
    const contexts = chrome.runtime.getContexts
      ? await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [url],
        })
      : []
    if (contexts.length) return
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA' as chrome.offscreen.Reason],
      justification: 'Capture microphone and meeting audio for the meeting assistant.',
    })
  }

  private async getTabAudioStreamId(tabId: number): Promise<string | undefined> {
    if (!chrome.tabCapture?.getMediaStreamId) return undefined
    try {
      return await new Promise((resolve) => {
        chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
          if (chrome.runtime.lastError || !streamId) {
            resolve(undefined)
            return
          }
          resolve(streamId)
        })
      })
    } catch {
      return undefined
    }
  }

  private async notifyOffscreenStart(
    session: MeetingSession,
    outputStreamId?: string,
  ): Promise<void> {
    try {
      await chrome.runtime.sendMessage({ type: 'meeting-audio-start', session, outputStreamId })
    } catch {
      // The MVP overlay can still run with simulated transcript data.
    }
  }
}
