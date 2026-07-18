import { makeBlockId } from '../shared/block-id'
import { isTranslatableText, normalizeText } from '../shared/text'

export const PAGE_SOURCE_ATTR = 'data-infron-translate-source'

/**
 * Primary block-level candidates: HTML semantics + common rich-text / markdown hosts.
 * Markdown renderers (GitHub, CommonMark, MDX, VuePress, Docusaurus, etc.) emit these tags.
 */
const SEMANTIC_TAGS = [
  // Core prose
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'blockquote',
  'figcaption',
  'caption',
  'td',
  'th',
  'dt',
  'dd',
  'summary',
  'label',
  'legend',
  'address',
  // Less common but real content
  'article',
  // Note: section/main/aside are often huge wrappers — handled via leaf heuristics
] as const

/** Role-based content (ARIA / virtualized UIs). */
const ROLE_SELECTORS = [
  '[role="heading"]',
  '[role="listitem"]',
  '[role="paragraph"]',
  '[role="article"]',
  '[role="text"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="button"]',
  '[role="link"]',
]

/** Short UI labels (tabs, menu items) use a lower min length. */
export const UI_LABEL_MIN_LENGTH = 2

/**
 * Host surfaces that usually contain markdown / rich HTML.
 * We still extract child semantic nodes; these help when prose is plain divs.
 */
const RICH_HOST_SELECTORS = [
  '.markdown-body',
  '.markdown-content',
  '.markdown',
  '.md-content',
  '.md-typeset', // Material / MkDocs
  '.prose', // Tailwind Typography
  '.Post-body',
  '.post-content',
  '.entry-content',
  '.article-content',
  '.article-body',
  '.post-body',
  '.rich-text',
  '.RichText',
  '.notion-page-content',
  '[data-testid="post_message"]', // Slack-like
  '.message-body',
  '.comment-body',
  '.js-comment-body',
  '.wiki-body',
  '.doc-content',
  '.docs-content',
  '.content__default', // VuePress
  '.theme-default-content',
  '.vp-doc', // VitePress
  '.mdx-content',
  '[class*="Markdown"]',
  '[class*="markdown"]',
  '[class*="ProseMirror"]',
  '[class*="DraftEditor"]',
  '[class*="ql-editor"]', // Quill
  '[class*="tiptap"]',
  '[class*="slate-"]',
  '[data-slate-editor]',
]

/**
 * Class / attribute hints that a div/section is a *leaf-ish* text block
 * (Notion, Medium, Linear, Coda, custom CMS, etc.).
 */
const TEXT_BLOCK_HINT_RE =
  /(?:^|[\s_-])(?:paragraph|text-block|textblock|richtext|rich-text|post-body|postbody|entry-content|article-body|md-p|md-block|markdown-p|block-paragraph|block-text|notion-text|notion-page-block|pw-post-body|reader-word|transcript|caption-text|message-text|comment-text|answer-text|question-title|issue-body)(?:$|[\s_-])/i

const DATA_BLOCK_HINT_RE = /paragraph|text|heading|list.?item|quote|callout|toggle|bulleted|numbered|to.?do/i

/** Inline / phrasing tags allowed inside leaf text containers. */
export const PHRASING_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'i',
  'kbd',
  'mark',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
  'svg',
  'img',
  'picture',
  'source',
  'font', // legacy mail HTML
  'strike',
  'big',
  'tt',
  'acronym',
  'del',
  'ins',
  'math', // keep as phrasing host; we may still skip pure math leaves later
  'mi',
  'mo',
  'mn',
  'mrow',
  'msup',
  'msub',
])

/**
 * Hard skip ancestors (noise chrome).
 * Intentionally NOT including button / tablist — tabs & labeled buttons are learnable UI text.
 */
