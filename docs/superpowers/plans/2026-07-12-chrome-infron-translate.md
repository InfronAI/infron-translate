# Chrome Infron Translate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome MV3 extension that keeps pages in English by default, auto-pretranslates visible text blocks via an OpenAI-compatible API (JSON Schema batch), and shows Chinese only inside a hold-to-show rectangular lens anchored to the block under the cursor.

**Architecture:** Content script extracts visible text blocks into a registry, asks the background service worker to translate batches, stores `id → translation` in memory. Holding `Alt+Shift+L` (configurable) shows a Shadow DOM rectangular lens with the current block’s Chinese; releasing hides it. API keys never leave the background worker.

**Tech Stack:** TypeScript, Vite, `@crxjs/vite-plugin`, Vitest, Chrome Extension Manifest V3 APIs (`chrome.storage`, `chrome.runtime`, content scripts).

**Spec:** `docs/superpowers/specs/2026-07-12-chrome-infron-translate-design.md`

---

## File structure (create)

```
chrome-trans/
  package.json
  tsconfig.json
  tsconfig.node.json
  vite.config.ts
  vitest.config.ts
  manifest.config.ts          # CRX manifest source
  index.html                  # unused root; crx uses multi-page
  src/
    shared/
      settings.ts             # UserSettings type, defaults, load/save helpers (pure + chrome wrappers split)
      settings-defaults.ts    # pure defaults (unit-testable)
      messages.ts             # message protocol types + type guards
      schema.ts               # translate batch request/response types + JSON schema object + parse/validate
      text.ts                 # normalizeText, min length filter
      block-id.ts             # stable block id hash
      batch.ts                # split blocks by char/count limits
      hotkey.ts               # match keydown against configured hotkey
    background/
      index.ts                # service worker entry: message router
      openai.ts               # OpenAI-compatible chat completions client
      translate.ts            # batch translate orchestration + retries + session cache
    content/
      index.ts                # content entry: wire extract, registry, lens, hotkey, scroll
      extract.ts              # DOM → TextBlockCandidate[]
      registry.ts             # BlockRegistry + TranslationMap + status
      lens.ts                 # Shadow DOM rectangular lens UI
      page-key.ts             # pageKey from location
      pause.ts                # check hostname paused list
    options/
      index.html
      main.ts
      style.css
    popup/
      index.html
      main.ts
      style.css
  tests/
    shared/
      text.test.ts
      block-id.test.ts
      batch.test.ts
      schema.test.ts
      hotkey.test.ts
      settings-defaults.test.ts
    background/
      openai.test.ts
      translate.test.ts
  README.md
```

---

### Task 1: Scaffold MV3 + Vite + Vitest

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `vite.config.ts`, `vitest.config.ts`, `manifest.config.ts`, `src/background/index.ts`, `src/content/index.ts`, `src/options/index.html`, `src/options/main.ts`, `src/popup/index.html`, `src/popup/main.ts`, `README.md` (stub)

- [ ] **Step 1: Initialize package.json and install deps**

```bash
cd /Users/zach/AiProject/chrome-trans
npm init -y
npm install -D vite @crxjs/vite-plugin@beta typescript vitest @types/chrome @types/node
```

Use `@crxjs/vite-plugin` major version compatible with Vite 5/6 at install time; if peer deps conflict, pin `vite@5` and matching crx plugin.

- [ ] **Step 2: Write TypeScript configs**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "lib": ["ES2022", "DOM"],
    "types": ["chrome", "node"],
    "noEmit": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "esModuleInterop": true
  },
  "include": ["src", "tests", "manifest.config.ts", "vite.config.ts", "vitest.config.ts"]
}
```

`tsconfig.node.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["vite.config.ts", "vitest.config.ts", "manifest.config.ts"]
}
```

- [ ] **Step 3: Write manifest + Vite + Vitest configs**

`manifest.config.ts`:
```ts
import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Infron Translate',
  description: 'Hold a hotkey to peek Chinese translations without leaving English immersion.',
  version: '0.1.0',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Infron Translate',
  },
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage'],
  host_permissions: ['http://*/*', 'https://*/*'],
})
```

Note: MVP uses broad host permissions for simpler auto-pretranslate; document in README. Optional permissions can be a later hardening task (spec allowed either).

`vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    sourcemap: true,
  },
})
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Stub entries**

`src/background/index.ts`:
```ts
chrome.runtime.onInstalled.addListener(() => {
  console.log('Infron Translate installed')
})
```

`src/content/index.ts`:
```ts
console.log('Infron Translate content script loaded')
```

`src/options/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>Infron Translate Options</title>
  </head>
  <body>
    <h1>Infron Translate</h1>
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`src/options/main.ts`:
```ts
const app = document.getElementById('app')
if (app) app.textContent = 'Options placeholder'
```

`src/popup/index.html` + `main.ts`: similar stub with “Popup placeholder”.

`package.json` scripts:
```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 5: Verify build and tests harness**

```bash
npm test
npm run build
```

Expected: tests pass (0 tests ok) or “no tests”; build emits `dist/` with manifest.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.node.json vite.config.ts vitest.config.ts manifest.config.ts src README.md
git commit -m "chore: scaffold MV3 extension with Vite and Vitest"
```

---

### Task 2: Settings defaults (pure)

**Files:**
- Create: `src/shared/settings-defaults.ts`, `tests/shared/settings-defaults.test.ts`

- [ ] **Step 1: Write failing tests**

`tests/shared/settings-defaults.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/settings-defaults'

describe('DEFAULT_SETTINGS', () => {
  it('defaults to en→zh with autoTranslate on', () => {
    expect(DEFAULT_SETTINGS.sourceLang).toBe('en')
    expect(DEFAULT_SETTINGS.targetLang).toBe('zh')
    expect(DEFAULT_SETTINGS.autoTranslate).toBe(true)
    expect(DEFAULT_SETTINGS.lensWidthPx).toBe(320)
    expect(DEFAULT_SETTINGS.minTextLength).toBe(10)
    expect(DEFAULT_SETTINGS.batchCharLimit).toBe(6000)
    expect(DEFAULT_SETTINGS.hotkey).toEqual({
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      code: 'KeyL',
    })
    expect(DEFAULT_SETTINGS.pausedHostnames).toEqual([])
  })
})

