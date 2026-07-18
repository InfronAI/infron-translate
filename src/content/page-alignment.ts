import { normalizeText } from '../shared/text'
import { BrowserTranslator } from './browser-translator'

export const PAGE_ALIGNMENT_HIGHLIGHT_NAME = 'lens-page-alignment-match'
export const PAGE_ALIGNMENT_FALLBACK_ATTR = 'data-lens-page-alignment-source'

export type DisplaySegment = {
  text: string
  start: number
  end: number
  wordIndex: number | null
}

export type SourceSpan = {
  start: number
  end: number
}

type WordSegment = SourceSpan & { text: string }

type AlignmentEntry = {
  host: Element
  sourceText: string
  translation: string
  sourceLanguage: string
  targetLanguage: string
  isUi: boolean
  segments: DisplaySegment[]
  wordCount: number
  alignments: Map<number, Promise<SourceSpan | null>>
}

type TextPoint = { node: Text; offset: number }

type NormalizedTextIndex = {
  text: string
  starts: TextPoint[]
  ends: TextPoint[]
}

type HighlightRegistryLike = {
  set(name: string, highlight: unknown): void
  delete(name: string): void
}

type HighlightGlobal = typeof globalThis & {
  Highlight?: new (...ranges: Range[]) => unknown
}

const TRANSLATED_SELECTOR = '[data-lens-page-translated]'
const OVERLAY_ID = 'infron-translate-page-alignment-overlay'

function fallbackWordSegments(text: string): WordSegment[] {
  const words: WordSegment[] = []
  const pattern = /\p{Script=Han}|[\p{L}\p{M}\p{N}_'-]+/gu
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    words.push({ text: match[0], start, end: start + match[0].length })
  }
  return words
}

function wordSegments(text: string, locale: string): WordSegment[] {
  if (typeof Intl.Segmenter !== 'function') return fallbackWordSegments(text)
  const segmenter = new Intl.Segmenter(locale, { granularity: 'word' })
  const words: WordSegment[] = []
  for (const part of segmenter.segment(text)) {
    if (!part.isWordLike) continue
    words.push({ text: part.segment, start: part.index, end: part.index + part.segment.length })
  }
  return words
}

/** Preserve all target punctuation and whitespace while marking hoverable words. */
export function segmentDisplayText(text: string, locale: string): DisplaySegment[] {
  const words = wordSegments(text, locale)
  const segments: DisplaySegment[] = []
  let cursor = 0
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const word = words[wordIndex]
    if (word.start > cursor) {
      segments.push({ text: text.slice(cursor, word.start), start: cursor, end: word.start, wordIndex: null })
    }
    segments.push({ ...word, wordIndex })
    cursor = word.end
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), start: cursor, end: text.length, wordIndex: null })
  }
  return segments
}

function normalizedWord(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let row = 1; row <= a.length; row++) {
    let diagonal = previous[0]
    previous[0] = row
    for (let column = 1; column <= b.length; column++) {
      const above = previous[column]
      previous[column] = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (a[row - 1] === b[column - 1] ? 0 : 1),
      )
      diagonal = above
    }
  }
  return previous[b.length]
}

function wordSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const shorter = Math.min(a.length, b.length)
  const longer = Math.max(a.length, b.length)
  if (shorter >= 3 && (a.includes(b) || b.includes(a))) {
    return Math.min(0.9, 0.2 + shorter / longer)
  }
  return Math.max(0, 1 - editDistance(a, b) / longer)
}

function proportionalSourceSpan(
  sourceWords: WordSegment[],
  targetWordIndex: number,
  targetWordCount: number,
): SourceSpan | null {
  if (!sourceWords.length) return null
  const ratio = (targetWordIndex + 0.5) / Math.max(1, targetWordCount)
  const index = Math.min(sourceWords.length - 1, Math.floor(ratio * sourceWords.length))
  return { start: sourceWords[index].start, end: sourceWords[index].end }
}