const SKIP_CLOSEST =
  [
    'script',
    'style',
    'noscript',
    'template',
    'svg',
    'canvas',
    'video',
    'audio',
    'iframe',
    'object',
    'embed',
    'textarea',
    'input',
    'select',
    // keep option for <select> menus only via closest select above
    'nav',
    'pre', // fenced code / preformatted — usually not continuous reading target
    '[contenteditable]:not([contenteditable="false"])',
    '[role="textbox"]',
    // Rich-text editor placeholders (Draft.js/ProseMirror/etc.) sit *beside* the
    // editable node, so the contenteditable skip above misses them. They vanish the
    // moment the user types, so translating them only leaves stray, misaligned text.
    '[class*="DraftEditorPlaceholder"]',
    '[class*="EditorPlaceholder"]',
    '[class*="editor-placeholder"]',
    '[aria-hidden="true"]',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="search"]',
    '[role="toolbar"]',
    // Transient overlays positioned over other content; an injected ::after here
    // lands on top of whatever the tooltip points at (e.g. GitHub's <tool-tip>).
    '[role="tooltip"]',
    'tool-tip',
    '[data-infron-ignore]',
    '[data-infron-page-translation]',
    '#infron-translate-root',
  ].join(', ')

const SKIP_SELF_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'canvas',
  'video',
  'audio',
  'iframe',
  'object',
  'embed',
  'textarea',
  'input',
  'select',
  'option',
  'nav',
  'pre',
  'code', // bare code element (inline is still readable via parent p)
  'br',
  'hr',
  'img',
  'path',
  'meta',
  'link',
  'head',
  'html',
  'body',
])

export type ExtractedBlock = {
  id: string
  el: Element
  tag: string
  text: string
}

export function coarsePath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  let depth = 0
  while (cur && depth < 8) {
    const parent: Element | null = cur.parentElement
    let idx = 0
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === cur!.tagName)
      idx = Math.max(0, siblings.indexOf(cur))
    }
    const name = cur.tagName.toLowerCase()
    parts.push(`${name}[${idx}]`)
    cur = parent
    depth++
  }
  return '/' + parts.reverse().join('/')
}

export function isVisible(el: Element, margin: number): boolean {
  const rect = el.getBoundingClientRect()
  if (!isRendered(el, rect)) return false
  const vh = window.innerHeight
  const vw = window.innerWidth
  if (rect.bottom < -margin || rect.top > vh + margin) return false
  if (rect.right < 0 || rect.left > vw) return false
  return true
}

function isRendered(el: Element, rect = el.getBoundingClientRect()): boolean {
  if (rect.width < 2 || rect.height < 2) return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false
  }
  return true
}

/** Subtrees whose text must never be translated even when nested inside a content block. */
const NON_CONTENT_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template'])

/**
 * Element text excluding embedded non-rendered content.
 *
 * `Element.textContent` concatenates the text of <script>/<style>/<template>/<noscript>
 * descendants. Many sites embed machine-readable JSON next to visible UI (e.g. GitHub puts
 * subscription props in a <script type="application/json"> beside the "Watch" button). That
 * leaked JSON otherwise reaches the model and comes back as garbled translation, so we walk
 * text nodes and skip those subtrees.
 */
export function elementText(el: Element): string {
  if (
    typeof el.querySelector !== 'function' ||
    typeof document === 'undefined' ||
    typeof document.createTreeWalker !== 'function' ||
    !el.querySelector('script, style, noscript, template')
  ) {
    return el.textContent ?? ''
  }
  const walker = document.createTreeWalker(el, 4 /* SHOW_TEXT */, {
    acceptNode(node) {
      let ancestor = node.parentElement
      while (ancestor && ancestor !== el) {
        if (NON_CONTENT_TEXT_TAGS.has(ancestor.tagName.toLowerCase())) {
          return 2 // FILTER_REJECT
        }
        ancestor = ancestor.parentElement
      }
      return 1 // FILTER_ACCEPT
    },
  })
  let text = ''
  let node = walker.nextNode()
  while (node) {
    text += node.nodeValue ?? ''
    node = walker.nextNode()
  }
  return text
}