describe('mergeSettings', () => {
  it('fills missing fields from defaults', () => {
    const merged = mergeSettings({ apiKey: 'sk-test' })
    expect(merged.apiKey).toBe('sk-test')
    expect(merged.autoTranslate).toBe(true)
    expect(merged.model).toBe(DEFAULT_SETTINGS.model)
  })

  it('preserves pausedHostnames when provided', () => {
    const merged = mergeSettings({ pausedHostnames: ['example.com'] })
    expect(merged.pausedHostnames).toEqual(['example.com'])
  })
})
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
npm test -- tests/shared/settings-defaults.test.ts
```

Expected: cannot find module / exports.

- [ ] **Step 3: Implement**

`src/shared/settings-defaults.ts`:
```ts
export type HotkeyConfig = {
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  code: string // KeyboardEvent.code, e.g. 'KeyL'
}

export type UserSettings = {
  baseURL: string
  apiKey: string
  model: string
  sourceLang: string
  targetLang: string
  autoTranslate: boolean
  lensWidthPx: number
  minTextLength: number
  batchCharLimit: number
  prefetchMarginRatio: number // 0.5 = half viewport
  hotkey: HotkeyConfig
  pausedHostnames: string[]
}

export const DEFAULT_SETTINGS: UserSettings = {
  baseURL: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  sourceLang: 'en',
  targetLang: 'zh',
  autoTranslate: true,
  lensWidthPx: 320,
  minTextLength: 10,
  batchCharLimit: 6000,
  prefetchMarginRatio: 0.5,
  hotkey: {
    altKey: true,
    shiftKey: true,
    ctrlKey: false,
    metaKey: false,
    code: 'KeyL',
  },
  pausedHostnames: [],
}

export function mergeSettings(partial: Partial<UserSettings> | null | undefined): UserSettings {
  const p = partial ?? {}
  return {
    ...DEFAULT_SETTINGS,
    ...p,
    hotkey: { ...DEFAULT_SETTINGS.hotkey, ...(p.hotkey ?? {}) },
    pausedHostnames: p.pausedHostnames ?? DEFAULT_SETTINGS.pausedHostnames,
  }
}

export function isConfigured(settings: UserSettings): boolean {
  return Boolean(settings.baseURL.trim() && settings.apiKey.trim() && settings.model.trim())
}
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npm test -- tests/shared/settings-defaults.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/shared/settings-defaults.ts tests/shared/settings-defaults.test.ts
git commit -m "feat: add user settings defaults and merge helper"
```

---

### Task 3: Chrome settings storage wrapper

**Files:**
- Create: `src/shared/settings.ts`

- [ ] **Step 1: Implement storage helpers** (chrome API — covered by manual test later; keep thin)

```ts
import { DEFAULT_SETTINGS, mergeSettings, type UserSettings } from './settings-defaults'

const STORAGE_KEY = 'settings'

export async function loadSettings(): Promise<UserSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY)
  return mergeSettings(result[STORAGE_KEY] as Partial<UserSettings> | undefined)
}

