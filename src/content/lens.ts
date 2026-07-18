export type LensViewState =
  | { kind: 'hidden' }
  | {
      kind: 'ready'
      /** Chinese translation */
      text: string
      /** English source text when the target is a text block. */
      sourceText?: string
      sourceRect?: DOMRect
    }
  | {
      kind: 'pending'
      sourceText?: string
      sourceRect?: DOMRect
    }
  | { kind: 'empty' }
  | {
      kind: 'error'
      message: string
      sourceText?: string
      sourceRect?: DOMRect
    }
  | { kind: 'unconfigured' }

/**
 * Liquid-glass lens: bilingual EN/ZH panel placed **beside** the source
 * (never covering the original reading text).
 */
export class LensOverlay {
  private host: HTMLDivElement
  private root: ShadowRoot
  private panel: HTMLDivElement
  private textLayer: HTMLDivElement
  private sourceLabel: HTMLDivElement
  private sourceBody: HTMLDivElement
  private zhLabel: HTMLDivElement
  private body: HTMLDivElement
  private divider: HTMLDivElement
  private hint: HTMLDivElement
  private ring: HTMLDivElement
  private highlightEl: Element | null = null
  private widthPx: number
  private lastSourceKey = ''

  constructor(widthPx = 340) {
    this.widthPx = widthPx
    this.host = document.createElement('div')
    this.host.id = 'infron-translate-root'
    Object.assign(this.host.style, {
      all: 'initial',
      position: 'fixed',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '2147483647',
    })
    this.root = this.host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = LENS_STYLES

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('width', '0')
    svg.setAttribute('height', '0')
    svg.style.position = 'absolute'
    svg.innerHTML = `
      <defs>
        <filter id="glass-distortion" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">
          <feTurbulence type="fractalNoise" baseFrequency="0.008 0.008" numOctaves="2" seed="3" result="noise" />
          <feGaussianBlur in="noise" stdDeviation="0.5" result="softNoise" />
          <feDisplacementMap in="SourceGraphic" in2="softNoise" scale="12" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </defs>
    `

    // Thin outline only — no blur/frost over original text
    this.ring = document.createElement('div')
    this.ring.className = 'source-outline'
    this.ring.style.display = 'none'

    this.panel = document.createElement('div')
    this.panel.className = 'liquidGlass-wrapper panel'
    this.panel.style.display = 'none'

    const effect = document.createElement('div')
    effect.className = 'liquidGlass-effect'
    const tint = document.createElement('div')
    tint.className = 'liquidGlass-tint'
    const shine = document.createElement('div')
    shine.className = 'liquidGlass-shine'

    this.textLayer = document.createElement('div')
    this.textLayer.className = 'liquidGlass-text'

    this.sourceLabel = document.createElement('div')
    this.sourceLabel.className = 'label label-en'
    this.sourceLabel.textContent = 'EN'

    this.sourceBody = document.createElement('div')
    this.sourceBody.className = 'body body-en'

    this.divider = document.createElement('div')
    this.divider.className = 'divider'

    this.zhLabel = document.createElement('div')
    this.zhLabel.className = 'label label-zh'
    this.zhLabel.textContent = '中文'

    this.body = document.createElement('div')
    this.body.className = 'body body-zh'

    this.hint = document.createElement('div')
    this.hint.className = 'hint'

    this.textLayer.append(
      this.sourceLabel,
      this.sourceBody,
      this.divider,
      this.zhLabel,
      this.body,
      this.hint,
    )
    this.panel.append(effect, tint, shine, this.textLayer)
    this.root.append(style, svg, this.ring, this.panel)
    this.applyWidth()
  }

  private applyWidth(): void {
    this.panel.style.width = `${this.widthPx}px`
    this.panel.style.maxWidth = `${this.widthPx}px`
  }