/** Match a target word's local back-translation to a nearby source word or phrase. */
export function findApproximateSourceSpan(
  sourceText: string,
  backTranslation: string,
  targetWordIndex: number,
  targetWordCount: number,
  sourceLocale: string,
): SourceSpan | null {
  const sourceWords = wordSegments(sourceText, sourceLocale)
  const fallback = proportionalSourceSpan(sourceWords, targetWordIndex, targetWordCount)
  const queryWords = wordSegments(backTranslation, sourceLocale)
    .map((word) => normalizedWord(word.text))
    .filter(Boolean)
  if (!sourceWords.length || !queryWords.length) return fallback

  const normalizedSource = sourceWords.map((word) => normalizedWord(word.text))
  const expectedPosition = (targetWordIndex + 0.5) / Math.max(1, targetWordCount)
  const minimumLength = Math.max(1, queryWords.length - 1)
  const maximumLength = Math.min(sourceWords.length, queryWords.length + 2)
  let best: { lexical: number; score: number; start: number; end: number } | null = null

  for (let length = minimumLength; length <= maximumLength; length++) {
    for (let start = 0; start + length <= sourceWords.length; start++) {
      const window = normalizedSource.slice(start, start + length)
      const queryCoverage =
        queryWords.reduce(
          (total, query) => total + Math.max(...window.map((word) => wordSimilarity(query, word))),
          0,
        ) / queryWords.length
      const windowPrecision =
        window.reduce(
          (total, word) =>
            total + Math.max(...queryWords.map((query) => wordSimilarity(query, word))),
          0,
        ) / window.length
      const lexical = queryCoverage * 0.7 + windowPrecision * 0.3
      const center = (start + length / 2) / sourceWords.length
      const proximity = Math.max(0, 1 - Math.abs(center - expectedPosition))
      const score = lexical * 0.82 + proximity * 0.18
      if (!best || score > best.score) best = { lexical, score, start, end: start + length }
    }
  }

  if (!best || best.lexical < 0.34) return fallback
  return {
    start: sourceWords[best.start].start,
    end: sourceWords[best.end - 1].end,
  }
}

function normalizedTextIndex(host: Element): NormalizedTextIndex {
  const starts: TextPoint[] = []
  const ends: TextPoint[] = []
  let text = ''
  let pendingWhitespace: TextPoint | null = null
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  let current = walker.nextNode() as Text | null

  const append = (value: string, start: TextPoint, end: TextPoint) => {
    text += value
    for (let index = 0; index < value.length; index++) {
      starts.push(start)
      ends.push(end)
    }
  }

  while (current) {
    const value = current.data
    for (let offset = 0; offset < value.length; ) {
      const codePoint = value.codePointAt(offset)!
      const character = String.fromCodePoint(codePoint)
      const length = character.length
      if (/\s/u.test(character)) {
        if (text && !pendingWhitespace) pendingWhitespace = { node: current, offset }
      } else {
        if (pendingWhitespace) {
          append(' ', pendingWhitespace, {
            node: pendingWhitespace.node,
            offset: pendingWhitespace.offset + 1,
          })
          pendingWhitespace = null
        }
        append(character, { node: current, offset }, { node: current, offset: offset + length })
      }
      offset += length
    }
    current = walker.nextNode() as Text | null
  }
  return { text, starts, ends }
}

function domRangeForSourceSpan(host: Element, sourceText: string, span: SourceSpan): Range | null {
  const index = normalizedTextIndex(host)
  if (index.text !== normalizeText(sourceText) || span.start < 0 || span.end > index.text.length) {
    return null
  }
  const start = index.starts[span.start]
  const end = index.ends[span.end - 1]
  if (!start || !end) return null
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  return range
}

function numericStyle(value: string): number {
  const number = Number.parseFloat(value)
  return Number.isFinite(number) ? number : 0
}

/** Handles target-word hit testing and source highlighting without mutating source text nodes. */
export class PageAlignmentController {
  private entries = new WeakMap<Element, AlignmentEntry>()
  private readonly translator = new BrowserTranslator()
  private overlay: HTMLDivElement | null = null
  private overlayHost: Element | null = null
  private overlayWords = new Map<number, HTMLSpanElement>()
  private hovered: { host: Element; wordIndex: number } | null = null
  private highlightedHost: Element | null = null
  private alignmentTimer = 0
  private active = false

  activate(): void {
    if (this.active) return
    this.active = true
    document.addEventListener('pointermove', this.onPointerMove, true)
    window.addEventListener('scroll', this.onViewportChange, true)
    window.addEventListener('resize', this.onViewportChange)
  }

  deactivate(): void {
    this.active = false
    document.removeEventListener('pointermove', this.onPointerMove, true)
    window.removeEventListener('scroll', this.onViewportChange, true)
    window.removeEventListener('resize', this.onViewportChange)
    this.clearInteraction()
    this.entries = new WeakMap<Element, AlignmentEntry>()
  }