function sourceTextOf(el: Element): string {
  const stored = el.getAttribute(PAGE_SOURCE_ATTR)
  return normalizeText(stored ?? elementText(el))
}

export function isPhrasingOnly(el: Element): boolean {
  for (const child of el.children) {
    const t = child.tagName.toLowerCase()
    // Custom elements used as inline wrappers (rare) — treat as non-phrasing
    if (t.includes('-')) return false
    if (!PHRASING_TAGS.has(t)) return false
    if (
      t !== 'br' &&
      t !== 'img' &&
      t !== 'source' &&
      t !== 'wbr' &&
      t !== 'path' &&
      !isPhrasingOnly(child)
    ) {
      return false
    }
  }
  return true
}

export function classNameOf(el: Element): string {
  if (typeof el.className === 'string') return el.className
  // SVGAnimatedString etc.
  const attr = el.getAttribute('class')
  return attr ?? ''
}

export function hasTextBlockHint(el: Element): boolean {
  const cls = classNameOf(el)
  if (TEXT_BLOCK_HINT_RE.test(cls)) return true
  const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || ''
  if (TEXT_BLOCK_HINT_RE.test(testId)) return true
  const blockType =
    el.getAttribute('data-block-type') ||
    el.getAttribute('data-type') ||
    el.getAttribute('data-slate-type') ||
    el.getAttribute('data-text-type') ||
    ''
  if (blockType && DATA_BLOCK_HINT_RE.test(blockType)) return true
  const role = el.getAttribute('role') || ''
  if (role === 'heading' || role === 'listitem' || role === 'paragraph' || role === 'text') {
    return true
  }
  return false
}

function isCustomElement(el: Element): boolean {
  return el.tagName.includes('-')
}

function childSemanticCount(el: Element): number {
  let n = 0
  for (const tag of SEMANTIC_TAGS) {
    n += el.querySelectorAll(tag).length
    if (n > 3) return n
  }
  for (const sel of ROLE_SELECTORS) {
    n += el.querySelectorAll(sel).length
    if (n > 3) return n
  }
  return n
}

function hasMultipleUiLabelDescendants(el: Element): boolean {
  return el.querySelectorAll(
    'a, button, [role="link"], [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"]',
  ).length > 1
}

/**
 * Tab labels, menu items, plain text buttons — short UI copy that learners may want.
 * e.g. POWERSHELL / CURL tabs on marketing pages.
 */
export function isUiLabelElement(el: Element): boolean {
  const role = (el.getAttribute('role') || '').toLowerCase()
  if (
    role === 'tab' ||
    role === 'menuitem' ||
    role === 'menuitemradio' ||
    role === 'option' ||
    role === 'button' ||
    role === 'link'
  ) {
    return true
  }
  const tag = el.tagName.toLowerCase()
  if (tag === 'button' || tag === 'summary') return true
  // Anchor used as tab/chip with short label
  if (tag === 'a') {
    const text = sourceTextOf(el)
    if (text.length > 0 && text.length <= 48 && (isPhrasingOnly(el) || el.children.length === 0)) {
      return true
    }
  }
  // Div/span chips inside a tablist
  if (
    el.closest('[role="tablist"]') &&
    (tag === 'div' || tag === 'span' || tag === 'li') &&
    (isPhrasingOnly(el) || el.children.length === 0)
  ) {
    const text = sourceTextOf(el)
    if (text.length > 0 && text.length <= 48) return true
  }
  return false
}

/**
 * Leaf-ish container: enough text, not a huge multi-block shell.
 * Used for div/span/section/article/custom elements + UI labels.
 */
