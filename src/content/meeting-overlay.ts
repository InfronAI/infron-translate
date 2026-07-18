import type {
  MeetingRuntimeState,
  MeetingSummaryState,
  TranscriptSegment,
} from '../shared/meeting'
import type {
  MeetingAudioStatusMsg,
  MeetingTranscriptSegmentMsg,
  StopMeetingAssistantMsg,
} from '../shared/messages'

const HOST_ID = 'infron-meeting-assistant-root'
const MIN_WIDTH = 520
const MIN_HEIGHT = 360

type MeetingWindowState = {
  x: number
  y: number
  width: number
  height: number
  minimized: boolean
}

type DragState = {
  pointerId: number
  startX: number
  startY: number
  windowX: number
  windowY: number
}

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

export class MeetingOverlay {
  private host: HTMLElement | null = null
  private root: ShadowRoot | null = null
  private state: MeetingRuntimeState | null = null
  private windowState: MeetingWindowState | null = null
  private dragState: DragState | null = null
  private recognition: SpeechRecognitionLike | null = null
  private recognitionShouldRun = false
  private micStream: MediaStream | null = null
  private micAudioContext: AudioContext | null = null
  private micLevelTimer: ReturnType<typeof setInterval> | null = null

  show(state: MeetingRuntimeState): void {
    this.state = state
    this.ensureRoot()
    this.windowState ??= defaultWindowState()
    this.render()
  }

  update(update: MeetingRuntimeState): void {
    if (!this.state) return
    this.state = update
    this.render()
  }

  hide(): void {
    this.stopLocalSpeechRecognition()
    this.host?.remove()
    this.host = null
    this.root = null
    this.state = null
  }

  private ensureRoot(): void {
    if (this.root) return
    let host = document.getElementById(HOST_ID)
    if (!host) {
      host = document.createElement('div')
      host.id = HOST_ID
      host.setAttribute('data-infron-ignore', '')
      document.documentElement.append(host)
    }
    this.host = host
    this.root = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  }

