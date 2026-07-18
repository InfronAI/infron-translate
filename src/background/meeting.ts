import type {
  MeetingAudioMode,
  MeetingContextAlignment,
  MeetingRuntimeState,
  MeetingSession,
  MeetingSummaryState,
  MeetingUiLanguage,
  MeetingUpdatePayload,
  TranscriptPartial,
  TranscriptSegment,
} from '../shared/meeting'
import type {
  MeetingAudioChunkMsg,
  MeetingAudioStatusMsg,
  MeetingTranscriptPartialMsg,
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
const TRANSCRIPT_HISTORY_LIMIT = 500
const MOCK_LINES = [
  {
    channel: 'meeting-output',
    speakerLabel: 'Other participants',
    originalText: 'Let us align on the product scope and confirm the launch sequence.',
    translatedText: '我们先对齐产品范围，并确认上线顺序。',
  },
  {
    channel: 'microphone',
    speakerLabel: 'Me',
    originalText: 'The extension should keep the transcript live while the summary stays structured.',
    translatedText: '扩展需要保持转写实时更新，同时让总结保持结构化。',
  },
  {
    channel: 'meeting-output',
    speakerLabel: 'Other participants',
    originalText: 'The main risk is audio permission and making sure the capture state is visible.',
    translatedText: '主要风险是音频权限，以及确保采集状态清晰可见。',
  },
  {
    channel: 'meeting-output',
    speakerLabel: 'Other participants',
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
    const settings = await loadSettings()
    const uiLanguage = settings.uiLanguage
    const now = Date.now()
    const session: MeetingSession = {
      id: `meeting-${now}-${Math.random().toString(36).slice(2, 8)}`,
      tabId: input.tabId,
      startedAt: now,
      status: 'starting',
      audioMode: input.audioMode,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      uiLanguage,
    }
    const summary = this.initialSummary(session.id, uiLanguage)
    this.state = {
      session,
      segments: [],
      partials: {},
      summary,
      preMeetingMaterial: '',
      contextAlignment: emptyContextAlignment(),
      audio: {
        microphone: false,
        output: false,
        microphoneLevel: 0,
        outputLevel: 0,
        microphoneLabel: 'Default microphone',
        outputLabel: 'Current Chrome tab audio',
      },
      transcription: {
        active: input.audioMode === 'mock',
        source: input.audioMode === 'mock' ? 'mock' : 'none',
        message:
          input.audioMode === 'mock'
            ? meetingMessage(uiLanguage, 'demo')
            : meetingMessage(uiLanguage, 'inputsOff'),
      },
    }

    await this.ensureOffscreen()
    this.state = {
      ...this.state,
      session: { ...session, status: 'listening' },
      audio: {
        microphone: false,
        output: false,
        microphoneLevel: 0,
        outputLevel: 0,
        microphoneLabel: 'Default microphone',
        outputLabel: await this.tabAudioLabel(session.tabId),
      },
    }
    await this.showOverlay()
    if (input.audioMode === 'mock') this.startMockUpdates()
    return this.state.session
  }

  async updateAudioStatus(message: MeetingAudioStatusMsg): Promise<void> {
    if (!this.state || this.state.session.id !== message.sessionId) return
    if (message.microphone === false) this.closeAsrStream(message.sessionId, 'microphone')
    if (message.output === false) this.closeAsrStream(message.sessionId, 'meeting-output')
    const nextTranscription =
      message.transcription ??
      (message.outputLevel !== undefined &&
      message.outputLevel > 0.03 &&
      !this.state.transcription.active
        ? {
            active: false,
            source: 'none' as const,
            message: meetingMessage(this.state.session.uiLanguage, 'systemDetected'),
          }
        : this.state.transcription)
    this.state = {
      ...this.state,
      audio: {
        microphone: message.microphone ?? this.state.audio.microphone,
        output: message.output ?? this.state.audio.output,
        microphoneLevel: clampLevel(message.microphoneLevel ?? this.state.audio.microphoneLevel),
        outputLevel: clampLevel(message.outputLevel ?? this.state.audio.outputLevel),
        microphoneLabel: message.microphoneLabel ?? this.state.audio.microphoneLabel,
        outputLabel: message.outputLabel ?? this.state.audio.outputLabel,
      },
      transcription: nextTranscription,
    }
    await this.broadcastUpdate()
  }

  async ingestTranscriptPartial(message: MeetingTranscriptPartialMsg): Promise<void> {
    if (!this.state || this.state.session.id !== message.sessionId) return
    const partial: TranscriptPartial = {
      channel: message.channel,
      speakerLabel: participantLabel(this.state.session.uiLanguage, message.channel),
      sourceLang: message.sourceLang,
      text: message.text.trim(),
      startedAt: message.startedAt,
      updatedAt: message.updatedAt,
    }
    if (!partial.text) return
    this.state = {
      ...this.state,
      partials: {
        ...this.state.partials,
        [message.channel]: partial,
      },
      transcription: {
        active: true,
        source: 'external-stt',
        message: meetingMessage(this.state.session.uiLanguage, 'streaming', {
          channel: localizedChannel(this.state.session.uiLanguage, message.channel).toLowerCase(),
        }),
      },
    }
    await this.broadcastUpdate()
  }

  async ingestTranscript(message: MeetingTranscriptSegmentMsg): Promise<void> {
    if (!this.state || this.state.session.id !== message.sessionId) return
    const originalText = message.originalText.trim()
    if (!originalText) return
    const partials = { ...this.state.partials }
    delete partials[message.channel]
    const translatedText = await this.translateTranscriptText(originalText)
    const segment: TranscriptSegment = {
      id: `${message.sessionId}-${message.endedAt}-${Math.random().toString(36).slice(2, 7)}`,
      sessionId: message.sessionId,
      channel: message.channel,
      speakerLabel: participantLabel(this.state.session.uiLanguage, message.channel),
      startedAt: message.startedAt,
      endedAt: message.endedAt,
      sourceLang: message.sourceLang,
      originalText,
      translatedText,
    }
    const segments = [...this.state.segments, segment].slice(-TRANSCRIPT_HISTORY_LIMIT)
    const summary = this.summarize(this.state.summary.sessionId, segments)
    const contextAlignment = analyzeContextAlignment(this.state.preMeetingMaterial, segments)
    this.state = {
      ...this.state,
      partials,
      segments,
      summary,
      contextAlignment,
      transcription: {
        active: true,
        source: message.channel === 'meeting-output' ? 'external-stt' : this.state.transcription.source,
        message:
          message.channel === 'meeting-output'
            ? meetingMessage(this.state.session.uiLanguage, 'systemRunning')
            : meetingMessage(this.state.session.uiLanguage, 'micRunning'),
      },
    }
    await this.broadcastUpdate()
  }

  async ingestAudioChunk(message: MeetingAudioChunkMsg): Promise<void> {
    if (!this.state || this.state.session.id !== message.sessionId) return
    const settings = await loadSettings()
    if (!settings.asrApiKey.trim()) {
      await this.updateAudioStatus({
        type: 'meeting-audio-status',
        sessionId: message.sessionId,
        transcription: {
          active: false,
          source: 'external-stt',
          message: meetingMessage(this.state.session.uiLanguage, 'asrKeyMissing'),
        },
      })
      return
    }
    try {
      await this.updateAudioStatus({
        type: 'meeting-audio-status',
        sessionId: message.sessionId,
        transcription: {
          active: true,
          source: 'external-stt',
          message: meetingMessage(this.state.session.uiLanguage, 'streaming', {
            channel: localizedChannel(this.state.session.uiLanguage, message.channel).toLowerCase(),
          }),
        },
      })
      await chrome.runtime.sendMessage({
        type: 'meeting-asr-audio',
        settings,
        chunk: message,
        uiLanguage: this.state.session.uiLanguage,
      })
    } catch (error) {
      await this.updateAudioStatus({
        type: 'meeting-audio-status',
        sessionId: message.sessionId,
        transcription: {
          active: false,
          source: 'external-stt',
          message: meetingMessage(this.state.session.uiLanguage, 'asrFailed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      })
    }
  }

  async setSystemAudioEnabled(sessionId: string, enabled: boolean): Promise<void> {
    if (!this.state || this.state.session.id !== sessionId) return
    if (!enabled) {
      try {
        await chrome.runtime.sendMessage({ type: 'meeting-audio-stop' })
      } catch {
        // The offscreen document may already be stopped.
      }
      this.closeAsrStream(sessionId, 'meeting-output')
      this.state = {
        ...this.state,
        audio: {
          ...this.state.audio,
          output: false,
          outputLevel: 0,
          outputLabel: await this.tabAudioLabel(this.state.session.tabId),
        },
      }
      await this.broadcastUpdate()
      return
    }

    const outputStreamId = await this.getTabAudioStreamId(this.state.session.tabId)
    await this.notifyOffscreenStart(this.state.session, outputStreamId)
    this.state = {
      ...this.state,
      audio: {
        ...this.state.audio,
        output: Boolean(outputStreamId),
        outputLevel: 0,
        outputLabel: await this.tabAudioLabel(this.state.session.tabId),
      },
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
    this.closeAllAsrStreams()
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

  private closeAsrStream(sessionId: string, channel: MeetingAudioChunkMsg['channel']): void {
    void chrome.runtime
      .sendMessage({
        type: 'meeting-asr-stop',
        sessionId,
        channel,
      })
      .catch(() => undefined)
  }

  private closeAllAsrStreams(): void {
    void chrome.runtime.sendMessage({ type: 'meeting-asr-stop' }).catch(() => undefined)
  }

  private initialSummary(sessionId: string, uiLanguage: MeetingUiLanguage): MeetingSummaryState {
    const zh = uiLanguage === 'zh'
    return {
      sessionId,
      currentTopic: zh ? '等待真实会议音频' : 'Waiting for real meeting audio',
      outline: [zh ? '尚未捕获真实转录内容。' : 'No real transcript has been captured yet.'],
      decisions: [],
      actionItems: [],
      openQuestions: [
        zh
          ? '开启麦克风或系统音频后，开始讲话以测试实时转录。'
          : 'Turn on mic or system audio, then speak to test live transcription.',
      ],
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
      speakerLabel: participantLabel(this.state.session.uiLanguage, line.channel),
      startedAt: now - 3000,
      endedAt: now,
      sourceLang: this.state.session.sourceLang,
      originalText: line.originalText,
      translatedText: line.translatedText,
    }
    const segments = [...this.state.segments, segment].slice(-TRANSCRIPT_HISTORY_LIMIT)
    const summary = this.summarize(this.state.summary.sessionId, segments)
    const contextAlignment = analyzeContextAlignment(this.state.preMeetingMaterial, segments)
    this.state = { ...this.state, segments, summary, contextAlignment }
    void this.broadcastUpdate()
  }

  private summarize(sessionId: string, segments: TranscriptSegment[]): MeetingSummaryState {
    const recent = segments.slice(-6)
    const zh = this.state?.session.uiLanguage === 'zh'
    return {
      sessionId,
      currentTopic:
        recent.at(-1)?.originalText.replace(/\.$/u, '') ??
        (zh ? '会议助手正在监听' : 'Meeting assistant is listening'),
      outline: [
        ...recent.map((segment) => `${segment.speakerLabel}: ${segment.originalText}`),
      ].slice(-5),
      decisions:
        segments.length >= 3
          ? [zh ? '正在从真实语音中捕获实时转录。' : 'Live transcript is being captured from real speech.']
          : [],
      actionItems:
        segments.length >= 2
          ? [
              {
                task: zh
                  ? '检查转录准确性，并确认会议音频输出链路稳定。'
                  : 'Review transcript accuracy and confirm the meeting output audio pipeline is stable.',
              },
            ]
          : [],
      openQuestions:
        segments.length >= 4
          ? [
              zh
                ? '是否需要继续扩展桌面级系统音频捕获能力？'
                : 'Should desktop-level system audio capture be added later?',
            ]
          : [
              zh
                ? '麦克风或系统音频是否已开启，并正在接收语音？'
                : 'Is mic or system audio enabled and receiving speech?',
            ],
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

  private async tabAudioLabel(tabId: number): Promise<string> {
    try {
      const tab = await chrome.tabs.get(tabId)
      const title = tab.title?.trim()
      if (title) return `Chrome tab: ${title}`
      if (tab.url) return `Chrome tab: ${new URL(tab.url).hostname}`
    } catch {
      // Fall back to a stable generic label.
    }
    return 'Current Chrome tab audio'
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

type MeetingMessageKey =
  | 'demo'
  | 'inputsOff'
  | 'systemDetected'
  | 'systemRunning'
  | 'micRunning'
  | 'asrKeyMissing'
  | 'streaming'
  | 'asrFailed'

function meetingMessage(
  language: MeetingUiLanguage,
  key: MeetingMessageKey,
  params: Record<string, string> = {},
): string {
  const copy: Record<MeetingMessageKey, string> =
    language === 'zh'
      ? {
          demo: '演示转录流正在运行。',
          inputsOff: '麦克风和系统音频均已关闭。准备转录时请手动开启输入源。',
          systemDetected: '检测到系统音频输入。HTTP + SSE 识别将在收集到音频后开始。',
          systemRunning: '系统音频正在通过 StepFun HTTP + SSE 识别。',
          micRunning: '麦克风正在实时转录。',
          asrKeyMissing: '请先在“会议转录”中配置 ASR API Key。',
          streaming: '正在通过 StepFun HTTP + SSE 识别{channel}音频...',
          asrFailed: 'StepFun ASR 失败：{error}',
        }
      : {
          demo: 'Demo transcript stream is running.',
          inputsOff: 'Mic input and system audio are off. Turn on either input when you are ready to transcribe.',
          systemDetected: 'System audio input detected. HTTP + SSE transcription will start after audio is collected.',
          systemRunning: 'System audio transcription is running through StepFun HTTP + SSE.',
          micRunning: 'Live microphone transcription is running.',
          asrKeyMissing: 'Configure Meeting Transcription with an ASR API Key to enable transcription.',
          streaming: 'Sending {channel} audio through StepFun HTTP + SSE...',
          asrFailed: 'StepFun ASR failed: {error}',
        }
  return Object.entries(params).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, value),
    copy[key],
  )
}

function localizedChannel(language: MeetingUiLanguage, channel: string): string {
  return participantLabel(language, channel)
}

function participantLabel(language: MeetingUiLanguage, channel: string): string {
  if (language === 'zh') return channel === 'meeting-output' ? '与会对方' : '我'
  return channel === 'meeting-output' ? 'Other participants' : 'Me'
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