  mount(): void {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host)
  }


  setWidth(widthPx: number): void {
    this.widthPx = Math.max(280, widthPx)
    this.applyWidth()
  }

  /**
   * Scale the lens body text off the shared page-translation font-size setting so
   * the lens and full-page modes stay visually consistent. The offsets reproduce
   * the original 16.5px / 14.5px look at the default 14px setting.
   */
  setFontSize(fontSizePx: number): void {
    const base = Math.max(10, Math.min(28, fontSizePx))
    this.host.style.setProperty('--lens-zh-size', `${base + 2.5}px`)
    this.host.style.setProperty('--lens-en-size', `${base + 0.5}px`)
  }

  /** Render one state, then place the selectable panel outside the highlighted source. */
  showAt(
    clientX: number,
    clientY: number,
    state: Exclude<LensViewState, { kind: 'hidden' }>,
  ): void {
    this.mount()
    this.panel.style.display = 'flex'
    this.panel.classList.add('is-visible')
    this.body.classList.remove('muted', 'pending-anim')
    this.sourceBody.classList.remove('muted')

    const sourceText =
      'sourceText' in state && state.sourceText ? state.sourceText : ''

    // Bilingual sections
    const showSource = Boolean(sourceText)
    this.sourceLabel.hidden = !showSource
    this.sourceBody.hidden = !showSource
    this.divider.hidden = !showSource
    this.zhLabel.hidden = state.kind === 'empty' || state.kind === 'unconfigured'

    if (showSource) {
      this.sourceBody.textContent = sourceText
    } else {
      this.sourceBody.textContent = ''
    }

    switch (state.kind) {
      case 'ready':
        this.zhLabel.textContent = '中文'
        this.body.textContent = state.text
        break
      case 'pending':
        this.zhLabel.textContent = '中文'
        this.body.classList.add('muted', 'pending-anim')
        this.body.textContent = '翻译中…'
        break
      case 'empty':
        this.sourceLabel.hidden = true
        this.sourceBody.hidden = true
        this.divider.hidden = true
        this.zhLabel.hidden = true
        this.body.classList.add('muted')
        this.body.textContent = '此处无可译文本（请移到文字上）'
        break
      case 'error':
        this.zhLabel.textContent = '中文'
        this.body.classList.add('muted')
        this.body.textContent = state.message
        break
      case 'unconfigured':
        this.sourceLabel.hidden = true
        this.sourceBody.hidden = true
        this.divider.hidden = true
        this.zhLabel.hidden = true
        this.body.classList.add('muted')
        this.body.textContent = '请先在扩展「选项」中配置 API'
        break
    }

    this.hint.textContent = '可直接选择文本复制'

    const sourceRect =
      'sourceRect' in state && state.sourceRect ? state.sourceRect : null
    if (sourceRect) {
      const nextKey = `${Math.round(sourceRect.left)}|${Math.round(sourceRect.top)}|${Math.round(sourceRect.right)}|${Math.round(sourceRect.bottom)}`
      if (nextKey !== this.lastSourceKey) {
        this.lastSourceKey = nextKey
        this.placePanel(clientX, clientY, sourceRect)
      }
    } else {
      this.lastSourceKey = ''
      this.placePanel(clientX, clientY, null)
    }
  }


  /**
   * Place glass panel **outside** the source rect so original text stays fully readable.
   * Prefer below → above → right → left of source; fall back to cursor offset.
   */
  private placePanel(clientX: number, clientY: number, sourceRect: DOMRect | null): void {
    const gap = 12
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Measure after content set
    const pr = this.panel.getBoundingClientRect()
    const pw = Math.max(pr.width, this.widthPx)
    const ph = Math.max(pr.height, 80)

    let left = clientX + 16
    let top = clientY + 16

    if (sourceRect && sourceRect.width > 0) {
      const candidates: { left: number; top: number; score: number }[] = []

      // Below source
      candidates.push({
        left: clamp(sourceRect.left, 8, vw - pw - 8),
        top: sourceRect.bottom + gap,
        score: 4,
      })
      // Above source
      candidates.push({
        left: clamp(sourceRect.left, 8, vw - pw - 8),
        top: sourceRect.top - ph - gap,
        score: 3,
      })
      // Right of source
      candidates.push({
        left: sourceRect.right + gap,
        top: clamp(sourceRect.top, 8, vh - ph - 8),
        score: 2,
      })
      // Left of source
      candidates.push({
        left: sourceRect.left - pw - gap,
        top: clamp(sourceRect.top, 8, vh - ph - 8),
        score: 1,
      })

      let best: { left: number; top: number; score: number } | null = null
      for (const c of candidates) {
        const fits =
          c.left >= 8 &&
          c.top >= 8 &&
          c.left + pw <= vw - 8 &&
          c.top + ph <= vh - 8
        if (!fits) continue
        // Prefer not overlapping source
        const panelBox = {
          left: c.left,
          top: c.top,
          right: c.left + pw,
          bottom: c.top + ph,
        }
        const overlaps = !(
          panelBox.right < sourceRect.left - 4 ||
          panelBox.left > sourceRect.right + 4 ||
          panelBox.bottom < sourceRect.top - 4 ||
          panelBox.top > sourceRect.bottom + 4
        )
        const score = c.score + (overlaps ? -10 : 0)
        if (!best || score > best.score) best = { ...c, score }
      }

      if (best) {
        left = best.left
        top = best.top
      } else {
        // Clamp cursor-based fallback
        left = clamp(clientX + 16, 8, vw - pw - 8)
        top = clamp(clientY + 16, 8, vh - ph - 8)
        // If still overlaps source, force below viewport mid
        if (sourceRect) {
          top = clamp(sourceRect.bottom + gap, 8, vh - ph - 8)
        }
      }
    } else {
      left = clamp(left, 8, vw - pw - 8)
      top = clamp(top, 8, vh - ph - 8)
    }

    this.panel.style.left = `${left}px`
    this.panel.style.top = `${top}px`
  }

  hide(): void {
    this.panel.style.display = 'none'
    this.panel.classList.remove('is-visible')
    this.lastSourceKey = ''
    this.clearHighlight()
  }

  getHost(): HTMLDivElement {
    return this.host
  }

  highlight(el: Element | null): void {
    if (this.highlightEl === el) {
      if (el) this.positionRing(el)
      return
    }
    this.highlightEl = el
    if (!el) {
      this.ring.style.display = 'none'
      return
    }
    this.positionRing(el)
  }

  /** Re-place the ring on the currently highlighted element (e.g. after scroll). */
  reposition(): void {
    if (this.highlightEl) this.positionRing(this.highlightEl)
  }

  private positionRing(el: Element): void {
    if (!el.isConnected) {
      this.ring.style.display = 'none'
      return
    }
    const r = el.getBoundingClientRect()
    const offscreen =
      r.bottom <= 0 ||
      r.right <= 0 ||
      r.top >= window.innerHeight ||
      r.left >= window.innerWidth
    if (r.width < 1 || r.height < 1 || offscreen) {
      this.ring.style.display = 'none'
      return
    }
    const pad = 3
    this.ring.style.display = 'block'
    this.ring.style.left = `${r.left - pad}px`
    this.ring.style.top = `${r.top - pad}px`
    this.ring.style.width = `${r.width + pad * 2}px`
    this.ring.style.height = `${r.height + pad * 2}px`
  }

  private clearHighlight(): void {
    this.highlightEl = null
    this.ring.style.display = 'none'
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

const LENS_STYLES = `
  :host, * { box-sizing: border-box; }

  .liquidGlass-wrapper {
    position: fixed;
    display: flex;
    overflow: hidden;
    padding: 0.9rem 1.1rem;
    border-radius: 1.35rem;
    box-shadow:
      0 8px 28px rgba(0, 0, 0, 0.14),
      0 2px 8px rgba(0, 0, 0, 0.08),
      0 0 0 0.5px rgba(255, 255, 255, 0.8);
    transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    color: rgba(0, 0, 0, 0.92);
  }

  .liquidGlass-wrapper.is-visible {
    animation: glassIn 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
  }

  @keyframes glassIn {
    from { opacity: 0; transform: scale(0.94) translateY(6px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
  }

  .liquidGlass-effect {
    position: absolute;
    z-index: 0;
    inset: 0;
    border-radius: inherit;
    backdrop-filter: blur(18px) saturate(140%);
    -webkit-backdrop-filter: blur(18px) saturate(140%);
    filter: url(#glass-distortion);
    isolation: isolate;
  }

  .liquidGlass-tint {
    position: absolute;
    z-index: 1;
    inset: 0;
    border-radius: inherit;
    background: rgba(255, 255, 255, 0.9);
    background-image:
      linear-gradient(
        145deg,
        rgba(255, 255, 255, 0.97) 0%,
        rgba(255, 255, 255, 0.92) 48%,
        rgba(245, 248, 255, 0.9) 100%
      );
  }

  .liquidGlass-shine {
    position: absolute;
    z-index: 2;
    inset: 0;
    border-radius: inherit;
    box-shadow:
      inset 2px 2px 1px 0 rgba(255, 255, 255, 0.75),
      inset -1px -1px 1px 1px rgba(255, 255, 255, 0.45),
      inset 0 0 0 0.5px rgba(255, 255, 255, 0.65);
    pointer-events: none;
  }

  .liquidGlass-text {
    position: relative;
    z-index: 3;
    width: 100%;
    min-width: 0;
  }

  .panel {
    flex-direction: column;
    max-height: min(440px, 58vh);
    background: rgba(255, 255, 255, 0.62);
  }
  .panel {
    pointer-events: auto;
    user-select: text;
  }

  .panel .body,
  .panel .hint {
    cursor: text;
  }

  .panel .liquidGlass-text {
    overflow: auto;
    max-height: min(420px, 54vh);
  }

  .label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: rgba(0, 0, 0, 0.4);
    margin-bottom: 4px;
  }

  .label-zh {
    margin-top: 2px;
  }

  .divider {
    height: 1px;
    margin: 10px 0;
    background: linear-gradient(
      90deg,
      rgba(0, 0, 0, 0.06),
      rgba(0, 0, 0, 0.12),
      rgba(0, 0, 0, 0.06)
    );
  }

  .body {
    white-space: pre-wrap;
    word-break: break-word;
    font-size: var(--lens-zh-size, 16.5px);
    line-height: 1.55;
    color: rgba(0, 0, 0, 0.92);
    font-weight: 520;
  }

  .body-en {
    font-size: var(--lens-en-size, 14.5px);
    line-height: 1.5;
    color: rgba(0, 0, 0, 0.55);
    font-weight: 450;
  }

  .body-zh {
    font-size: var(--lens-zh-size, 16.5px);
    color: rgba(0, 0, 0, 0.92);
    font-weight: 520;
  }

  .body.muted {
    color: rgba(0, 0, 0, 0.52);
    font-weight: 400;
  }

  .hint {
    margin-top: 10px;
    font-size: 11.5px;
    color: rgba(0, 0, 0, 0.38);
    line-height: 1.4;
  }

  /* Outline only — no frost/blur over the original English */
  .source-outline {
    position: fixed;
    pointer-events: none;
    border-radius: 6px;
    border: 1.5px solid rgba(0, 122, 255, 0.55);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.5);
    background: transparent;
  }

  @keyframes lens-pulse {
    0%, 100% { opacity: 0.55; }
    50% { opacity: 1; }
  }

  .pending-anim {
    animation: lens-pulse 1.1s ease-in-out infinite;
  }
`
