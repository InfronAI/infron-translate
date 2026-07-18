import type {
  MeetingAudioMode,
  MeetingContextAlignment,
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
      preMeetingMaterial: '',
      contextAlignment: emptyContextAlignment(),
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
              'System audio input detected. StepFun ASR transcription will start when audio chunks are available.',
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
    const contextAlignment = analyzeContextAlignment(this.state.preMeetingMaterial, segments)
    this.state = {
      ...this.state,
      segments,
      summary,
      contextAlignment,
      transcription: {
        active: true,
        source: message.channel === 'meeting-output' ? 'external-stt' : this.state.transcription.source,
        message:
          message.channel === 'meeting-output'
            ? 'Live system audio transcription is running through StepFun ASR SSE.'
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
          message: `${labelForChannel(message.channel)} audio queued for StepFun ASR (${queue.length} chunk${queue.length === 1 ? '' : 's'}).`,
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
    if (!settings.apiKey.trim()) {
      await this.updateAudioStatus({
        type: 'meeting-audio-status',
        sessionId: message.sessionId,
        transcription: {
          active: false,
          source: 'external-stt',
          message: 'Configure Cloud Model with a StepFun API Key to enable ASR transcription.',
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
        message: `Transcribing ${labelForChannel(message.channel).toLowerCase()} audio with StepFun ASR SSE...`,
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
          message: `StepFun ASR failed: ${result.error}`,
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
          message: `${labelForChannel(message.channel)} audio detected; StepFun ASR returned no speech for this chunk.`,
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

  async setPreMeetingMaterial(sessionId: string, material: string): Promise<void> {
    if (!this.state || this.state.session.id !== sessionId) return
    const preMeetingMaterial = material.trim().slice(0, 20_000)
    this.state = {
      ...this.state,
      preMeetingMaterial,
      contextAlignment: analyzeContextAlignment(preMeetingMaterial, this.state.segments),
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
    const contextAlignment = analyzeContextAlignment(this.state.preMeetingMaterial, segments)
    this.state = { ...this.state, segments, summary, contextAlignment }
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

function emptyContextAlignment(): MeetingContextAlignment {
  return {
    hasMaterial: false,
    strategyStatus: 'not-provided',
    completedGoals: [],
    unmetGoals: ['Add pre-meeting material to compare the live discussion against the planned agenda.'],
    correctiveSuggestions: ['Paste the agenda, goals, talking points, and expected outcomes before the meeting starts.'],
    evidence: [],
    updatedAt: Date.now(),
  }
}

function analyzeContextAlignment(
  material: string,
  segments: TranscriptSegment[],
): MeetingContextAlignment {
  const normalizedMaterial = material.trim()
  if (!normalizedMaterial) return emptyContextAlignment()

  const goals = extractGoals(normalizedMaterial).slice(0, 8)
  const transcript = segments.map((segment) => segment.originalText).join('\n')
  const recentTranscript = segments.slice(-10).map((segment) => segment.originalText).join('\n')
  const completedGoals: string[] = []
  const unmetGoals: string[] = []
  const evidence: string[] = []

  for (const goal of goals) {
    const score = goalMatchScore(goal, transcript)
    if (score >= 0.38) {
      completedGoals.push(goal)
      const support = matchingEvidence(goal, segments)
      if (support) evidence.push(support)
    } else {
      unmetGoals.push(goal)
    }
  }

  const hasDiscussion = segments.length > 0
  const completionRate = goals.length ? completedGoals.length / goals.length : 0
  const driftSignals = goalMatchScore(normalizedMaterial, recentTranscript)
  const strategyStatus: MeetingContextAlignment['strategyStatus'] =
    completionRate >= 0.7
      ? 'on-track'
      : completionRate >= 0.34 || driftSignals >= 0.2 || segments.length < 3
        ? 'at-risk'
        : 'off-track'

  const useChinese = containsCjk(normalizedMaterial)
  const correctiveSuggestions = unmetGoals.length
    ? unmetGoals.slice(0, 4).map((goal) =>
        useChinese
          ? `请把讨论拉回到：${goal}`
          : `Bring the discussion back to: ${goal}`,
      )
    : [
        useChinese
          ? '已覆盖主要会前目标，请继续推动决策、负责人和下一步计划落地。'
          : 'The main pre-meeting goals are covered; keep pushing decisions, owners, and next steps.',
      ]

  return {
    hasMaterial: true,
    strategyStatus: hasDiscussion ? strategyStatus : 'at-risk',
    completedGoals,
    unmetGoals: unmetGoals.length
      ? unmetGoals
      : [useChinese ? '暂无明显未完成目标。' : 'No obvious unmet goal yet.'],
    correctiveSuggestions,
    evidence: evidence.length
      ? [...new Set(evidence)].slice(0, 5)
      : [
          useChinese
            ? '等待更多实时转写，用于和会前材料交叉印证。'
            : 'Waiting for more live transcript to cross-check against the pre-meeting material.',
        ],
    updatedAt: Date.now(),
  }
}

function extractGoals(material: string): string[] {
  const priorityPattern =
    /(goal|objective|agenda|plan|strategy|decision|decide|confirm|deliver|outcome|risk|align|目标|议程|计划|打法|决策|确认|输出|风险|对齐|待完成|关键)/iu
  const lines = material
    .split(/[\n\r;；。]+/u)
    .map((line) => line.replace(/^\s*[-*•\d.)、]+/u, '').trim())
    .filter((line) => line.length >= 4)
  const prioritized = lines.filter((line) => priorityPattern.test(line))
  return uniqueStrings(prioritized.length ? prioritized : lines).slice(0, 8)
}

function goalMatchScore(goal: string, text: string): number {
  if (!goal.trim() || !text.trim()) return 0
  const lowerText = text.toLocaleLowerCase()
  const terms = goalTerms(goal)
  if (!terms.length) return 0
  const matched = terms.filter((term) => lowerText.includes(term.toLocaleLowerCase()))
  return matched.length / terms.length
}

function goalTerms(goal: string): string[] {
  const alphaNumeric = goal
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term))
  const cjk = [...goal.matchAll(/[\u3400-\u9fff]{2,}/gu)]
    .flatMap((match) => cjkBigrams(match[0]))
    .filter((term) => !CJK_STOP_TERMS.has(term))
  return uniqueStrings([...alphaNumeric, ...cjk]).slice(0, 24)
}

function cjkBigrams(value: string): string[] {
  const result: string[] = []
  for (let index = 0; index < value.length - 1; index += 1) {
    result.push(value.slice(index, index + 2))
  }
  return result
}

function matchingEvidence(goal: string, segments: TranscriptSegment[]): string {
  const terms = goalTerms(goal)
  const match = [...segments]
    .reverse()
    .find((segment) =>
      terms.some((term) => segment.originalText.toLocaleLowerCase().includes(term.toLocaleLowerCase())),
    )
  if (!match) return ''
  return `${match.speakerLabel}: ${match.originalText}`.slice(0, 220)
}

function containsCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value)
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function labelForChannel(channel: string): string {
  return channel === 'meeting-output' ? 'System' : 'Microphone'
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'then',
  'than',
  'will',
  'should',
  'need',
  'needs',
  'meeting',
])

const CJK_STOP_TERMS = new Set(['我们', '需要', '进行', '当前', '会议', '这个', '一个', '以及'])
