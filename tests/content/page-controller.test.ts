import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageController } from '../../src/content/page-controller'
import { DEFAULT_SETTINGS } from '../../src/shared/settings-defaults'

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean

class MockElement {
  id = ''
  lang = ''
  innerText = ''
  textContent = ''
  type = ''
  title = ''
  disabled = false
  shadowRoot: MockElement | null = null
  dataset: Record<string, string> = {}
  children: MockElement[] = []
  attributes = new Map<string, string>()
  private listeners = new Map<string, () => void>()

  constructor(readonly tagName: string) {}

  get childElementCount(): number {
    return this.children.length
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
    if (name === 'id') this.id = value
  }

  attachShadow(): MockElement {
    this.shadowRoot = new MockElement('#shadow-root')
    return this.shadowRoot
  }

  append(...nodes: MockElement[]): void {
    this.children.push(...nodes)
  }

  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, listener)
  }

  click(): void {
    this.listeners.get('click')?.()
  }

  querySelector(selector: string): MockElement | null {
    const queue = [...this.children]
    while (queue.length) {
      const node = queue.shift()!
      if (selector === 'button' && node.tagName === 'button') return node
      if (selector === '.label' && node.attributes.has('class')) {
        if (node.attributes.get('class')?.split(/\s+/u).includes('label')) return node
      }
      queue.push(...node.children)
    }
    return null
  }

  set innerHTML(value: string) {
    this.children = []
    if (!value) return
    const dot = new MockElement('span')
    dot.setAttribute('class', 'dot')
    const label = new MockElement('span')
    label.setAttribute('class', 'label')
    this.append(dot, label)
  }
}

function stubDocument(): { elements: Map<string, MockElement> } {
  const elements = new Map<string, MockElement>()
  const documentElement = new MockElement('html')
  documentElement.lang = 'en'
  const body = new MockElement('body')
  body.innerText = 'This is a page written in English for translation.'
  documentElement.append(body)

  vi.stubGlobal('document', {
    documentElement,
    querySelector: () => null,
    body,
    createElement: (tagName: string) => new MockElement(tagName),
    getElementById: (id: string) => elements.get(id) ?? null,
  })
  const originalAppend = documentElement.append.bind(documentElement)
  documentElement.append = (...nodes: MockElement[]) => {
    for (const node of nodes) {
      if (node.id) elements.set(node.id, node)
    }
    originalAppend(...nodes)
  }
  return { elements }
}

function stubChrome(settings = DEFAULT_SETTINGS, configured = false): {
  sendMessage: ReturnType<typeof vi.fn>
  runtimeListener: () => RuntimeListener
} {
  let listener: RuntimeListener | null = null
  let storedSettings = settings
  const sendMessage = vi.fn(async (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'get-settings') {
      return {
        type: 'settings',
        settings: { ...storedSettings, apiKey: '' },
        paused: false,
        configured,
      }
    }
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'set-auto-page-translation' &&
      'enabled' in message &&
      typeof message.enabled === 'boolean'
    ) {
      storedSettings = { ...storedSettings, autoPageTranslation: message.enabled }
      return {
        type: 'settings',
        settings: { ...storedSettings, apiKey: '' },
        paused: false,
        configured,
      }
    }
    if (message && typeof message === 'object' && 'type' in message && message.type === 'open-options') {
      return { type: 'open-options-result', ok: true }
    }
    return undefined
  })
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension-id',
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      sendMessage,
      onMessage: {
        addListener: vi.fn((next: RuntimeListener) => {
          listener = next
        }),
      },
    },
    storage: {
      onChanged: {
        addListener: vi.fn(),
      },
    },
  })

  return {
    sendMessage,
    runtimeListener: () => {
      if (!listener) throw new Error('Runtime listener was not registered')
      return listener
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PageController', () => {
  it('opens the options page when manual cloud translation is unconfigured', async () => {
    stubDocument()
    const { sendMessage, runtimeListener } = stubChrome(
      {
        ...DEFAULT_SETTINGS,
        pageTranslationEngine: 'external',
      },
      false,
    )
    const controller = new PageController()
    controller.bindListeners()
    await controller.refreshSettings()

    let result: unknown
    runtimeListener()(
      { type: 'toggle-page-translation' },
      { id: 'extension-id' } as chrome.runtime.MessageSender,
      (response) => {
        result = response
      },
    )

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith({ type: 'open-options' }))
    expect(result).toEqual({ ok: false, error: 'Cloud AI model needs to be configured first' })
  })

  it('toggles auto page translation from the floating bubble', async () => {
    const { elements } = stubDocument()
    const { sendMessage } = stubChrome({ ...DEFAULT_SETTINGS, autoPageTranslation: false }, true)
    const controller = new PageController()
    controller.bindListeners()
    await controller.refreshSettings()

    const host = elements.get('infron-translate-auto-toggle')
    const button = host?.shadowRoot?.querySelector('button')

    expect(button?.dataset.enabled).toBe('false')
    button?.click()

    await vi.waitFor(() =>
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'set-auto-page-translation',
        enabled: true,
      }),
    )
    expect(button?.dataset.enabled).toBe('true')
    expect(button?.title).toBe('关闭自动翻译')
  })
})