export async function saveSettings(settings: UserSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

export { DEFAULT_SETTINGS, mergeSettings, isConfigured } from './settings-defaults'
export type { UserSettings, HotkeyConfig } from './settings-defaults'
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/settings.ts
git commit -m "feat: add chrome.storage settings load/save"
```

---

### Task 4: Text helpers + block id

**Files:**
- Create: `src/shared/text.ts`, `src/shared/block-id.ts`, `tests/shared/text.test.ts`, `tests/shared/block-id.test.ts`

- [ ] **Step 1: Failing tests for text**

`tests/shared/text.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { normalizeText, isTranslatableText } from '../../src/shared/text'

describe('normalizeText', () => {
  it('collapses whitespace', () => {
    expect(normalizeText('  hello   \n world  ')).toBe('hello world')
  })
})

describe('isTranslatableText', () => {
  it('rejects short text', () => {
    expect(isTranslatableText('hi', 10)).toBe(false)
  })
  it('rejects pure numbers/symbols', () => {
    expect(isTranslatableText('12345-67890', 5)).toBe(false)
    expect(isTranslatableText('!!!!!', 1)).toBe(false)
  })
  it('accepts normal sentences', () => {
    expect(isTranslatableText('Modern tools make immersion easier.', 10)).toBe(true)
  })
})
```

- [ ] **Step 2: Implement `src/shared/text.ts`**

```ts
export function normalizeText(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

export function isTranslatableText(text: string, minLength: number): boolean {
  const t = normalizeText(text)
  if (t.length < minLength) return false
  // Must contain at least one letter (any script)
  if (!/\p{L}/u.test(t)) return false
  // Reject if almost no letters vs length (pure punctuation/numbers)
  const letters = t.match(/\p{L}/gu)?.length ?? 0
  if (letters / t.length < 0.3) return false
  return true
}
```

- [ ] **Step 3: Failing tests for block-id**

`tests/shared/block-id.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { makeBlockId } from '../../src/shared/block-id'

describe('makeBlockId', () => {
  it('is stable for same inputs', () => {
    const a = makeBlockId('p', 'Hello world', '/body/div[1]/p[2]')
    const b = makeBlockId('p', 'Hello world', '/body/div[1]/p[2]')
    expect(a).toBe(b)
    expect(a.startsWith('b_')).toBe(true)
  })

  it('changes when text changes', () => {
    const a = makeBlockId('p', 'Hello', '/x')
    const b = makeBlockId('p', 'Hello!', '/x')
    expect(a).not.toBe(b)
  })

  it('normalizes text before hashing', () => {
    const a = makeBlockId('p', 'Hello   world', '/x')
    const b = makeBlockId('p', 'Hello world', '/x')
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 4: Implement `src/shared/block-id.ts`**

```ts
import { normalizeText } from './text'

/** FNV-1a 32-bit → base36, prefixed */
export function makeBlockId(tag: string, text: string, coarsePath: string): string {
  const payload = `${tag.toLowerCase()}|${normalizeText(text)}|${coarsePath}`
  let h = 0x811c9dc5
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `b_${(h >>> 0).toString(36)}`
}
```

- [ ] **Step 5: Run tests PASS + commit**

```bash
npm test -- tests/shared/text.test.ts tests/shared/block-id.test.ts
git add src/shared/text.ts src/shared/block-id.ts tests/shared/
git commit -m "feat: add text normalize and stable block ids"
```

---

### Task 5: Batch splitter + schema validate

**Files:**
- Create: `src/shared/batch.ts`, `src/shared/schema.ts`, `src/shared/messages.ts`, `tests/shared/batch.test.ts`, `tests/shared/schema.test.ts`

- [ ] **Step 1: Types + messages**

`src/shared/messages.ts`:
```ts
export type TranslateBlock = {
  id: string
  tag: string
  text: string
}

export type TranslateBatchRequestMsg = {
  type: 'translate-batch'
  pageKey: string
  blocks: TranslateBlock[]
}

export type TranslateBatchResultOk = {
  type: 'translate-batch-result'
  ok: true
  translations: { id: string; translation: string }[]
}

export type TranslateBatchResultErr = {
  type: 'translate-batch-result'
  ok: false
  error: string
  failedIds?: string[]
  /** Partial successes still applied by content script */
  translations?: { id: string; translation: string }[]
}

export type GetSettingsMsg = { type: 'get-settings' }
export type SettingsMsg = { type: 'settings'; settings: import('./settings-defaults').UserSettings }

export type PauseHostnameMsg = {
  type: 'set-hostname-paused'
  hostname: string
  paused: boolean
}

export type ToBackground = TranslateBatchRequestMsg | GetSettingsMsg | PauseHostnameMsg
export type FromBackground = TranslateBatchResultOk | TranslateBatchResultErr | SettingsMsg
```

- [ ] **Step 2: Batch tests + impl**

`tests/shared/batch.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { splitIntoBatches } from '../../src/shared/batch'
import type { TranslateBlock } from '../../src/shared/messages'

function block(id: string, text: string): TranslateBlock {
  return { id, tag: 'p', text }
}

describe('splitIntoBatches', () => {
  it('keeps small lists in one batch', () => {
    const blocks = [block('a', 'hello world'), block('b', 'another line here')]
    expect(splitIntoBatches(blocks, 6000, 40)).toHaveLength(1)
  })

  it('splits when char limit exceeded', () => {
    const blocks = [
      block('a', 'a'.repeat(100)),
      block('b', 'b'.repeat(100)),
      block('c', 'c'.repeat(100)),
    ]
    const batches = splitIntoBatches(blocks, 150, 40)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat().map((b) => b.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('splits when max blocks exceeded', () => {
    const blocks = Array.from({ length: 5 }, (_, i) => block(String(i), `text ${i} long enough`))
    const batches = splitIntoBatches(blocks, 100000, 2)
    expect(batches).toHaveLength(3)
  })
})
```

`src/shared/batch.ts`:
```ts
import type { TranslateBlock } from './messages'

export function splitIntoBatches(
  blocks: TranslateBlock[],
  charLimit: number,
  maxBlocks: number,
): TranslateBlock[][] {
  const batches: TranslateBlock[][] = []
  let current: TranslateBlock[] = []
  let chars = 0

  for (const b of blocks) {
    const len = b.text.length
    const wouldExceed =
      current.length > 0 &&
      (current.length >= maxBlocks || chars + len > charLimit)

    if (wouldExceed) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(b)
    chars += len
  }
  if (current.length) batches.push(current)
  return batches
}
```

- [ ] **Step 3: Schema validate tests + impl**

`src/shared/schema.ts`:
```ts
import type { TranslateBlock } from './messages'

export const TRANSLATE_BATCH_JSON_SCHEMA = {
  name: 'translate_batch_result',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'translation'],
          properties: {
            id: { type: 'string' },
            translation: { type: 'string' },
          },
        },
      },
    },
  },
} as const

export type TranslateBatchResult = {
  items: { id: string; translation: string }[]
}

export function parseTranslateBatchResult(
  raw: unknown,
  allowedIds: Set<string>,
): { ok: true; items: { id: string; translation: string }[] } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not an object' }
  const items = (raw as { items?: unknown }).items
  if (!Array.isArray(items)) return { ok: false, error: 'items missing' }

  const out: { id: string; translation: string }[] = []
  for (const row of items) {
    if (!row || typeof row !== 'object') continue
    const id = (row as { id?: unknown }).id
    const translation = (row as { translation?: unknown }).translation
    if (typeof id !== 'string' || typeof translation !== 'string') continue
    if (!allowedIds.has(id)) continue
    out.push({ id, translation })
  }
  return { ok: true, items: out }
}

export function buildTranslateUserPrompt(
  sourceLang: string,
  targetLang: string,
  blocks: TranslateBlock[],
): string {
  return [
    `Translate each block from ${sourceLang} to ${targetLang}.`,
    'Return ONLY JSON matching the schema: { "items": [{ "id", "translation" }] }.',
    'Keep meaning faithful. No explanations.',
    'Blocks:',
    JSON.stringify(blocks),
  ].join('\n')
}
```

`tests/shared/schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseTranslateBatchResult } from '../../src/shared/schema'

describe('parseTranslateBatchResult', () => {
  it('keeps only allowed ids', () => {
    const parsed = parseTranslateBatchResult(
      {
        items: [
          { id: 'a', translation: '甲' },
          { id: 'evil', translation: 'x' },
          { id: 'b', translation: '乙' },
        ],
      },
      new Set(['a', 'b']),
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.items).toEqual([
        { id: 'a', translation: '甲' },
        { id: 'b', translation: '乙' },
      ])
    }
  })

  it('fails when items missing', () => {
    const parsed = parseTranslateBatchResult({}, new Set())
    expect(parsed.ok).toBe(false)
  })
})
```

- [ ] **Step 4: Run tests + commit**

```bash
npm test
git add src/shared tests/shared
git commit -m "feat: add batch split, messages, and schema validation"
```

---

### Task 6: Hotkey matcher

**Files:**
- Create: `src/shared/hotkey.ts`, `tests/shared/hotkey.test.ts`

- [ ] **Step 1: Tests + impl**

```ts
// tests/shared/hotkey.test.ts
import { describe, it, expect } from 'vitest'
import { matchesHotkey } from '../../src/shared/hotkey'
import { DEFAULT_SETTINGS } from '../../src/shared/settings-defaults'

describe('matchesHotkey', () => {
  const hk = DEFAULT_SETTINGS.hotkey

  it('matches Alt+Shift+L', () => {
    expect(
      matchesHotkey(
        { code: 'KeyL', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false },
        hk,
      ),
    ).toBe(true)
  })

  it('rejects wrong key', () => {
    expect(
      matchesHotkey(
        { code: 'KeyK', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false },
        hk,
      ),
    ).toBe(false)
  })

  it('rejects missing modifier', () => {
    expect(
      matchesHotkey(
        { code: 'KeyL', altKey: false, shiftKey: true, ctrlKey: false, metaKey: false },
        hk,
      ),
    ).toBe(false)
  })
})
```

```ts
// src/shared/hotkey.ts
import type { HotkeyConfig } from './settings-defaults'

export type KeyLike = {
  code: string
  altKey: boolean
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

export function matchesHotkey(e: KeyLike, hotkey: HotkeyConfig): boolean {
  return (
    e.code === hotkey.code &&
    e.altKey === hotkey.altKey &&
    e.shiftKey === hotkey.shiftKey &&
    e.ctrlKey === hotkey.ctrlKey &&
    e.metaKey === hotkey.metaKey
  )
}
```

- [ ] **Step 2: Commit**

```bash
npm test -- tests/shared/hotkey.test.ts
git add src/shared/hotkey.ts tests/shared/hotkey.test.ts
git commit -m "feat: add hotkey matcher for hold-to-lens"
```

---

### Task 7: OpenAI-compatible client

**Files:**
- Create: `src/background/openai.ts`, `tests/background/openai.test.ts`

- [ ] **Step 1: Failing tests with mock fetch**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chatCompletionsJson } from '../../src/background/openai'

describe('chatCompletionsJson', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  items: [{ id: 'a', translation: '你好' }],
                }),
              },
            },
          ],
        }),
      }),
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('POSTs to baseURL/chat/completions with Authorization', async () => {
    const result = await chatCompletionsJson({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'sk-x',
      model: 'gpt-test',
      systemPrompt: 'sys',
      userPrompt: 'user',
      useJsonSchema: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.content).toContain('你好')
    }
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-x')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('gpt-test')
    expect(body.response_format.type).toBe('json_schema')
  })

  it('returns error on non-OK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'unauthorized',
      }),
    )
    const result = await chatCompletionsJson({
      baseURL: 'https://api.example.com/v1',
      apiKey: 'bad',
      model: 'm',
      systemPrompt: 's',
      userPrompt: 'u',
      useJsonSchema: false,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/401/)
  })
})
```

- [ ] **Step 2: Implement client**

```ts
// src/background/openai.ts
import { TRANSLATE_BATCH_JSON_SCHEMA } from '../shared/schema'