export function isLeafTextContainer(el: Element, minTextLength: number): boolean {
  const tag = el.tagName.toLowerCase()
  const text = sourceTextOf(el)

  // UI labels (tabs, buttons): lower length threshold
  if (isUiLabelElement(el)) {
    const min = Math.min(UI_LABEL_MIN_LENGTH, minTextLength)
    return isTranslatableText(text, min) && text.length <= 80
  }

  if (SKIP_SELF_TAGS.has(tag)) return false

  if (!isTranslatableText(text, minTextLength)) return false

  // A wrapper around several links/buttons is a menu, not one reading unit.
  if (isPhrasingOnly(el)) return !hasMultipleUiLabelDescendants(el)

  // Hinted CMS / markdown leaf blocks may wrap a single inner structure
  if (hasTextBlockHint(el)) {
    const kids = childSemanticCount(el)
    // One heading/paragraph inside is OK; a whole article shell is not
    if (kids <= 2 && text.length <= 2000) return true
    if (kids === 0 && text.length >= minTextLength && text.length <= 1500) return true
  }

  // Custom elements that are small text hosts (e.g. <yt-formatted-string>, <markdown-text>)
  if (isCustomElement(el)) {
    const kids = childSemanticCount(el)
    if (kids === 0 && isPhrasingOnly(el)) return true
    if (kids <= 1 && text.length <= 1200 && text.length >= minTextLength) return true
  }

  return false
}

function shouldSkipAsNestedContainer(el: Element, minTextLength: number): boolean {
  // UI labels are always leaves
  if (isUiLabelElement(el)) return false
  // If this node contains multiple semantic blocks, prefer the children
  const count = childSemanticCount(el)
  if (count > 1) {
    const text = sourceTextOf(el)
    // Large wrappers (article, div.content) — skip as unit
    if (text.length > minTextLength * 2) return true
  }
  return false
}

function shouldSkipElement(el: Element): boolean {
  if (el.closest('#infron-translate-root')) return true
  if (
    !el.hasAttribute(PAGE_SOURCE_ATTR) &&
    el.querySelector('[data-infron-page-translation]')
  ) {
    return true
  }
  if (el.hasAttribute('hidden')) return true
  if (el.getAttribute('aria-hidden') === 'true') return true

  // Learnable UI labels: only skip true noise ancestors
  if (isUiLabelElement(el)) {
    if (el.closest('script, style, noscript, template, textarea, input, select, svg, canvas')) {
      return true
    }
    return false
  }

  if (el.closest(SKIP_CLOSEST)) return true
  const tag = el.tagName.toLowerCase()
  if (SKIP_SELF_TAGS.has(tag)) return true
  return false
}

function collectCandidates(root: ParentNode = document): Element[] {
  const list: Element[] = []
  const seen = new Set<Element>()

  const addAll = (nodes: NodeListOf<Element> | Element[]) => {
    for (const el of nodes) {
      if (!seen.has(el)) {
        seen.add(el)
        list.push(el)
      }
    }
  }

  // 1) Semantic HTML
  addAll(root.querySelectorAll(SEMANTIC_TAGS.join(',')))

  // 2) ARIA roles (incl. tabs / menuitems)
  addAll(root.querySelectorAll(ROLE_SELECTORS.join(',')))

  // 2b) Tab strips & plain buttons / chip links (POWERSHELL, CURL, …)
  addAll(root.querySelectorAll('button, [role="tablist"] button, [role="tablist"] a, [role="tablist"] [role="tab"]'))
  addAll(root.querySelectorAll('[role="tablist"] > *, [role="tablist"] [role="presentation"] > *'))

  // 2c) Plain navigation links often have no ARIA role and must stay row-level.
  addAll(root.querySelectorAll('a, [role="link"]'))

  // 3) Inside rich hosts: also grab direct leaf-ish children (div/span)
  for (const host of root.querySelectorAll(RICH_HOST_SELECTORS.join(','))) {
    addAll(host.querySelectorAll(SEMANTIC_TAGS.join(',')))
    addAll(host.querySelectorAll(':scope > div, :scope > span, :scope > section'))
    // Nested one level of div wrappers common in MDX
    addAll(host.querySelectorAll('div > p, div > li, div > h1, div > h2, div > h3, section > p'))
  }

  // 4) Hinted text blocks
  addAll(
    root.querySelectorAll(
      [
        '[data-block-type]',
        '[data-slate-type]',
        '[data-text-type]',
        '[class*="paragraph"]',
        '[class*="Paragraph"]',
        '[class*="text-block"]',
        '[class*="TextBlock"]',
        '[class*="notion-text"]',
        '[class*="markdown"] p',
        '[class*="Markdown"] p',
        '[class*="prose"] p',
        '[class*="prose"] li',
      ].join(','),
    ),
  )

  // 5) Generic leaves: div/span/section/article + custom elements (sampled via query)
  addAll(root.querySelectorAll('div, span, section, article, main'))
  // Custom elements require a full-tree query; this path is reserved for debounced auto scans.
  for (const el of root.querySelectorAll('*')) {
    if (el.tagName.includes('-') && !seen.has(el)) {
      seen.add(el)
      list.push(el)
    }
  }

  return list
}