  private render(): void {
    if (!this.root || !this.state || !this.windowState) return
    const { session, segments, summary, audio, transcription } = this.state
    this.root.replaceChildren()
    const style = document.createElement('style')
    style.textContent = css

    if (this.windowState.minimized) {
      const dock = document.createElement('button')
      dock.className = 'dock'
      dock.type = 'button'
      dock.setAttribute('aria-label', 'Restore Meeting Assistant')
      dock.innerHTML = `
        <img class="dock-logo" src="${chrome.runtime.getURL('icons/infron-mark.png')}" alt="" aria-hidden="true" />
        <span>Meeting Assistant</span>
        <strong>${statusLabel(session.status)}</strong>
      `
      dock.addEventListener('click', () => {
        this.windowState = { ...this.windowState!, minimized: false }
        this.render()
      })
      this.root.append(style, dock)
      return
    }

    const shell = document.createElement('section')
    shell.className = 'overlay'
    shell.setAttribute('aria-label', 'Infron Translate Meeting Assistant')
    shell.style.left = `${this.windowState.x}px`
    shell.style.top = `${this.windowState.y}px`
    shell.style.width = `${this.windowState.width}px`
    shell.style.height = `${this.windowState.height}px`
    shell.innerHTML = `
      <header class="topbar">
        <div class="brand">
          <img class="logo" src="${chrome.runtime.getURL('icons/infron-mark.png')}" alt="" aria-hidden="true" />
          <div>
            <h2>Meeting Assistant</h2>
            <p>${languageLabel(session.sourceLang)} -> ${languageLabel(session.targetLang)}</p>
          </div>
        </div>
        <div class="status">
          <span class="badge ${session.status === 'listening' ? 'ok' : ''}">${statusLabel(session.status)}</span>
          <span class="badge ${audio.microphone ? 'ok' : ''}">Mic</span>
          <span class="badge ${audio.output ? 'ok' : ''}">Meeting audio</span>
          <button class="window-btn mic-toggle" type="button">${this.recognition ? 'Stop mic' : 'Start mic'}</button>
          <button class="window-btn minimize" type="button" aria-label="Send Meeting Assistant to background">Background</button>
          <button class="window-btn focus" type="button" aria-label="Focus Meeting Assistant">Focus</button>
          <button class="window-btn close" type="button" aria-label="Close Meeting Assistant">Close</button>
        </div>
      </header>
      <main class="screens">
        <section class="audio-meters">
          ${meterHtml('Mic input', audio.microphone, audio.microphoneLevel)}
          ${meterHtml('Webpage audio', audio.output, audio.outputLevel)}
        </section>
        <article class="screen summary-screen"></article>
        <article class="screen transcript-screen"></article>
      </main>
    `
    shell.addEventListener('pointerdown', () => this.focusWindow())
    shell.addEventListener('mouseup', () => this.syncWindowRect(shell))
    shell.addEventListener('touchend', () => this.syncWindowRect(shell))
    shell.querySelector<HTMLElement>('.topbar')?.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('button')) return
      this.startDrag(event, shell)
    })
    shell.querySelector<HTMLButtonElement>('.minimize')?.addEventListener('click', () => {
      this.syncWindowRect(shell)
      this.windowState = { ...this.windowState!, minimized: true }
      this.render()
    })
    shell.querySelector<HTMLButtonElement>('.focus')?.addEventListener('click', () => {
      this.focusWindow()
    })
    shell.querySelector<HTMLButtonElement>('.mic-toggle')?.addEventListener('click', () => {
      if (this.recognition) this.stopLocalSpeechRecognition()
      else void this.startLocalSpeechRecognition()
    })
    shell.querySelector<HTMLButtonElement>('.close')?.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        type: 'stop-meeting-assistant',
        sessionId: session.id,
      } satisfies StopMeetingAssistantMsg)
    })
    shell.querySelector<HTMLElement>('.summary-screen')?.append(renderSummary(summary))
    shell
      .querySelector<HTMLElement>('.transcript-screen')
      ?.append(renderTranscript(segments, transcription.message))
    this.root.append(style, shell)
  }

  private focusWindow(): void {
    if (!this.host) return
    this.host.style.zIndex = '2147483645'
  }

  private startDrag(event: PointerEvent, shell: HTMLElement): void {
    if (!this.windowState) return
    event.preventDefault()
    shell.setPointerCapture(event.pointerId)
    this.dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      windowX: this.windowState.x,
      windowY: this.windowState.y,
    }
    const move = (nextEvent: PointerEvent) => this.drag(nextEvent, shell)
    const stop = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== this.dragState?.pointerId) return
      shell.releasePointerCapture(nextEvent.pointerId)
      shell.removeEventListener('pointermove', move)
      shell.removeEventListener('pointerup', stop)
      shell.removeEventListener('pointercancel', stop)
      this.syncWindowRect(shell)
      this.dragState = null
    }
    shell.addEventListener('pointermove', move)
    shell.addEventListener('pointerup', stop)
    shell.addEventListener('pointercancel', stop)
  }

  private drag(event: PointerEvent, shell: HTMLElement): void {
    if (!this.dragState || !this.windowState || event.pointerId !== this.dragState.pointerId) return
    const x = clamp(
      this.dragState.windowX + event.clientX - this.dragState.startX,
      8,
      Math.max(8, window.innerWidth - this.windowState.width - 8),
    )
    const y = clamp(
      this.dragState.windowY + event.clientY - this.dragState.startY,
      8,
      Math.max(8, window.innerHeight - this.windowState.height - 8),
    )
    this.windowState = { ...this.windowState, x, y }
    shell.style.left = `${x}px`
    shell.style.top = `${y}px`
  }

  private syncWindowRect(shell: HTMLElement): void {
    if (!this.windowState) return
    const rect = shell.getBoundingClientRect()
    const width = clamp(rect.width, MIN_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 16))
    const height = clamp(rect.height, MIN_HEIGHT, Math.max(MIN_HEIGHT, window.innerHeight - 16))
    const x = clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8))
    const y = clamp(rect.top, 8, Math.max(8, window.innerHeight - height - 8))
    this.windowState = { ...this.windowState, x, y, width, height }
    shell.style.left = `${x}px`
    shell.style.top = `${y}px`
    shell.style.width = `${width}px`
    shell.style.height = `${height}px`
  }

  private async startLocalSpeechRecognition(): Promise<void> {
    if (!this.state) return
    const Recognition = speechRecognitionConstructor()
    if (!Recognition) {
      await this.sendAudioStatus({
        active: false,
        source: 'none',
        message: 'This Chrome context does not expose browser speech recognition. Use a supported Chrome build or connect an external STT provider.',
      })
      return
    }

    const session = this.state.session
    try {
      await this.startMicLevelMeter(session.id)
    } catch {
      this.render()
      return
    }
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
        if (!text || !this.state) continue
        const now = Date.now()
        void chrome.runtime.sendMessage({
          type: 'meeting-transcript-segment',
          sessionId: this.state.session.id,
          channel: 'microphone',
          speakerLabel: 'You',
          sourceLang: this.state.session.sourceLang,
          originalText: text,
          startedAt: now - 3000,
          endedAt: now,
        } satisfies MeetingTranscriptSegmentMsg)
      }
    }
    next.onerror = (event) => {
      const detail = speechRecognitionErrorMessage(event.error)
      const active = event.error === 'no-speech'
      if (!active) this.recognitionShouldRun = false
      void this.sendAudioStatus({
        active,
        source: 'browser-speech',
        message: detail,
      })
    }
    next.onend = () => {
      if (!this.recognitionShouldRun) return
      try {
        next.start()
      } catch {
        void this.sendAudioStatus({
          active: false,
          source: 'browser-speech',
          message: 'Microphone transcription stopped. Click Start mic to retry.',
        })
      }
    }

    this.recognitionShouldRun = true
    this.recognition = next
    try {
      next.start()
      await this.sendAudioStatus({
        active: true,
        source: 'browser-speech',
        message: 'Microphone transcription is listening. Speak into your microphone; desktop/system audio is not transcribed by this mode.',
      })
    } catch (error) {
      this.recognitionShouldRun = false
      this.recognition = null
      this.stopMicLevelMeter()
      await this.sendAudioStatus({
        active: false,
        source: 'browser-speech',
        message: `Could not start microphone transcription: ${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      this.render()
    }
  }

  private stopLocalSpeechRecognition(): void {
    this.recognitionShouldRun = false
    this.stopMicLevelMeter()
    if (!this.recognition) return
    this.recognition.onresult = null
    this.recognition.onerror = null
    this.recognition.onend = null
    this.recognition.abort()
    this.recognition = null
    if (this.state) {
      void chrome.runtime.sendMessage({
        type: 'meeting-audio-status',
        sessionId: this.state.session.id,
        microphone: false,
        microphoneLevel: 0,
        transcription: {
          active: false,
          source: 'browser-speech',
          message: 'Microphone transcription is stopped.',
        },
      } satisfies MeetingAudioStatusMsg)
    }
    this.render()
  }

  private async sendAudioStatus(transcription: MeetingRuntimeState['transcription']): Promise<void> {
    if (!this.state) return
    try {
      await chrome.runtime.sendMessage({
        type: 'meeting-audio-status',
        sessionId: this.state.session.id,
        microphone: this.recognitionShouldRun,
        transcription,
      } satisfies MeetingAudioStatusMsg)
    } catch {
      // The service worker may be asleep; the next user action will restart it.
    }
  }

  private async startMicLevelMeter(sessionId: string): Promise<void> {
    this.stopMicLevelMeter()
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      })
      this.micAudioContext = new AudioContext()
      const source = this.micAudioContext.createMediaStreamSource(this.micStream)
      const analyser = this.micAudioContext.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      this.micLevelTimer = globalThis.setInterval(() => {
        analyser.getByteTimeDomainData(data)
        void chrome.runtime.sendMessage({
          type: 'meeting-audio-status',
          sessionId,
          microphone: true,
          microphoneLevel: rmsLevel(data),
        } satisfies MeetingAudioStatusMsg)
      }, 500)
    } catch (error) {
      await this.sendAudioStatus({
        active: false,
        source: 'browser-speech',
        message: `Microphone access failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      throw error
    }
  }

  private stopMicLevelMeter(): void {
    if (this.micLevelTimer) {
      globalThis.clearInterval(this.micLevelTimer)
      this.micLevelTimer = null
    }
    if (this.micAudioContext) {
      void this.micAudioContext.close()
      this.micAudioContext = null
    }
    if (this.micStream) {
      for (const track of this.micStream.getTracks()) track.stop()
      this.micStream = null
    }
  }
}