export type ChatJsonParams = {
  baseURL: string
  apiKey: string
  model: string
  systemPrompt: string
  userPrompt: string
  useJsonSchema: boolean
}

export type ChatJsonResult =
  | { ok: true; content: string }
  | { ok: false; error: string; status?: number }

function joinUrl(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}

export async function chatCompletionsJson(params: ChatJsonParams): Promise<ChatJsonResult> {
  const url = joinUrl(params.baseURL, '/chat/completions')
  const body: Record<string, unknown> = {
    model: params.model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userPrompt },
    ],
  }
  if (params.useJsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: TRANSLATE_BATCH_JSON_SCHEMA,
    }
  } else {
    body.response_format = { type: 'json_object' }
  }

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify(body),
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}`, status: res.status }
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) return { ok: false, error: 'empty completion content' }
  return { ok: true, content }
}
```

- [ ] **Step 3: Tests PASS + commit**

```bash
npm test -- tests/background/openai.test.ts
git add src/background/openai.ts tests/background/openai.test.ts
git commit -m "feat: add OpenAI-compatible chat completions client"
```

---

### Task 8: Translate orchestration + session cache

**Files:**
- Create: `src/background/translate.ts`, `tests/background/translate.test.ts`
- Modify: `src/background/index.ts`

- [ ] **Step 1: Implement `translateBatches` pure-ish orchestration**

```ts
// src/background/translate.ts
import { splitIntoBatches } from '../shared/batch'
import {
  buildTranslateUserPrompt,
  parseTranslateBatchResult,
} from '../shared/schema'
import type { TranslateBlock } from '../shared/messages'
import type { UserSettings } from '../shared/settings-defaults'
import { chatCompletionsJson } from './openai'

const SYSTEM = 'You are a precise translation engine. Output JSON only.'

export type TranslateAllResult =
  | { ok: true; translations: { id: string; translation: string }[] }
  | { ok: false; error: string; translations: { id: string; translation: string }[]; failedIds: string[] }

export async function translateAllBlocks(
  blocks: TranslateBlock[],
  settings: UserSettings,
  opts?: { useJsonSchema?: boolean; sleep?: (ms: number) => Promise<void> },
): Promise<TranslateAllResult> {
  const useJsonSchema = opts?.useJsonSchema ?? true
  const sleep = opts?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const batches = splitIntoBatches(blocks, settings.batchCharLimit, 40)
  const translations: { id: string; translation: string }[] = []
  const failedIds: string[] = []

  for (const batch of batches) {
    const allowed = new Set(batch.map((b) => b.id))
    let attempt = 0
    let batchOk = false
    let lastError = 'unknown'

    while (attempt < 3 && !batchOk) {
      attempt++
      const userPrompt = buildTranslateUserPrompt(
        settings.sourceLang,
        settings.targetLang,
        batch,
      )
      let result = await chatCompletionsJson({
        baseURL: settings.baseURL,
        apiKey: settings.apiKey,
        model: settings.model,
        systemPrompt: SYSTEM,
        userPrompt,
        useJsonSchema,
      })

      // one fallback without json_schema if format rejected
      if (!result.ok && result.status === 400 && useJsonSchema && attempt === 1) {
        result = await chatCompletionsJson({
          baseURL: settings.baseURL,
          apiKey: settings.apiKey,
          model: settings.model,
          systemPrompt: SYSTEM,
          userPrompt,
          useJsonSchema: false,
        })
      }

      if (!result.ok) {
        lastError = result.error
        if (result.status === 401 || result.status === 403) {
          return {
            ok: false,
            error: lastError,
            translations,
            failedIds: blocks.map((b) => b.id),
          }
        }
        if (result.status === 429 || (result.status && result.status >= 500)) {
          await sleep(200 * attempt)
          continue
        }
        break
      }

      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(result.content)
      } catch {
        lastError = 'invalid JSON from model'
        continue
      }
      const parsed = parseTranslateBatchResult(parsedJson, allowed)
      if (!parsed.ok) {
        lastError = parsed.error
        continue
      }
      translations.push(...parsed.items)
      const got = new Set(parsed.items.map((i) => i.id))
      for (const b of batch) {
        if (!got.has(b.id)) failedIds.push(b.id)
      }
      batchOk = true
    }

    if (!batchOk) {
      for (const b of batch) failedIds.push(b.id)
      return { ok: false, error: lastError, translations, failedIds: [...new Set(failedIds)] }
    }
  }

  return failedIds.length
    ? { ok: false, error: 'partial failure', translations, failedIds: [...new Set(failedIds)] }
    : { ok: true, translations }
}

// session cache helpers
type CacheStore = Map<string, Map<string, string>> // pageKey -> id -> translation

const memoryCache: CacheStore = new Map()

export function getCached(pageKey: string, id: string): string | undefined {
  return memoryCache.get(pageKey)?.get(id)
}

export function putCached(
  pageKey: string,
  items: { id: string; translation: string }[],
): void {
  let m = memoryCache.get(pageKey)
  if (!m) {
    m = new Map()
    memoryCache.set(pageKey, m)
  }
  for (const it of items) m.set(it.id, it.translation)
}

export function filterUncached(
  pageKey: string,
  blocks: TranslateBlock[],
): { cached: { id: string; translation: string }[]; missing: TranslateBlock[] } {
  const cached: { id: string; translation: string }[] = []
  const missing: TranslateBlock[] = []
  for (const b of blocks) {
    const hit = getCached(pageKey, b.id)
    if (hit !== undefined) cached.push({ id: b.id, translation: hit })
    else missing.push(b)
  }
  return { cached, missing }
}
```