function extractCandidate(
  el: Element,
  minTextLength: number,
  prefetchMarginPx: number | null,
): ExtractedBlock | undefined {
  if (
    shouldSkipElement(el) ||
    (prefetchMarginPx === null ? !isRendered(el) : !isVisible(el, prefetchMarginPx))
  ) {
    return undefined
  }

  const tag = el.tagName.toLowerCase()
  const isSemantic = (SEMANTIC_TAGS as readonly string[]).includes(tag)
  const role = el.getAttribute('role') || ''
  const isRoleBlock =
    role === 'heading' ||
    role === 'listitem' ||
    role === 'paragraph' ||
    role === 'text' ||
    role === 'tab' ||
    role === 'menuitem' ||
    role === 'button' ||
    role === 'link'
  const isUi = isUiLabelElement(el)
  const minLength = isUi ? Math.min(UI_LABEL_MIN_LENGTH, minTextLength) : minTextLength

  if (isUi) {
    if (!isLeafTextContainer(el, minTextLength)) return undefined
  } else if (isSemantic || isRoleBlock) {
    const text = sourceTextOf(el)
    if (!isTranslatableText(text, minLength)) return undefined
    if (shouldSkipAsNestedContainer(el, minTextLength)) return undefined
  } else if (!isLeafTextContainer(el, minTextLength)) {
    return undefined
  }

  const text = sourceTextOf(el)
  if (!isTranslatableText(text, minLength)) return undefined
  return { id: makeBlockId(tag, text, coarsePath(el)), el, tag, text }
}

/**
 * Resolve only the hit element and its ancestors. Pointer tracking must never
 * trigger the full-document candidate scan used by auto-translate.
 */
export function extractBlockAtElement(
  hit: Element | null,
  minTextLength: number,
): ExtractedBlock | undefined {
  let current = hit
  while (current && current.tagName.toLowerCase() !== 'html') {
    const block = extractCandidate(current, minTextLength, 0)
    if (block) return block
    current = current.parentElement
  }
  return undefined
}

export function extractVisibleBlocks(
  minTextLength: number,
  prefetchMarginPx: number,
): ExtractedBlock[] {
  return extractBlocks(document, minTextLength, prefetchMarginPx)
}

/** Extract all currently rendered DOM text blocks, including content below the viewport. */
export function extractPageBlocks(
  minTextLength: number,
  root: ParentNode = document,
): ExtractedBlock[] {
  const roots = collectPageRoots(root)
  const semanticBlocks = roots.flatMap((root) => extractBlocks(root, minTextLength, null))
  const coveredElements = new Set(semanticBlocks.map((block) => block.el))
  const fallbackBlocks = roots.flatMap((root) =>
    extractTextNodeFallbacks(root, minTextLength, coveredElements),
  )
  return [...semanticBlocks, ...fallbackBlocks]
}

/** Include open web-component roots; closed shadow roots are inaccessible by platform design. */
export function collectPageRoots(root: ParentNode = document): ParentNode[] {
  const roots: ParentNode[] = [root]
  if ('shadowRoot' in root && (root as Element).shadowRoot) {
    roots.push((root as Element).shadowRoot!)
  }
  for (let index = 0; index < roots.length; index++) {
    for (const el of roots[index].querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot)
    }
  }
  return roots
}