  register(
    host: Element,
    sourceText: string,
    translation: string,
    sourceLanguage: string,
    targetLanguage: string,
    isUi: boolean,
  ): void {
    const segments = segmentDisplayText(translation, targetLanguage)
    this.entries.set(host, {
      host,
      sourceText,
      translation,
      sourceLanguage,
      targetLanguage,
      isUi,
      segments,
      wordCount: segments.filter((segment) => segment.wordIndex !== null).length,
      alignments: new Map(),
    })
  }

  unregister(host: Element): void {
    this.entries.delete(host)
    if (this.overlayHost === host || this.highlightedHost === host) this.clearInteraction()
  }

  private readonly onViewportChange = () => this.clearInteraction()

  private readonly onPointerMove = (event: PointerEvent): void => {
    const origin = event.composedPath().find((item): item is Element => item instanceof Element)
    const host = origin?.closest(TRANSLATED_SELECTOR) ?? null
    const entry = host ? this.entries.get(host) : undefined
    if (!host || !entry || entry.isUi || !host.isConnected) {
      this.clearInteraction()
      return
    }

    const sourceBottom = this.sourceContentBottom(host)
    const pseudoStyle = window.getComputedStyle(host, '::after')
    const translationTop = sourceBottom + numericStyle(pseudoStyle.marginTop)
    if (event.clientY < translationTop) {
      this.clearInteraction()
      return
    }

    this.ensureOverlay(entry, translationTop, pseudoStyle)
    const overlayRect = this.overlay?.getBoundingClientRect()
    if (
      !overlayRect ||
      event.clientX < overlayRect.left ||
      event.clientX > overlayRect.right ||
      event.clientY < overlayRect.top ||
      event.clientY > overlayRect.bottom
    ) {
      this.clearInteraction()
      return
    }

    const segment = this.segmentAtPoint(event.clientX, event.clientY, entry)
    if (segment?.wordIndex === null || segment === undefined) {
      window.clearTimeout(this.alignmentTimer)
      this.clearHighlight()
      this.hovered = null
      return
    }
    if (this.hovered?.host === host && this.hovered.wordIndex === segment.wordIndex) return

    this.hovered = { host, wordIndex: segment.wordIndex }
    const fallback = findApproximateSourceSpan(
      entry.sourceText,
      '',
      segment.wordIndex,
      entry.wordCount,
      entry.sourceLanguage,
    )
    if (fallback) this.highlight(entry, fallback)

    window.clearTimeout(this.alignmentTimer)
    const cached = entry.alignments.get(segment.wordIndex)
    if (cached) {
      this.applyAlignmentWhenCurrent(cached, host, segment.wordIndex, entry)
      return
    }
    this.alignmentTimer = window.setTimeout(() => {
      if (this.hovered?.host !== host || this.hovered.wordIndex !== segment.wordIndex) return
      const alignment = this.alignSegment(entry, segment)
      entry.alignments.set(segment.wordIndex!, alignment)
      this.applyAlignmentWhenCurrent(alignment, host, segment.wordIndex!, entry)
    }, 160)
  }

  private applyAlignmentWhenCurrent(
    alignment: Promise<SourceSpan | null>,
    host: Element,
    wordIndex: number,
    entry: AlignmentEntry,
  ): void {
    void alignment.then((span) => {
      if (
        !span ||
        !this.active ||
        this.hovered?.host !== host ||
        this.hovered.wordIndex !== wordIndex
      ) {
        return
      }
      this.highlight(entry, span)
    })
  }

  private alignSegment(entry: AlignmentEntry, segment: DisplaySegment): Promise<SourceSpan | null> {
    const fallback = findApproximateSourceSpan(
      entry.sourceText,
      '',
      segment.wordIndex ?? 0,
      entry.wordCount,
      entry.sourceLanguage,
    )
    if (!this.translator.isSupported()) return Promise.resolve(fallback)
    return this.translator
      .translate(segment.text, entry.targetLanguage, entry.sourceLanguage)
      .then((backTranslation) =>
        findApproximateSourceSpan(
          entry.sourceText,
          backTranslation ?? '',
          segment.wordIndex ?? 0,
          entry.wordCount,
          entry.sourceLanguage,
        ),
      )
  }

