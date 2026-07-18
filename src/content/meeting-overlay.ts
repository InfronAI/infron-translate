import type {
  MeetingContextAlignment,
  MeetingRuntimeState,
  MeetingSummaryState,
  TranscriptSegment,
} from '../shared/meeting'
import type {
  MeetingAudioStatusMsg,
  MeetingAudioChunkMsg,
  SetMeetingContextMsg,
  SetMeetingSystemAudioMsg,
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
  maximized: boolean
  restore?: {
    x: number
    y: number
    width: number
    height: number
  }
}

type DragState = {
  pointerId: number
  startX: number
  startY: number
  windowX: number
  windowY: number
}

export class MeetingOverlay {
  private host: HTMLElement | null = null
  private root: ShadowRoot | null = null
  private state: MeetingRuntimeState | null = null
  private windowState: MeetingWindowState | null = null
  private dragState: DragState | null = null
  private recognitionShouldRun = false
  private micStream: MediaStream | null = null
  private micAudioContext: AudioContext | null = null
  private micLevelTimer: ReturnType<typeof setInterval> | null = null
  private micPcmProcessor: ScriptProcessorNode | null = null
  private micPcmSilentGain: GainNode | null = null
  private micPcmTimer: ReturnType<typeof setInterval> | null = null
  private micPcmBuffers: Int16Array[] = []
  private micChunkStartedAt = 0
  private maxMicLevelSinceChunk = 0
  private contextEditorOpen = false
  private contextDraft = ''

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
        <div class="traffic-lights" role="group" aria-label="Window controls">
          <button class="traffic close" type="button" aria-label="Close Meeting Assistant"></button>
          <button class="traffic minimize" type="button" aria-label="Minimize Meeting Assistant"></button>
          <button class="traffic maximize" type="button" aria-label="${this.windowState.maximized ? 'Restore Meeting Assistant' : 'Maximize Meeting Assistant'}"></button>
        </div>
        <div class="input-switches" role="group" aria-label="Audio input controls">
          <button class="input-pill system-toggle ${audio.output ? 'active' : ''}" type="button">
            <span aria-hidden="true"></span>
            ${audio.output ? 'Stop System Audio' : 'Start System Audio'}
          </button>
          <button class="input-pill mic-toggle ${this.isMicActive() ? 'active recording' : ''}" type="button">
            <span aria-hidden="true"></span>
            ${this.isMicActive() ? 'Stop Mic' : 'Start Mic'}
          </button>
        </div>
      </header>
      <main class="screens">
        ${contextEditorHtml(
          this.contextEditorOpen,
          this.contextEditorOpen ? this.contextDraft : this.state.preMeetingMaterial,
          this.state.contextAlignment,
        )}
        <section class="audio-meters">
          ${meterHtml('Mic input', audio.microphone, audio.microphoneLevel, 'Local microphone signal')}
          ${meterHtml('System audio input', audio.output, audio.outputLevel, 'Audio captured from the active Chrome tab')}
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
    shell.querySelector<HTMLButtonElement>('.traffic.minimize')?.addEventListener('click', () => {
      this.syncWindowRect(shell)
      this.windowState = { ...this.windowState!, minimized: true }
      this.render()
    })
    shell.querySelector<HTMLButtonElement>('.traffic.maximize')?.addEventListener('click', () => {
      this.toggleMaximize(shell)
    })
    shell.querySelector<HTMLButtonElement>('.mic-toggle')?.addEventListener('click', () => {
      if (this.isMicActive()) this.stopLocalSpeechRecognition()
      else void this.startLocalSpeechRecognition()
    })
    shell.querySelector<HTMLButtonElement>('.system-toggle')?.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        type: 'set-meeting-system-audio',
        sessionId: session.id,
        enabled: !audio.output,
      } satisfies SetMeetingSystemAudioMsg)
    })
    shell.querySelector<HTMLButtonElement>('.context-toggle')?.addEventListener('click', () => {
      this.contextDraft = this.state?.preMeetingMaterial ?? ''
      this.contextEditorOpen = !this.contextEditorOpen
      this.render()
    })
    shell.querySelector<HTMLTextAreaElement>('.context-input')?.addEventListener('input', (event) => {
      this.contextDraft = (event.target as HTMLTextAreaElement).value
    })
    shell.querySelector<HTMLButtonElement>('.context-save')?.addEventListener('click', () => {
      if (!this.state) return
      void chrome.runtime.sendMessage({
        type: 'set-meeting-context',
        sessionId: this.state.session.id,
        material: this.contextDraft,
      } satisfies SetMeetingContextMsg)
      this.contextEditorOpen = false
      this.render()
    })
    shell.querySelector<HTMLButtonElement>('.context-clear')?.addEventListener('click', () => {
      if (!this.state) return
      this.contextDraft = ''
      void chrome.runtime.sendMessage({
        type: 'set-meeting-context',
        sessionId: this.state.session.id,
        material: '',
      } satisfies SetMeetingContextMsg)
      this.contextEditorOpen = false
      this.render()
    })
    shell.querySelector<HTMLButtonElement>('.traffic.close')?.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        type: 'stop-meeting-assistant',
        sessionId: session.id,
      } satisfies StopMeetingAssistantMsg)
    })
    shell
      .querySelector<HTMLElement>('.summary-screen')
      ?.append(renderSummary(summary, this.state.contextAlignment))
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
    if (this.windowState.maximized && this.windowState.restore) {
      this.windowState = {
        ...this.windowState.restore,
        x: event.clientX - Math.round(this.windowState.restore.width / 2),
        y: 8,
        minimized: false,
        maximized: false,
      }
      shell.style.left = `${this.windowState.x}px`
      shell.style.top = `${this.windowState.y}px`
      shell.style.width = `${this.windowState.width}px`
      shell.style.height = `${this.windowState.height}px`
    }
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

  private toggleMaximize(shell: HTMLElement): void {
    if (!this.windowState) return
    if (this.windowState.maximized && this.windowState.restore) {
      this.windowState = {
        ...this.windowState.restore,
        minimized: false,
        maximized: false,
      }
    } else {
      const rect = shell.getBoundingClientRect()
      this.windowState = {
        x: 8,
        y: 8,
        width: Math.max(MIN_WIDTH, window.innerWidth - 16),
        height: Math.max(MIN_HEIGHT, window.innerHeight - 16),
        minimized: false,
        maximized: true,
        restore: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
      }
    }
    this.render()
  }

  private async startLocalSpeechRecognition(): Promise<void> {
    if (!this.state) return
    const session = this.state.session
    try {
      await this.startMicLevelMeter(session.id)
      this.startMicRecorder(session.id, session.sourceLang)
      this.recognitionShouldRun = true
      await this.sendAudioStatus({
        active: true,
        source: 'external-stt',
        message: 'Microphone transcription is streaming to StepFun ASR.',
      })
      this.render()
      return
    } catch {
      this.render()
      return
    }
  }

  private stopLocalSpeechRecognition(): void {
    this.recognitionShouldRun = false
    this.stopMicLevelMeter()
    if (this.state) {
      void chrome.runtime.sendMessage({
        type: 'meeting-audio-status',
        sessionId: this.state.session.id,
        microphone: false,
        microphoneLevel: 0,
        transcription: {
          active: false,
          source: 'external-stt',
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
        const level = rmsLevel(data)
        this.maxMicLevelSinceChunk = Math.max(this.maxMicLevelSinceChunk, level)
        void chrome.runtime.sendMessage({
          type: 'meeting-audio-status',
          sessionId,
          microphone: true,
          microphoneLevel: level,
        } satisfies MeetingAudioStatusMsg)
      }, 500)
    } catch (error) {
      await this.sendAudioStatus({
        active: false,
        source: 'external-stt',
        message: `Microphone access failed: ${error instanceof Error ? error.message : String(error)}`,
      })
      throw error
    }
  }

  private stopMicLevelMeter(): void {
    if (this.micPcmTimer) {
      globalThis.clearInterval(this.micPcmTimer)
      this.micPcmTimer = null
    }
    if (this.micPcmProcessor) {
      this.micPcmProcessor.disconnect()
      this.micPcmProcessor = null
    }
    if (this.micPcmSilentGain) {
      this.micPcmSilentGain.disconnect()
      this.micPcmSilentGain = null
    }
    this.micPcmBuffers = []
    this.micChunkStartedAt = 0
    this.maxMicLevelSinceChunk = 0
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

  private startMicRecorder(sessionId: string, sourceLang: string): void {
    if (!this.micStream || !this.micAudioContext) return
    this.micPcmBuffers = []
    this.micChunkStartedAt = Date.now()
    const source = this.micAudioContext.createMediaStreamSource(this.micStream)
    this.micPcmProcessor = this.micAudioContext.createScriptProcessor(4096, 1, 1)
    this.micPcmSilentGain = this.micAudioContext.createGain()
    this.micPcmSilentGain.gain.value = 0
    this.micPcmProcessor.onaudioprocess = (event) => {
      this.micPcmBuffers.push(
        floatTo16kPcm(event.inputBuffer.getChannelData(0), this.micAudioContext?.sampleRate ?? 48000),
      )
    }
    source.connect(this.micPcmProcessor)
    this.micPcmProcessor.connect(this.micPcmSilentGain)
    this.micPcmSilentGain.connect(this.micAudioContext.destination)
    this.micPcmTimer = globalThis.setInterval(() => {
      const endedAt = Date.now()
      const startedAt = this.micChunkStartedAt || endedAt - 4000
      this.micChunkStartedAt = endedAt
      const shouldSend = this.maxMicLevelSinceChunk > 0.025
      this.maxMicLevelSinceChunk = 0
      const bytes = mergePcmBuffers(this.micPcmBuffers)
      this.micPcmBuffers = []
      if (!shouldSend) return
      void this.sendAudioChunk({
        type: 'meeting-audio-chunk',
        sessionId,
        channel: 'microphone',
        sourceLang,
        mimeType: 'audio/pcm',
        audioBase64: bytesToBase64(bytes),
        startedAt,
        endedAt,
      })
    }, 4000)
  }

  private async sendAudioChunk(message: MeetingAudioChunkMsg): Promise<void> {
    try {
      if (!message.audioBase64) return
      await chrome.runtime.sendMessage(message satisfies MeetingAudioChunkMsg)
    } catch {
      // Best-effort streaming.
    }
  }

  private isMicActive(): boolean {
    return Boolean(this.micPcmProcessor)
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
    maximized: false,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function meterHtml(label: string, enabled: boolean, level: number, caption: string): string {
  const percent = Math.round(clamp(level, 0, 1) * 100)
  const tone = percent >= 55 ? 'hot' : percent >= 18 ? 'live' : 'quiet'
  return `
    <div class="meter ${enabled ? 'enabled' : ''} ${tone}">
      <div class="meter-head">
        <div>
          <span class="meter-label"><i aria-hidden="true"></i>${escapeHtml(label)}</span>
          <small>${escapeHtml(caption)}</small>
        </div>
        <strong>${enabled ? `${percent}%` : 'Off'}</strong>
      </div>
      <div class="meter-track" aria-hidden="true">
        <span style="width: ${enabled ? percent : 0}%"></span>
      </div>
      <div class="meter-scale" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
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

function mergePcmBuffers(buffers: Int16Array[]): Uint8Array {
  const sampleCount = buffers.reduce((sum, buffer) => sum + buffer.length, 0)
  const bytes = new Uint8Array(sampleCount * 2)
  let offset = 0
  for (const buffer of buffers) {
    bytes.set(new Uint8Array(buffer.buffer), offset)
    offset += buffer.byteLength
  }
  return bytes
}

function floatTo16kPcm(input: Float32Array, inputSampleRate: number): Int16Array {
  const ratio = inputSampleRate / 16000
  const outputLength = Math.max(1, Math.floor(input.length / ratio))
  const output = new Int16Array(outputLength)
  for (let index = 0; index < outputLength; index += 1) {
    const sample = input[Math.min(input.length - 1, Math.floor(index * ratio))]
    const clamped = Math.max(-1, Math.min(1, sample))
    output[index] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return output
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function contextEditorHtml(
  open: boolean,
  material: string,
  alignment: MeetingContextAlignment,
): string {
  const label = alignment.hasMaterial
    ? statusLabel(alignment.strategyStatus)
    : 'No pre-meeting context'
  return `
    <section class="context-editor ${open ? 'open' : ''}">
      <div class="context-editor-head">
        <div>
          <strong>Pre-meeting Material</strong>
          <span class="alignment-pill ${alignment.strategyStatus}">${escapeHtml(label)}</span>
        </div>
        <button class="context-toggle" type="button">${open ? 'Cancel' : alignment.hasMaterial ? 'Edit' : 'Add'}</button>
      </div>
      ${
        open
          ? `
            <textarea class="context-input" maxlength="20000" placeholder="Paste the agenda, planned goals, account context, strategy, risks, and expected outcomes.">${escapeHtml(material)}</textarea>
            <div class="context-actions">
              <button class="context-save" type="button">Save Context</button>
              <button class="context-clear" type="button">Clear</button>
            </div>
          `
          : `<p>${escapeHtml(
              alignment.hasMaterial
                ? materialPreview(material)
                : 'Add agenda, goals, strategy, risks, and expected outcomes before or during the meeting.',
            )}</p>`
      }
    </section>
  `
}

function renderSummary(
  summary: MeetingSummaryState,
  alignment: MeetingContextAlignment,
): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'screen-inner'
  wrapper.append(
    titleBlock('1', 'Meeting Outline', summary.currentTopic),
    renderAlignment(alignment),
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

function renderAlignment(alignment: MeetingContextAlignment): HTMLElement {
  const wrapper = document.createElement('section')
  wrapper.className = 'alignment-panel'
  const title = document.createElement('div')
  title.className = 'alignment-title'
  title.innerHTML = `
    <h4>Context Alignment</h4>
    <span class="alignment-pill ${alignment.strategyStatus}">${escapeHtml(statusLabel(alignment.strategyStatus))}</span>
  `
  wrapper.append(
    title,
    section('Completed Goals', alignment.completedGoals.length ? alignment.completedGoals : ['No goal has enough transcript evidence yet.']),
    section('Unmet Goals', alignment.unmetGoals),
    section('Course-correction Suggestions', alignment.correctiveSuggestions),
    section('Evidence and Reflection', alignment.evidence),
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

function statusLabel(status: MeetingContextAlignment['strategyStatus']): string {
  if (status === 'on-track') return 'On track'
  if (status === 'at-risk') return 'At risk'
  if (status === 'off-track') return 'Off track'
  return 'Not provided'
}

function materialPreview(material: string): string {
  const normalized = material.replace(/\s+/gu, ' ').trim()
  return normalized.length > 180 ? `${normalized.slice(0, 180)}...` : normalized
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
  border: 1px solid #dfe3e8;
  border-radius: 18px;
  background: rgb(247 248 250 / 96%);
  box-shadow: 0 26px 80px rgb(15 23 42 / 26%);
  backdrop-filter: blur(16px) saturate(155%);
  -webkit-backdrop-filter: blur(16px) saturate(155%);
  pointer-events: auto;
  resize: both;
  overflow: hidden;
}

.topbar,
.traffic-lights,
.input-switches,
.title-block,
.segment-head {
  display: flex;
  align-items: center;
}

.topbar {
  justify-content: space-between;
  gap: 14px;
  cursor: grab;
  user-select: none;
  touch-action: none;
}

.topbar:active {
  cursor: grabbing;
}

.traffic-lights {
  gap: 8px;
  flex: 0 0 auto;
  padding: 0 2px;
  cursor: default;
}

.traffic {
  all: unset;
  position: relative;
  width: 13px;
  height: 13px;
  border-radius: 999px;
  box-shadow:
    inset 0 0 0 1px rgb(15 23 42 / 10%),
    inset 0 1px 0 rgb(255 255 255 / 52%);
  cursor: pointer;
}

.traffic.close {
  background: #ff5f57;
}

.traffic.minimize {
  background: #febc2e;
}

.traffic.maximize {
  background: #28c840;
}

.traffic::after {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: rgb(15 23 42 / 58%);
  font-size: 9px;
  font-weight: 800;
  line-height: 1;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.traffic-lights:hover .traffic::after {
  opacity: 1;
}

.traffic.close::after { content: "x"; }
.traffic.minimize::after { content: "-"; }
.traffic.maximize::after { content: "+"; }

.traffic:hover {
  filter: saturate(1.06) brightness(0.98);
}

h2,
h3,
h4,
p,
ul {
  margin: 0;
}

.input-switches {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  padding: 3px;
  border: 1px solid #dfe3e8;
  border-radius: 999px;
  background: rgb(255 255 255 / 54%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 62%);
  cursor: default;
}

.input-pill {
  border: 0;
  border-radius: 999px;
  padding: 7px 12px;
  background: rgb(15 23 42 / 8%);
  color: #334155;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 7px;
  box-shadow: 0 8px 18px rgb(23 105 224 / 14%);
  transition: transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.input-pill:hover {
  transform: translateY(-1px);
  background: #eaf2ff;
  color: #1769e0;
}

.input-pill:active {
  transform: translateY(0) scale(0.98);
}

.input-pill span {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #94a3b8;
  box-shadow: 0 0 0 3px rgb(148 163 184 / 14%);
}

.input-pill.active {
  background: #16794a;
  color: #fff;
  box-shadow: 0 8px 18px rgb(22 121 74 / 20%);
}

.input-pill.active:hover {
  background: #12673f;
  color: #fff;
  box-shadow: 0 10px 22px rgb(22 121 74 / 26%);
}

.input-pill.active span {
  background: rgb(255 255 255 / 78%);
  box-shadow: 0 0 0 3px rgb(255 255 255 / 16%);
}

.input-pill.recording span {
  animation: micPulse 1.1s ease-in-out infinite;
}

@keyframes micPulse {
  0%, 100% { opacity: 0.55; transform: scale(0.86); }
  50% { opacity: 1; transform: scale(1.1); }
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

.screens {
  min-height: 0;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr);
  grid-template-columns: minmax(320px, 0.92fr) minmax(360px, 1.08fr);
  gap: 14px;
}

.context-editor {
  grid-column: 1 / -1;
  display: grid;
  gap: 9px;
  padding: 12px;
  border: 1px solid #dfe3e8;
  border-radius: 14px;
  background: rgb(255 255 255 / 66%);
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 70%);
}

.context-editor-head,
.context-editor-head > div,
.context-actions,
.alignment-title {
  display: flex;
  align-items: center;
}

.context-editor-head {
  justify-content: space-between;
  gap: 12px;
}

.context-editor-head > div {
  min-width: 0;
  gap: 9px;
  flex-wrap: wrap;
}

.context-editor strong {
  color: #111827;
  font-size: 13px;
}

.context-editor p {
  color: #64748b;
  font-size: 12px;
  line-height: 1.35;
}

.context-input {
  width: 100%;
  min-height: 86px;
  max-height: 180px;
  resize: vertical;
  border: 1px solid #cbd1d8;
  border-radius: 12px;
  padding: 10px 11px;
  background: rgb(255 255 255 / 82%);
  color: #111827;
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  outline: none;
}

.context-input:focus {
  border-color: rgb(23 105 224 / 42%);
  box-shadow: 0 0 0 3px rgb(23 105 224 / 12%);
}

.context-actions {
  justify-content: flex-end;
  gap: 8px;
}

.context-toggle,
.context-save,
.context-clear {
  border: 0;
  border-radius: 999px;
  padding: 7px 11px;
  font: inherit;
  font-size: 12px;
  font-weight: 740;
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease, color 0.15s ease;
}

.context-toggle,
.context-clear {
  background: rgb(15 23 42 / 8%);
  color: #334155;
}

.context-save {
  background: #1769e0;
  color: #fff;
}

.context-toggle:hover,
.context-clear:hover {
  transform: translateY(-1px);
  background: #eaf2ff;
  color: #1769e0;
}

.context-save:hover {
  transform: translateY(-1px);
  background: #0f56bd;
}

.audio-meters {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.meter {
  position: relative;
  padding: 12px;
  border: 1px solid #dfe3e8;
  border-radius: 14px;
  background:
    linear-gradient(180deg, rgb(255 255 255 / 72%), rgb(248 250 252 / 62%));
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 72%);
}

.meter-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
  color: #475569;
}

.meter-label {
  display: flex;
  align-items: center;
  gap: 7px;
  color: #111827;
  font-size: 13px;
  font-weight: 760;
}

.meter-label i {
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #94a3b8;
  box-shadow: 0 0 0 3px rgb(148 163 184 / 14%);
}

.meter.enabled .meter-label i {
  background: #10b981;
  box-shadow: 0 0 0 3px rgb(16 185 129 / 16%), 0 0 14px rgb(16 185 129 / 38%);
}

.meter-head small {
  display: block;
  margin-top: 3px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.25;
}

.meter-head strong {
  color: #1769e0;
  font-size: 18px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.meter-track {
  height: 11px;
  overflow: hidden;
  border-radius: 999px;
  background:
    linear-gradient(90deg, rgb(15 23 42 / 8%), rgb(15 23 42 / 5%));
  box-shadow: inset 0 1px 2px rgb(15 23 42 / 12%);
}

.meter-track span {
  display: block;
  height: 100%;
  min-width: 2px;
  border-radius: inherit;
  background: linear-gradient(90deg, #1769e0, #16794a);
  box-shadow: 0 0 16px rgb(23 105 224 / 24%);
  transition: width 0.18s ease;
}

.meter.hot .meter-track span {
  background: linear-gradient(90deg, #16794a, #d28a18);
}

.meter-scale {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
  margin-top: 7px;
}

.meter-scale span {
  height: 2px;
  border-radius: 999px;
  background: rgb(100 116 139 / 18%);
}

.screen {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid #dfe3e8;
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
  background: #1769e0;
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

.alignment-panel {
  display: grid;
  gap: 12px;
  padding: 13px;
  border: 1px solid rgb(23 105 224 / 14%);
  border-radius: 14px;
  background: linear-gradient(180deg, rgb(234 242 255 / 78%), rgb(255 255 255 / 68%));
}

.alignment-title {
  justify-content: space-between;
  gap: 10px;
}

.alignment-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: fit-content;
  white-space: nowrap;
  border-radius: 999px;
  padding: 4px 8px;
  background: rgb(100 116 139 / 12%);
  color: #475569;
  font-size: 11px;
  font-weight: 760;
}

.alignment-pill::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #94a3b8;
  box-shadow: 0 0 0 3px rgb(148 163 184 / 14%);
}

.alignment-pill.on-track {
  background: rgb(16 185 129 / 12%);
  color: #047857;
}

.alignment-pill.on-track::before {
  background: #10b981;
  box-shadow: 0 0 0 3px rgb(16 185 129 / 16%);
}

.alignment-pill.at-risk {
  background: rgb(245 158 11 / 13%);
  color: #92400e;
}

.alignment-pill.at-risk::before {
  background: #f59e0b;
  box-shadow: 0 0 0 3px rgb(245 158 11 / 16%);
}

.alignment-pill.off-track {
  background: rgb(239 68 68 / 12%);
  color: #b91c1c;
}

.alignment-pill.off-track::before {
  background: #ef4444;
  box-shadow: 0 0 0 3px rgb(239 68 68 / 16%);
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
  background: #e8f6ef;
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
  color: #16794a;
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
}
`