function fallbackHostForTextNode(node: Text): Element | null {
  const initialHost = node.parentElement
  if (!initialHost) return null
  let host: Element = initialHost

  while (PHRASING_TAGS.has(host.tagName.toLowerCase())) {
    const parent: Element | null = host.parentElement
    if (!parent || parent.tagName.toLowerCase() === 'body') break
    host = parent
  }
  const tag = host.tagName.toLowerCase()
  return tag === 'html' || tag === 'body' ? null : host
}

function hasCoveredAncestor(el: Element, coveredElements: Set<Element>): boolean {
  let current: Element | null = el
  while (current) {
    if (coveredElements.has(current)) return true
    current = current.parentElement
  }
  return false
}

/**
 * Fallback for deeply nested or framework-generated markup that has no semantic
 * block selectors. Text nodes are grouped at their nearest non-inline host.
 */
function extractTextNodeFallbacks(
  root: ParentNode,
  minTextLength: number,
  coveredElements: Set<Element>,
): ExtractedBlock[] {
  const textByHost = new Map<Element, string[]>()
  const walker = document.createTreeWalker(root, 4)
  let node = walker.nextNode()

  while (node) {
    const textNode = node as Text
    const text = normalizeText(textNode.data)
    const parent = textNode.parentElement
    if (text && parent && !hasCoveredAncestor(parent, coveredElements)) {
      const host = fallbackHostForTextNode(textNode)
      if (host && !shouldSkipElement(host)) {
        const parts = textByHost.get(host) ?? []
        parts.push(text)
        textByHost.set(host, parts)
      }
    }
    node = walker.nextNode()
  }

  const blocks: ExtractedBlock[] = []
  for (const [el, parts] of textByHost) {
    if (!isRendered(el)) continue
    const text = normalizeText(parts.join(' '))
    const min = isUiLabelElement(el) ? Math.min(UI_LABEL_MIN_LENGTH, minTextLength) : minTextLength
    if (!isTranslatableText(text, min)) continue
    const tag = el.tagName.toLowerCase()
    const block = { id: makeBlockId(tag, text, coarsePath(el)), el, tag, text }
    blocks.push(block)
    coveredElements.add(el)
  }
  return blocks
}

function extractBlocks(
  root: ParentNode,
  minTextLength: number,
  prefetchMarginPx: number | null,
): ExtractedBlock[] {
  const candidates = collectCandidates(root)
  const out: ExtractedBlock[] = []
  const seenIds = new Set<string>()
  const seenEls = new Set<Element>()

  for (const el of candidates) {
    if (seenEls.has(el)) continue
    const block = extractCandidate(el, minTextLength, prefetchMarginPx)
    if (!block || seenIds.has(block.id)) continue

    seenIds.add(block.id)
    seenEls.add(block.el)
    out.push(block)
  }

  // Drop parent blocks that fully contain a smaller registered child (same text prefix noise)
  return dedupeNestedBlocks(out)
}

/** Remove outer wrappers when a nested block already covers the same reading unit. */
export function dedupeNestedBlocks(blocks: ExtractedBlock[]): ExtractedBlock[] {
  if (blocks.length <= 1) return blocks
  const byElement = new Map(blocks.map((block) => [block.el, block]))
  const dominated = new Set<ExtractedBlock>()

  for (const child of blocks) {
    let ancestor = child.el.parentElement
    while (ancestor) {
      const parent = byElement.get(ancestor)
      if (
        parent &&
        child.text.length >= Math.min(parent.text.length * 0.5, parent.text.length - 1) &&
        (parent.text.length <= child.text.length + 40 ||
          parent.el.querySelectorAll('p,li,h1,h2,h3,h4,h5,h6').length >= 1)
      ) {
        dominated.add(parent)
        break
      }
      ancestor = ancestor.parentElement
    }
  }
  return blocks.filter((block) => !dominated.has(block))
}
