import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageController } from '../../src/content/page-controller'
import { DEFAULT_SETTINGS } from '../../src/shared/settings-defaults'

type RuntimeListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean

function stubDocument(): void {
  vi.stubGlobal('document', {
    documentElement: { lang: 'en' },
    querySelector: () => null,
    body: { innerText: 'This is a page written in English for translation.', textContent: '' },
  })
}

function stubChrome(settings = DEFAULT_SETTINGS, configured = false): {
  sendMessage: ReturnType<typeof vi.fn>
  runtimeListener: () => RuntimeListener
} {
  let listener: RuntimeListener | null = null
  const sendMessage = vi.fn(async (message: unknown) => {
    if (message && typeof message === 'object' && 'type' in message && message.type === 'get-settings') {
      return {
        type: 'settings',
        settings: { ...settings, apiKey: '' },
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
})