- [ ] **Step 2: Unit test filterUncached + split path with mocked chat** (optional minimal)

```ts
// tests/background/translate.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { filterUncached, putCached, getCached } from '../../src/background/translate'

describe('session cache', () => {
  const pageKey = 'https://example.com/'

  beforeEach(() => {
    // re-importing module state: put only for this pageKey unique ids
    putCached(pageKey, [{ id: 'x1', translation: '缓存' }])
  })

  it('returns cached and missing', () => {
    const { cached, missing } = filterUncached(pageKey, [
      { id: 'x1', tag: 'p', text: 'Hello there friend' },
      { id: 'x2', tag: 'p', text: 'Another block text' },
    ])
    expect(cached).toEqual([{ id: 'x1', translation: '缓存' }])
    expect(missing.map((m) => m.id)).toEqual(['x2'])
    expect(getCached(pageKey, 'x1')).toBe('缓存')
  })
})
```

- [ ] **Step 3: Wire background message router**

`src/background/index.ts`:
```ts
import { loadSettings, saveSettings, isConfigured } from '../shared/settings'
import type { ToBackground } from '../shared/messages'
import {
  filterUncached,
  putCached,
  translateAllBlocks,
} from './translate'

chrome.runtime.onMessage.addListener((message: ToBackground, _sender, sendResponse) => {
  void handle(message).then(sendResponse)
  return true // async
})

async function handle(message: ToBackground) {
  if (message.type === 'get-settings') {
    const settings = await loadSettings()
    return { type: 'settings', settings }
  }

  if (message.type === 'set-hostname-paused') {
    const settings = await loadSettings()
    const set = new Set(settings.pausedHostnames)
    if (message.paused) set.add(message.hostname)
    else set.delete(message.hostname)
    const next = { ...settings, pausedHostnames: [...set] }
    await saveSettings(next)
    return { type: 'settings', settings: next }
  }

  if (message.type === 'translate-batch') {
    const settings = await loadSettings()
    if (!isConfigured(settings)) {
      return {
        type: 'translate-batch-result',
        ok: false,
        error: 'API not configured',
        failedIds: message.blocks.map((b) => b.id),
      }
    }
    const { cached, missing } = filterUncached(message.pageKey, message.blocks)
    if (missing.length === 0) {
      return { type: 'translate-batch-result', ok: true, translations: cached }
    }
    const result = await translateAllBlocks(missing, settings)
    if (result.translations.length) putCached(message.pageKey, result.translations)
    const translations = [...cached, ...result.translations]
    if (result.ok) {
      return { type: 'translate-batch-result', ok: true, translations }
    }
    return {
      type: 'translate-batch-result',
      ok: false,
      error: result.error,
      failedIds: result.failedIds,
      translations,
    }
  }

  return { type: 'translate-batch-result', ok: false, error: 'unknown message' }
}
```

**Type fix:** extend `TranslateBatchResultErr` in `messages.ts` to optional `translations?: { id: string; translation: string }[]` and return partial translations on failure so the lens can show what succeeded.

- [ ] **Step 4: Tests + commit**

```bash
npm test
git add src/background src/shared/messages.ts tests/background
git commit -m "feat: batch translate orchestration and message router"
```

---

### Task 9: Block registry

**Files:**
- Create: `src/content/registry.ts`, `tests` optional (registry is simple — implement carefully)

- [ ] **Step 1: Implement registry**