function defaultWindowState(): MeetingWindowState {
  const width = clamp(Math.round(window.innerWidth * 0.82), MIN_WIDTH, window.innerWidth - 40)
  const height = clamp(Math.round(window.innerHeight * 0.78), MIN_HEIGHT, window.innerHeight - 40)
  return {
    x: Math.max(20, Math.round((window.innerWidth - width) / 2)),
    y: Math.max(20, Math.round((window.innerHeight - height) / 2)),
    width,
    height,
    minimized: false,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function meterHtml(label: string, enabled: boolean, level: number): string {
  const percent = Math.round(clamp(level, 0, 1) * 100)
  return `
    <div class="meter">
      <div class="meter-head">
        <span>${escapeHtml(label)}</span>
        <strong>${enabled ? `${percent}%` : 'Off'}</strong>
      </div>
      <div class="meter-track" aria-hidden="true">
        <span style="width: ${enabled ? percent : 0}%"></span>
      </div>
    </div>
  `
}

function rmsLevel(data: Uint8Array): number {
  let sum = 0
  for (const value of data) {
    const centered = (value - 128) / 128
    sum += centered * centered
  }
  return Math.min(1, Math.sqrt(sum / data.length) * 4)
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  const scope = globalThis as typeof globalThis & {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null
}

function speechRecognitionErrorMessage(error: string | undefined): string {
  if (error === 'no-speech') {
    return 'Listening, but no clear speech was detected yet. Move closer to the microphone or check the input device.'
  }
  if (error === 'audio-capture') {
    return 'No microphone input was captured. Check the selected microphone in Chrome or system settings.'
  }
  if (error === 'not-allowed' || error === 'service-not-allowed') {
    return 'Microphone permission was blocked. Allow microphone access for this page, then click Start mic again.'
  }
  if (error === 'network') {
    return 'Speech recognition network service is unavailable. Check the network or try again later.'
  }
  if (error === 'aborted') {
    return 'Microphone transcription was interrupted. Click Start mic to retry.'
  }
  if (error === 'language-not-supported') {
    return 'The selected source language is not supported by browser speech recognition.'
  }
  return `Microphone transcription error: ${error ?? 'unknown error'}`
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

function renderSummary(summary: MeetingSummaryState): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'screen-inner'
  wrapper.append(
    titleBlock('1', 'Meeting Outline', summary.currentTopic),
    section('Outline', summary.outline),
    section('Decisions', summary.decisions.length ? summary.decisions : ['No decision captured yet.']),
    section(
      'Action Items',
      summary.actionItems.length
        ? summary.actionItems.map((item) => [item.owner, item.task, item.due].filter(Boolean).join(' · '))
        : ['No action item captured yet.'],
    ),
    section('Open Questions', summary.openQuestions),
  )
  return wrapper
}

function renderTranscript(segments: TranscriptSegment[], transcriptionMessage: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'screen-inner'
  wrapper.append(titleBlock('2', 'Live Transcript', 'Original speech and translated text'))
  const status = document.createElement('p')
  status.className = 'transcription-status'
  status.textContent = transcriptionMessage
  wrapper.append(status)
  const list = document.createElement('div')
  list.className = 'transcript-list'
  const recent = segments.slice(-28)
  if (!recent.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'Waiting for real speech...'
    list.append(empty)
  }
  for (const segment of recent) {
    const item = document.createElement('div')
    item.className = `segment ${segment.channel}`
    item.innerHTML = `
      <div class="segment-head">
        <strong>${escapeHtml(segment.speakerLabel)}</strong>
        <span>${timeLabel(segment.endedAt)}</span>
      </div>
      <p class="original">${escapeHtml(segment.originalText)}</p>
      <p class="translated">${escapeHtml(segment.translatedText)}</p>
    `
    list.append(item)
  }
  wrapper.append(list)
  return wrapper
}

function titleBlock(index: string, title: string, subtitle: string): HTMLElement {
  const node = document.createElement('div')
  node.className = 'title-block'
  node.innerHTML = `
    <span>${index}</span>
    <div>
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(subtitle)}</p>
    </div>
  `
  return node
}

function section(title: string, items: string[]): HTMLElement {
  const node = document.createElement('section')
  node.className = 'summary-section'
  const heading = document.createElement('h4')
  heading.textContent = title
  const list = document.createElement('ul')
  for (const item of items) {
    const li = document.createElement('li')
    li.textContent = item
    list.append(li)
  }
  node.append(heading, list)
  return node
}

function statusLabel(status: string): string {
  if (status === 'listening') return 'Listening'
  if (status === 'starting') return 'Starting'
  if (status === 'stopping') return 'Stopping'
  if (status === 'error') return 'Error'
  return 'Stopped'
}

function languageLabel(code: string): string {
  if (code === 'auto') return 'Auto'
  if (code === 'cn') return 'Chinese'
  if (code === 'en') return 'English'
  return code.toUpperCase()
}

function timeLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

const css = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483645;
  inset: 0;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #111827;
}

* { box-sizing: border-box; }

.overlay {
  position: fixed;
  min-width: ${MIN_WIDTH}px;
  min-height: ${MIN_HEIGHT}px;
  max-width: calc(100vw - 16px);
  max-height: calc(100vh - 16px);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 14px;
  padding: 16px;
  border: 1px solid rgb(255 255 255 / 66%);
  border-radius: 18px;
  background: linear-gradient(135deg, rgb(248 250 252 / 94%), rgb(236 253 245 / 88%) 46%, rgb(239 246 255 / 92%));
  box-shadow: 0 26px 80px rgb(15 23 42 / 26%);
  backdrop-filter: blur(16px) saturate(155%);
  -webkit-backdrop-filter: blur(16px) saturate(155%);
  pointer-events: auto;
  resize: both;
  overflow: hidden;
}

.topbar,
.status,
.brand,
.title-block,
.segment-head {
  display: flex;
  align-items: center;
}

.topbar {
  justify-content: space-between;
  gap: 16px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.topbar:active {
  cursor: grabbing;
}

.brand {
  gap: 11px;
  min-width: 0;
}

.logo {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  background: #fff;
  box-shadow: 0 8px 20px rgb(15 23 42 / 16%);
}

h2,
h3,
h4,
p,
ul {
  margin: 0;
}

h2 {
  font-size: 18px;
  line-height: 1.15;
  font-weight: 720;
}

.brand p {
  margin-top: 2px;
  font-size: 12px;
  color: #64748b;
}

.status {
  gap: 8px;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.badge {
  padding: 5px 9px;
  border-radius: 999px;
  background: rgb(148 163 184 / 18%);
  color: #475569;
  font-size: 12px;
  font-weight: 650;
}

.badge.ok {
  background: rgb(16 185 129 / 18%);
  color: #047857;
}

.window-btn {
  border: 0;
  border-radius: 10px;
  padding: 7px 12px;
  background: rgb(15 23 42 / 8%);
  color: #334155;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.window-btn:hover {
  transform: translateY(-1px);
  background: rgb(15 118 110 / 12%);
  color: #0f766e;
}

.window-btn.close {
  background: #111827;
  color: #fff;
}

.window-btn.close:hover {
  background: #0f766e;
  box-shadow: 0 10px 22px rgb(15 118 110 / 26%);
}

.dock {
  position: fixed;
  right: 18px;
  bottom: 18px;
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: min(360px, calc(100vw - 36px));
  padding: 9px 12px;
  border: 1px solid rgb(255 255 255 / 72%);
  border-radius: 999px;
  background: rgb(255 255 255 / 86%);
  box-shadow: 0 16px 42px rgb(15 23 42 / 22%);
  color: #111827;
  font: inherit;
  font-size: 13px;
  font-weight: 720;
  cursor: pointer;
  pointer-events: auto;
  backdrop-filter: blur(12px) saturate(150%);
  -webkit-backdrop-filter: blur(12px) saturate(150%);
}

.dock:hover {
  transform: translateY(-1px);
  box-shadow: 0 20px 50px rgb(15 23 42 / 26%);
}

.dock-logo {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  background: #fff;
}

.dock strong {
  color: #0f766e;
  font-size: 12px;
}

.screens {
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-columns: minmax(320px, 0.92fr) minmax(360px, 1.08fr);
  gap: 14px;
}

.audio-meters {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.meter {
  padding: 10px 12px;
  border: 1px solid rgb(15 23 42 / 7%);
  border-radius: 13px;
  background: rgb(255 255 255 / 58%);
}

.meter-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 7px;
  color: #475569;
  font-size: 12px;
  font-weight: 700;
}

.meter-head strong {
  color: #0f766e;
}

.meter-track {
  height: 7px;
  overflow: hidden;
  border-radius: 999px;
  background: rgb(148 163 184 / 18%);
}

.meter-track span {
  display: block;
  height: 100%;
  min-width: 2px;
  border-radius: inherit;
  background: linear-gradient(90deg, #14b8a6, #22c55e);
  transition: width 0.18s ease;
}

.screen {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid rgb(15 23 42 / 8%);
  border-radius: 16px;
  background: rgb(255 255 255 / 72%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 72%);
}

.screen-inner {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  overflow: auto;
}

.title-block {
  gap: 12px;
}

.title-block > span {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 12px;
  background: #0f766e;
  color: #fff;
  font-weight: 760;
  flex: 0 0 auto;
}

h3 {
  font-size: 22px;
  line-height: 1.12;
}

.title-block p {
  margin-top: 3px;
  color: #64748b;
  font-size: 13px;
}

.summary-section {
  display: grid;
  gap: 7px;
}

h4 {
  font-size: 13px;
  color: #334155;
  letter-spacing: 0;
}

ul {
  padding-left: 19px;
  display: grid;
  gap: 7px;
  color: #111827;
  font-size: 15px;
  line-height: 1.42;
}

.transcript-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.segment {
  padding: 12px;
  border-radius: 13px;
  background: #f8fafc;
  border: 1px solid rgb(15 23 42 / 7%);
}

.segment.microphone {
  background: rgb(236 253 245 / 86%);
}

.segment-head {
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
  color: #475569;
  font-size: 12px;
}

.original,
.translated {
  font-size: 15px;
  line-height: 1.46;
}

.original {
  color: #111827;
}

.translated {
  margin-top: 5px;
  color: #0f766e;
  font-weight: 650;
}

.empty {
  color: #64748b;
  font-size: 15px;
}

.transcription-status {
  padding: 9px 11px;
  border-radius: 12px;
  background: rgb(14 165 233 / 10%);
  color: #075985;
  font-size: 13px;
  line-height: 1.35;
}

@media (max-width: 820px) {
  :host { inset: 0; }
  .overlay {
    left: 8px !important;
    top: 8px !important;
    width: calc(100vw - 16px) !important;
    height: calc(100vh - 16px) !important;
    min-width: 0;
    resize: none;
  }
  .screens { grid-template-columns: 1fr; }
  .audio-meters { grid-template-columns: 1fr; }
  .topbar { align-items: flex-start; flex-direction: column; }
  .status { justify-content: flex-start; }
}
`