  private ensureOverlay(
    entry: AlignmentEntry,
    top: number,
    pseudoStyle: CSSStyleDeclaration,
  ): void {
    if (!this.overlay) {
      this.overlay = document.createElement('div')
      this.overlay.id = OVERLAY_ID
      this.overlay.setAttribute('data-lens-ignore', '')
      document.documentElement.append(this.overlay)
    }
    if (this.overlayHost !== entry.host) {
      this.overlay.replaceChildren()
      this.overlayWords.clear()
      for (const segment of entry.segments) {
        if (segment.wordIndex === null) {
          this.overlay.append(document.createTextNode(segment.text))
          continue
        }
        const span = document.createElement('span')
        span.textContent = segment.text
        this.overlayWords.set(segment.wordIndex, span)
        this.overlay.append(span)
      }
      this.overlayHost = entry.host
    }

    const hostRect = entry.host.getBoundingClientRect()
    const hostStyle = window.getComputedStyle(entry.host)
    const left = hostRect.left + numericStyle(hostStyle.borderLeftWidth) + numericStyle(hostStyle.paddingLeft)
    const width = Math.max(
      1,
      hostRect.width -
        numericStyle(hostStyle.borderLeftWidth) -
        numericStyle(hostStyle.borderRightWidth) -
        numericStyle(hostStyle.paddingLeft) -
        numericStyle(hostStyle.paddingRight),
    )
    const style = this.overlay.style
    style.all = 'initial'
    style.position = 'fixed'
    style.zIndex = '2147483646'
    style.pointerEvents = 'none'
    style.boxSizing = 'border-box'
    style.left = `${left}px`
    style.top = `${top}px`
    style.width = `${width}px`
    style.margin = '0'
    style.padding = pseudoStyle.padding
    style.border = '0'
    style.background = 'transparent'
    style.color = 'transparent'
    style.fontFamily = pseudoStyle.fontFamily
    style.fontSize = pseudoStyle.fontSize
    style.fontStyle = pseudoStyle.fontStyle
    style.fontWeight = pseudoStyle.fontWeight
    style.lineHeight = pseudoStyle.lineHeight
    style.letterSpacing = pseudoStyle.letterSpacing
    style.wordSpacing = pseudoStyle.wordSpacing
    style.textAlign = pseudoStyle.textAlign
    style.whiteSpace = pseudoStyle.whiteSpace
    style.overflowWrap = pseudoStyle.overflowWrap
    style.direction = pseudoStyle.direction
  }

  private sourceContentBottom(host: Element): number {
    const range = document.createRange()
    range.selectNodeContents(host)
    const rects = [...range.getClientRects()]
    range.detach()
    return rects.reduce((bottom, rect) => Math.max(bottom, rect.bottom), host.getBoundingClientRect().top)
  }

  private segmentAtPoint(x: number, y: number, entry: AlignmentEntry): DisplaySegment | undefined {
    for (const segment of entry.segments) {
      if (segment.wordIndex === null) continue
      const span = this.overlayWords.get(segment.wordIndex)
      if (!span) continue
      for (const rect of span.getClientRects()) {
        if (x >= rect.left - 1 && x <= rect.right + 1 && y >= rect.top && y <= rect.bottom) {
          return segment
        }
      }
    }
    return undefined
  }

  private highlight(entry: AlignmentEntry, span: SourceSpan): void {
    const range = domRangeForSourceSpan(entry.host, entry.sourceText, span)
    if (!range) return
    this.clearHighlight()
    const registry = (globalThis.CSS as typeof CSS & { highlights?: HighlightRegistryLike })
      ?.highlights
    const HighlightConstructor = (globalThis as HighlightGlobal).Highlight
    if (registry && HighlightConstructor) {
      registry.set(PAGE_ALIGNMENT_HIGHLIGHT_NAME, new HighlightConstructor(range))
    } else {
      entry.host.setAttribute(PAGE_ALIGNMENT_FALLBACK_ATTR, '')
    }
    this.highlightedHost = entry.host
  }

  private clearHighlight(): void {
    const registry = (globalThis.CSS as typeof CSS & { highlights?: HighlightRegistryLike })
      ?.highlights
    registry?.delete(PAGE_ALIGNMENT_HIGHLIGHT_NAME)
    this.highlightedHost?.removeAttribute(PAGE_ALIGNMENT_FALLBACK_ATTR)
    this.highlightedHost = null
  }

  private clearInteraction(): void {
    window.clearTimeout(this.alignmentTimer)
    this.clearHighlight()
    this.hovered = null
    this.overlay?.remove()
    this.overlay = null
    this.overlayHost = null
    this.overlayWords.clear()
  }
}
