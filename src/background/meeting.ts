import type {
  MeetingAudioMode,
  MeetingRuntimeState,
  MeetingSession,
  MeetingSummaryState,
  MeetingUpdatePayload,
  TranscriptSegment,
} from '../shared/meeting'
import type {
  MeetingAudioChunkMsg,
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
import { transcribeAudioChunk } from './stt'

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
  private readonly sttInFlight = new Set<string>()
  private readonly sttQueues = new Map<string, MeetingAudioChunkMsg[]>()

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
      audio: { microphone: false, output: false, microphoneLevel: 0, outputLevel: 0 },
      transcription: {
        active: input.audioMode === 'mock',
        source: input.audioMode === 'mock' ? 'mock' : 'none',
        message:
          input.audioMode === 'mock'
            ? 'Demo transcript stream is running.'
            : 'Click Start mic in this window to begin real microphone transcription.',
      },
    }

    await this.ensureOffscreen()
    const outputStreamId =
      input.audioMode !== 'mock' ? await this.getTabAudioStreamId(input.tabId) : undefined
    await this.notifyOffscreenStart(session, outputStreamId)
    this.state = {
      ...this.state,
      session: { ...session, status: 'listening' },
      audio: {
        microphone: false,
        output: Boolean(outputStreamId),
        microphoneLevel: 0,
        outputLevel: 0,
      },
    }
    await this.showOverlay()
    if (input.audioMode === 'mock') this.startMockUpdates()
    return this.state.session
  }

  async updateAudioStatus(message: MeetingAudioStatusMsg): Promise<void> {
    if (!this.state || this.state.session.id !== message.sessionId) return
    const nextTranscription =
      message.transcription ??
      (message.outputLevel !== undefined &&
      message.outputLevel > 0.03 &&
      !this.state.transcription.active
        ? {
            active: false,
            source: 'none' as const,
            message:
              'System audio input detected. Automatic system-audio transcription requires an external STT adapter.',
          }
        : this.state.transcription)
    this.state = {
      ...this.state,
      audio: {
        microphone: message.microphone ?? this.state.audio.microphone,
        output: message.output ?? this.state.audio.output,
        microphoneLevel: clampLevel(message.microphoneLevel ?? this.state.audio.microphoneLevel),
        outputLevel: clampLevel(message.outputLevel ?? this.state.audio.outputLevel),
      },
      transcription: nextTranscription,
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
        source: message.channel === 'meeting-output' ? 'external-stt' : this.state.transcription.source,
        message:
          message.channel === 'meeting-output'
            ? 'Live system audio transcription is running through Infron Whisper STT.'
            : 'Live microphone transcription is running.',
      },
    }
    await this.broadcastUpdate()
  }

  async ingestAudioChunk(message: MeetingAudioChunkMsg): Promise<void> {
    if (!this.state || this.state.session.id !== message.sessionId) return
    const key = `${message.sessionId}:${message.channel}`
    const queue = this.sttQueues.get(key) ?? []
    queue.push(message)
    while (queue.length > 4) queue.shift()
    this.sttQueues.set(key, queue)
    if (this.sttInFlight.has(key)) {
      await this.updateAudioStatus({
        type: 'meeting-audio-status',
        sessionId: message.sessionId,
        transcription: {
          active: true,
          source: 'external-stt',
          message: `${labelForChannel(message.channel)} audio queued for Infron Whisper STT (${queue.length} chunk${queue.length === 1 ? '' : 's'}).`,
        },
      })
      return
    }
    void this.processSttQueue(key)
  }

  private async processSttQueue(key: string): Promise<void> {
    if (this.sttInFlight.has(key)) return
    this.sttInFlight.add(key)
    try {
      while (true) {
        const queue = this.sttQueues.get(key) ?? []
        const message = queue.shift()
        if (!message) {
          this.sttQueues.delete(key)
          return
        }
        if (queue.length === 0) this.sttQueues.delete(key)
        else this.sttQueues.set(key, queue)
        await this.transcribeQueuedChunk(message)
      }
    } finally {
      this.sttInFlight.delete(key)
    }
  }

  private async transcribeQueuedChunk(message: MeetingAudioChunkMsg): Promise<void> {
    if (!this.state || this.state.session.id !== message.sessionId) return
    const settings = await loadSettings()
    if (!isConfigured(settings)) {
      await this.updateAudioStatus({
        type: 'meeting-audio-status',
        sessionId: message.sessionId,
        transcription: {
          active: false,
          source: 'external-stt',
          message: 'Configure Cloud Model with an Infron API Key to enable Whisper STT.',
        },
      })
      return
    }

    await this.updateAudioStatus({
      type: 'meeting-audio-status',
      sessionId: message.sessionId,
      transcription: {
        active: true,
        source: 'external-stt',
        message: `Transcribing ${labelForChannel(message.channel).toLowerCase()} audio with Infron Whisper STT...`,
      },
    })
    const result = await transcribeAudioChunk({
      audioBase64: message.audioBase64,
      mimeType: message.mimeType,
      sourceLang: message.sourceLang,
      settings,
    })
    if (!this.state || this.state.session.id !== message.sessionId) return
    if (!result.ok) {
      await this.updateAudioStatus({
        type: 'meeting-audio-status',
        sessionId: message.sessionId,
        transcription: {
          active: false,
          source: 'external-stt',
          message: `Infron Whisper STT failed: ${result.error}`,
        },
      })
      return
    }
    if (!result.text) {
      await this.updateAudioStatus({
        type: 'meeting-audio-status',
        sessionId: message.sessionId,
        transcription: {
          active: true,
          source: 'external-stt',
          message: `${labelForChannel(message.channel)} audio detected; Whisper returned no speech for this chunk.`,
        },
      })
      return
    }
    await this.ingestTranscript({
      type: 'meeting-transcript-segment',
      sessionId: message.sessionId,
      channel: message.channel,
      speakerLabel: message.channel === 'meeting-output' ? 'System Audio' : 'You',
      sourceLang: message.sourceLang,
      originalText: result.text,
      startedAt: message.startedAt,
      endedAt: message.endedAt,
    })
  }

  async setSystemAudioEnabled(sessionId: string, enabled: boolean): Promise<void> {
    if (!this.state || this.state.session.id !== sessionId) return
    if (!enabled) {
      try {
        await chrome.runtime.sendMessage({ type: 'meeting-audio-stop' })
      } catch {
        // The offscreen document may already be stopped.
      }
      this.state = {
        ...this.state,
        audio: { ...this.state.audio, output: false, outputLevel: 0 },
      }
      await this.broadcastUpdate()
      return
    }

    const outputStreamId = await this.getTabAudioStreamId(this.state.session.tabId)
    await this.notifyOffscreenStart(this.state.session, outputStreamId)
    this.state = {
      ...this.state,
      audio: { ...this.state.audio, output: Boolean(outputStreamId), outputLevel: 0 },
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
    await this.safeSendTab(this.state.session.tabId, {
      type: 'meeting-assistant-update',
      update: this.state,
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

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function labelForChannel(channel: string): string {
  return channel === 'meeting-output' ? 'System' : 'Microphone'
}