```ts
// src/content/registry.ts
export type BlockStatus = 'pending' | 'ready' | 'error' | 'empty'

export type RegistryEntry = {
  id: string
  el: Element
  tag: string
  text: string
  status: BlockStatus
  translation?: string
  error?: string
}

export class BlockRegistry {
  private byId = new Map<string, RegistryEntry>()
  private byEl = new WeakMap<Element, string>()

  upsert(entry: Omit<RegistryEntry, 'status' | 'translation' | 'error'> & { status?: BlockStatus }): RegistryEntry {
    const existing = this.byId.get(entry.id)
    const next: RegistryEntry = {
      id: entry.id,
      el: entry.el,
      tag: entry.tag,
      text: entry.text,
      status: entry.status ?? existing?.status ?? 'pending',
      translation: existing?.translation,
      error: existing?.error,
    }
    if (existing && existing.text === next.text && existing.translation) {
      next.translation = existing.translation
      next.status = 'ready'
    }
    this.byId.set(next.id, next)
    this.byEl.set(next.el, next.id)
    return next
  }

  setTranslation(id: string, translation: string): void {
    const e = this.byId.get(id)
    if (!e) return
    e.translation = translation
    e.status = 'ready'
    e.error = undefined
  }

  setError(id: string, error: string): void {
    const e = this.byId.get(id)
    if (!e) return
    e.status = 'error'
    e.error = error
  }

  setPending(id: string): void {
    const e = this.byId.get(id)
    if (!e) return
    if (e.status !== 'ready') e.status = 'pending'
  }

  get(id: string): RegistryEntry | undefined {
    return this.byId.get(id)
  }

  getByElement(el: Element | null): RegistryEntry | undefined {
    if (!el) return undefined
    let cur: Element | null = el
    while (cur) {
      const id = this.byEl.get(cur)
      if (id) return this.byId.get(id)
      cur = cur.parentElement
    }
    return undefined
  }

  pendingBlocks(): { id: string; tag: string; text: string }[] {
    return [...this.byId.values()]
      .filter((e) => e.status === 'pending')
      .map((e) => ({ id: e.id, tag: e.tag, text: e.text }))
  }

  all(): RegistryEntry[] {
    return [...this.byId.values()]
  }
}
```

Simplify `pendingBlocks` in actual code to only `status === 'pending'`.

- [ ] **Step 2: Commit**

```bash
git add src/content/registry.ts
git commit -m "feat: add content script block registry"
```

---

### Task 10: DOM extract + pageKey + pause check

**Files:**
- Create: `src/content/extract.ts`, `src/content/page-key.ts`, `src/content/pause.ts`

- [ ] **Step 1: pageKey + pause**

```ts
// src/content/page-key.ts
export function makePageKey(loc: Location = location): string {
  return `${loc.origin}${loc.pathname}`
}

// src/content/pause.ts
export function isHostnamePaused(hostname: string, paused: string[]): boolean {
  return paused.includes(hostname)
}
```

- [ ] **Step 2: extract.ts**

```ts
import { makeBlockId } from '../shared/block-id'
import { isTranslatableText, normalizeText } from '../shared/text'

const BLOCK_SELECTOR = [
  'p',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li',
  'blockquote',
  'figcaption',
  'td', 'th',
  'dt', 'dd',
  'summary',
].join(',')

const SKIP_CLOSEST = 'nav, script, style, noscript, code, pre, textarea, input, [contenteditable="true"], [aria-hidden="true"]'

export type ExtractedBlock = {
  id: string
  el: Element
  tag: string
  text: string
}

function coarsePath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  let depth = 0
  while (cur && depth < 6) {
    const parent: Element | null = cur.parentElement
    let idx = 0
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === cur!.tagName)
      idx = Math.max(0, siblings.indexOf(cur))
    }
    parts.push(`${cur.tagName.toLowerCase()}[${idx}]`)
    cur = parent
    depth++
  }
  return '/' + parts.reverse().join('/')
}

function isVisible(el: Element, margin: number): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width < 2 || rect.height < 2) return false
  const vh = window.innerHeight
  const vw = window.innerWidth
  if (rect.bottom < -margin || rect.top > vh + margin) return false
  if (rect.right < 0 || rect.left > vw) return false
  const style = window.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false
  }
  return true
}

export function extractVisibleBlocks(minTextLength: number, prefetchMarginPx: number): ExtractedBlock[] {
  const nodes = document.querySelectorAll(BLOCK_SELECTOR)
  const out: ExtractedBlock[] = []
  const seen = new Set<string>()

  for (const el of nodes) {
    if (el.closest(SKIP_CLOSEST)) continue
    if (el.closest('#infron-translate-root')) continue
    if (!isVisible(el, prefetchMarginPx)) continue

    const text = normalizeText(el.textContent ?? '')
    if (!isTranslatableText(text, minTextLength)) continue

    // Prefer leaf-ish blocks: skip if contains another block selector child with substantial text
    const nested = el.querySelector(BLOCK_SELECTOR)
    if (nested && nested !== el) {
      const nestedText = normalizeText(nested.textContent ?? '')
      if (nestedText.length >= minTextLength && nestedText.length > text.length * 0.5) {
        // still allow headers etc.; only skip if this is a container of many blocks
        const childBlocks = el.querySelectorAll(BLOCK_SELECTOR)
        if (childBlocks.length > 1) continue
      }
    }

    const tag = el.tagName.toLowerCase()
    const id = makeBlockId(tag, text, coarsePath(el))
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, el, tag, text })
  }
  return out
}
```

- [ ] **Step 3: Commit**

```bash
git add src/content/extract.ts src/content/page-key.ts src/content/pause.ts
git commit -m "feat: extract visible text blocks from the page"
```

---

### Task 11: Rectangular lens UI

**Files:**
- Create: `src/content/lens.ts`

- [ ] **Step 1: Implement Shadow DOM lens**

