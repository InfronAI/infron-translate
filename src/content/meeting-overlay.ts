import type {
  MeetingRuntimeState,
  MeetingSummaryState,
  MeetingUpdatePayload,
  TranscriptSegment,
} from '../shared/meeting'
import type { StopMeetingAssistantMsg } from '../shared/messages'

const HOST_ID = 'infron-meeting-assistant-root'

export class MeetingOverlay {
  private host: HTMLElement | null = null
  private root: ShadowRoot | null = null
  private state: MeetingRuntimeState | null = null

  show(state: MeetingRuntimeState): void {
    this.state = state
    this.ensureRoot()
    this.render()
  }

  update(update: MeetingUpdatePayload): void {
    if (!this.state) return
    this.state = {
      ...this.state,
      session: update.session,
      segments: update.segments,
      summary: update.summary,
    }
    this.render()
  }

  hide(): void {
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
    if (!this.root || !this.state) return
    const { session, segments, summary, audio } = this.state
    this.root.replaceChildren()
    const style = document.createElement('style')
    style.textContent = css

    const shell = document.createElement('section')
    shell.className = 'overlay'
    shell.setAttribute('aria-label', 'Infron Translate Meeting Assistant')
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
          <button class="stop" type="button">Stop</button>
        </div>
      </header>
      <main class="screens">
        <article class="screen summary-screen"></article>
        <article class="screen transcript-screen"></article>
      </main>
    `
    shell.querySelector<HTMLButtonElement>('.stop')?.addEventListener('click', () => {
      void chrome.runtime.sendMessage({
        type: 'stop-meeting-assistant',
        sessionId: session.id,
      } satisfies StopMeetingAssistantMsg)
    })
    shell.querySelector<HTMLElement>('.summary-screen')?.append(renderSummary(summary))
    shell.querySelector<HTMLElement>('.transcript-screen')?.append(renderTranscript(segments))
    this.root.append(style, shell)
  }
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

function renderTranscript(segments: TranscriptSegment[]): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'screen-inner'
  wrapper.append(titleBlock('2', 'Live Transcript', 'Original speech and translated text'))
  const list = document.createElement('div')
  list.className = 'transcript-list'
  const recent = segments.slice(-28)
  if (!recent.length) {
    const empty = document.createElement('p')
    empty.className = 'empty'
    empty.textContent = 'Waiting for speech...'
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
  inset: 20px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #111827;
}

* { box-sizing: border-box; }

.overlay {
  width: 100%;
  height: 100%;
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

.stop {
  border: 0;
  border-radius: 10px;
  padding: 7px 12px;
  background: #111827;
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
  transition: transform 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.stop:hover {
  transform: translateY(-1px);
  background: #0f766e;
  box-shadow: 0 10px 22px rgb(15 118 110 / 26%);
}

.screens {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(320px, 0.92fr) minmax(360px, 1.08fr);
  gap: 14px;
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

@media (max-width: 820px) {
  :host { inset: 10px; }
  .screens { grid-template-columns: 1fr; }
  .topbar { align-items: flex-start; flex-direction: column; }
  .status { justify-content: flex-start; }
}
`