```ts
// src/content/lens.ts
export type LensViewState =
  | { kind: 'hidden' }
  | { kind: 'ready'; text: string }
  | { kind: 'pending' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'unconfigured' }

export class LensOverlay {
  private host: HTMLDivElement
  private root: ShadowRoot
  private panel: HTMLDivElement
  private label: HTMLDivElement
  private body: HTMLDivElement
  private highlightEl: Element | null = null
  private widthPx: number

  constructor(widthPx = 320) {
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
    style.textContent = `
      .panel {
        position: fixed;
        max-width: ${this.widthPx}px;
        width: ${this.widthPx}px;
        max-height: 240px;
        overflow: auto;
        box-sizing: border-box;
        padding: 10px 12px;
        border-radius: 10px;
        border: 2px solid #38bdf8;
        background: rgba(15, 23, 42, 0.94);
        color: #e0f2fe;
        font: 13px/1.45 system-ui, -apple-system, sans-serif;
        box-shadow: 0 12px 40px rgba(0,0,0,.45);
        display: none;
      }
      .label {
        font-size: 10px;
        letter-spacing: 0.04em;
        color: #38bdf8;
        margin-bottom: 6px;
      }
      .body { white-space: pre-wrap; word-break: break-word; }
      .muted { color: #94a3b8; }
    `
    this.panel = document.createElement('div')
    this.panel.className = 'panel'
    this.label = document.createElement('div')
    this.label.className = 'label'
    this.label.textContent = 'LENS · ZH'
    this.body = document.createElement('div')
    this.body.className = 'body'
    this.panel.append(this.label, this.body)
    this.root.append(style, this.panel)
  }

  mount(): void {
    if (!this.host.isConnected) document.documentElement.appendChild(this.host)
  }

  unmount(): void {
    this.clearHighlight()
    this.host.remove()
  }

  setWidth(widthPx: number): void {
    this.widthPx = widthPx
    this.panel.style.width = `${widthPx}px`
    this.panel.style.maxWidth = `${widthPx}px`
  }

  showAt(clientX: number, clientY: number, state: Exclude<LensViewState, { kind: 'hidden' }>): void {
    this.mount()
    this.panel.style.display = 'block'
    this.body.classList.remove('muted')

    switch (state.kind) {
      case 'ready':
        this.body.textContent = state.text
        break
      case 'pending':
        this.body.classList.add('muted')
        this.body.textContent = '翻译中…'
        break
      case 'empty':
        this.body.classList.add('muted')
        this.body.textContent = '此处无可译文本'
        break
      case 'error':
        this.body.classList.add('muted')
        this.body.textContent = state.message
        break
      case 'unconfigured':
        this.body.classList.add('muted')
        this.body.textContent = '请先配置 API'
        break
    }

    const offset = 16
    const rect = this.panel.getBoundingClientRect()
    let left = clientX + offset
    let top = clientY + offset
    const vw = window.innerWidth
    const vh = window.innerHeight
    if (left + rect.width > vw - 8) left = clientX - rect.width - offset
    if (top + rect.height > vh - 8) top = clientY - rect.height - offset
    left = Math.max(8, left)
    top = Math.max(8, top)
    this.panel.style.left = `${left}px`
    this.panel.style.top = `${top}px`
  }

  hide(): void {
    this.panel.style.display = 'none'
    this.clearHighlight()
  }

  getHost(): HTMLDivElement {
    return this.host
  }

  highlight(el: Element | null): void {
    if (this.highlightEl === el) return
    this.clearHighlight()
    this.highlightEl = el
    if (el instanceof HTMLElement) {
      el.dataset.lensHl = '1'
      el.style.outline = '2px solid #38bdf8'
      el.style.outlineOffset = '2px'
    }
  }

  private clearHighlight(): void {
    if (this.highlightEl instanceof HTMLElement) {
      elClear(this.highlightEl)
    }
    this.highlightEl = null
  }
}

function elClear(el: HTMLElement): void {
  el.style.outline = ''
  el.style.outlineOffset = ''
  delete el.dataset.lensHl
}
```

Important: **never use innerHTML for translations** — only `textContent`.

- [ ] **Step 2: Commit**

```bash
git add src/content/lens.ts
git commit -m "feat: add rectangular Shadow DOM lens overlay"
```

---

### Task 12: Content script main loop

**Files:**
- Modify: `src/content/index.ts`

- [ ] **Step 1: Wire everything**

```ts
// src/content/index.ts
import { matchesHotkey } from '../shared/hotkey'
import type { UserSettings } from '../shared/settings-defaults'
import { DEFAULT_SETTINGS } from '../shared/settings-defaults'
import type { TranslateBatchResultErr, TranslateBatchResultOk } from '../shared/messages'
import { extractVisibleBlocks } from './extract'
import { BlockRegistry } from './registry'
import { LensOverlay } from './lens'
import { makePageKey } from './page-key'
import { isHostnamePaused } from './pause'

const registry = new BlockRegistry()
const lens = new LensOverlay()
let settings: UserSettings = DEFAULT_SETTINGS
let lensActive = false
let lastMouse = { x: 0, y: 0 }
let translating = false

async function refreshSettings(): Promise<void> {
  const res = await chrome.runtime.sendMessage({ type: 'get-settings' })
  if (res?.type === 'settings') {
    settings = res.settings
    lens.setWidth(settings.lensWidthPx)
  }
}

function disabledHere(): boolean {
  return isHostnamePaused(location.hostname, settings.pausedHostnames)
}

async function scanAndTranslate(): Promise<void> {
  if (disabledHere() || !settings.autoTranslate) return
  const margin = Math.round(window.innerHeight * settings.prefetchMarginRatio)
  const blocks = extractVisibleBlocks(settings.minTextLength, margin)
  for (const b of blocks) {
    registry.upsert({ id: b.id, el: b.el, tag: b.tag, text: b.text })
  }
  const pending = registry.pendingBlocks()
  if (!pending.length || translating) return
  translating = true
  try {
    const res = (await chrome.runtime.sendMessage({
      type: 'translate-batch',
      pageKey: makePageKey(),
      blocks: pending,
    })) as TranslateBatchResultOk | TranslateBatchResultErr

    const list =
      res && 'translations' in res && Array.isArray((res as TranslateBatchResultOk).translations)
        ? (res as TranslateBatchResultOk).translations
        : (res as TranslateBatchResultErr & { translations?: { id: string; translation: string }[] })
            .translations ?? []

    for (const t of list) registry.setTranslation(t.id, t.translation)
    if (res && res.ok === false) {
      for (const id of res.failedIds ?? pending.map((p) => p.id)) {
        if (!registry.get(id)?.translation) registry.setError(id, res.error)
      }
    }
  } finally {
    translating = false
  }
  if (lensActive) updateLens()
}

function updateLens(): void {
  if (!lensActive) {
    lens.hide()
    return
  }
  // Host uses pointer-events: none; still filter it out of the hit stack
  const host = lens.getHost()
  const stack = document
    .elementsFromPoint(lastMouse.x, lastMouse.y)
    .filter((el) => el !== host && !host.contains(el))
  const hit = stack[0] ?? null
  const entry = registry.getByElement(hit)

  if (!settings.apiKey?.trim() || !settings.model?.trim() || !settings.baseURL?.trim()) {
    lens.showAt(lastMouse.x, lastMouse.y, { kind: 'unconfigured' })
    lens.highlight(null)
    return
  }

  if (!entry) {
    lens.showAt(lastMouse.x, lastMouse.y, { kind: 'empty' })
    lens.highlight(null)
    return
  }

  lens.highlight(entry.el)
  if (entry.status === 'ready' && entry.translation) {
    lens.showAt(lastMouse.x, lastMouse.y, { kind: 'ready', text: entry.translation })
  } else if (entry.status === 'error') {
    lens.showAt(lastMouse.x, lastMouse.y, {
      kind: 'error',
      message: entry.error ?? '翻译失败',
    })
  } else {
    lens.showAt(lastMouse.x, lastMouse.y, { kind: 'pending' })
    void scanAndTranslate()
  }
}

function onKeyDown(e: KeyboardEvent): void {
  if (disabledHere()) return
  if (!matchesHotkey(e, settings.hotkey)) return
  e.preventDefault()
  if (!lensActive) {
    lensActive = true
    updateLens()
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (!lensActive) return
  // Release when any part of the chord is released
  if (
    e.code === settings.hotkey.code ||
    (settings.hotkey.altKey && e.key === 'Alt') ||
    (settings.hotkey.shiftKey && e.key === 'Shift') ||
    (settings.hotkey.ctrlKey && e.key === 'Control') ||
    (settings.hotkey.metaKey && e.key === 'Meta')
  ) {
    lensActive = false
    lens.hide()
  }
}

function onBlur(): void {
  lensActive = false
  lens.hide()
}

function onMouseMove(e: MouseEvent): void {
  lastMouse = { x: e.clientX, y: e.clientY }
  if (lensActive) updateLens()
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T {
  let t = 0
  return ((...args: unknown[]) => {
    window.clearTimeout(t)
    t = window.setTimeout(() => fn(...args), ms)
  }) as T
}

async function main(): Promise<void> {
  await refreshSettings()
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) void refreshSettings()
  })

  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)
  window.addEventListener('mousemove', onMouseMove, true)

  const scheduleScan = debounce(() => void scanAndTranslate(), 300)
  window.addEventListener('scroll', scheduleScan, true)
  window.addEventListener('resize', scheduleScan)

  const mo = new MutationObserver(debounce(() => void scanAndTranslate(), 500))
  mo.observe(document.documentElement, { childList: true, subtree: true })

  void scanAndTranslate()
}

void main()
```

- [ ] **Step 2: Build + manual load**

```bash
npm run build
```

Load `dist` in `chrome://extensions` → Developer mode → Load unpacked.

- [ ] **Step 3: Commit**

```bash
git add src/content
git commit -m "feat: wire content script scan, translate, and hold-to-lens"
```

---

### Task 13: Options page UI

**Files:**
- Modify: `src/options/index.html`, `src/options/main.ts`
- Create: `src/options/style.css`

- [ ] **Step 1: Form fields bound to settings**

Fields: baseURL, apiKey (password), model, sourceLang, targetLang, autoTranslate checkbox, lensWidthPx, hotkey display + simple editors (code select KeyL / Alt / Shift checkboxes), pausedHostnames as comma-separated list.

On save: `saveSettings` via background or direct `chrome.storage.local` (options page may call `saveSettings` from `shared/settings.ts` directly).

```ts
// src/options/main.ts (structure)
import { loadSettings, saveSettings, DEFAULT_SETTINGS, type UserSettings } from '../shared/settings'

async function init() {
  const s = await loadSettings()
  // fill inputs...
  document.getElementById('save')!.addEventListener('click', async () => {
    const next: UserSettings = { /* read form */ }
    await saveSettings(next)
    // show "已保存"
  })
  document.getElementById('reset')!.addEventListener('click', async () => {
    await saveSettings(DEFAULT_SETTINGS)
    location.reload()
  })
}
void init()
```

Include short help text: 按住 Alt+Shift+L 显示矩形透镜；松开消失；不会改页面英文。

- [ ] **Step 2: Commit**

```bash
git add src/options
git commit -m "feat: options page for API and lens settings"
```

---

### Task 14: Popup — pause this site + open options

**Files:**
- Modify: `src/popup/index.html`, `src/popup/main.ts`
- Create: `src/popup/style.css`

- [ ] **Step 1: Implement popup**

- Show current tab hostname
- Toggle “暂停此站”
- Button “打开设置”
- Status: configured? autoTranslate?

```ts
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
const hostname = tab?.url ? new URL(tab.url).hostname : ''
// send set-hostname-paused
// chrome.runtime.openOptionsPage()
```

- [ ] **Step 2: Commit**

```bash
git add src/popup
git commit -m "feat: popup to pause site and open options"
```

---

### Task 15: README + manual QA checklist

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Write README**

Contents:
1. What it does (immersion + rectangular hold lens)
2. Install: `npm install && npm run build` → Load unpacked `dist`
3. Configure OpenAI-compatible baseURL / key / model
4. Usage: hold Alt+Shift+L
5. Privacy: key local; traffic only to user endpoint
6. Dev: `npm run dev`, `npm test`
7. Manual QA checklist (below)

**Manual QA checklist (copy into README):**

- [ ] Options save persists after reload
- [ ] Wrong API key shows error in lens (not blank forever)
- [ ] English article: visible paragraphs pretranslate; hold lens shows Chinese for hovered block
- [ ] Release hotkey: lens and outline gone; page text still English
- [ ] Scroll: new paragraphs eventually translate
- [ ] Pause site: no requests / lens respects pause
- [ ] Unconfigured: lens says 请先配置 API

- [ ] **Step 2: Final test + build**

```bash
npm test
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README and manual QA for infron translate"
```

---

## Self-review vs spec

| Spec requirement | Task |
|------------------|------|
| Default English, no body replace | Task 11–12 (lens only) |
| Hold hotkey rectangular lens | Task 6, 11, 12 |
| Auto pretranslate visible | Task 10, 12 |
| OpenAI-compatible config | Task 2–3, 7, 13 |
| JSON Schema batch DOM blocks | Task 5, 7–8 |
| Key only in background | Task 7–8 |
| Scroll / MutationObserver incremental | Task 12 |
| Pause hostname | Task 8, 14 |
| Session cache | Task 8 |
| textContent XSS-safe | Task 11 |
| Error handling 401/429/JSON | Task 8 |
| Unit tests pure helpers | Tasks 2, 4–7 |

**Out of scope (spec non-goals):** pixel dual-layer, multi-provider SDK, vocab book, iframe internals — not planned.

**Intentionally simplified vs spec:** broad `host_permissions` instead of optional permissions for MVP (documented in Task 1 + README); can harden later.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-12-chrome-infron-translate.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration  
2. **Inline Execution** — execute tasks in this session with checkpoints  

Which approach?
