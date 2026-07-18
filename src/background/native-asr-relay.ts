const NATIVE_HOST_NAME = 'ai.infron.translate.asr_relay'
const NATIVE_START_TIMEOUT_MS = 5_000

let relayPort: chrome.runtime.Port | null = null
let startPromise: Promise<void> | null = null

type NativeAsrRelayResult = {
  type?: unknown
  ok?: unknown
  error?: unknown
}

export async function ensureNativeAsrRelayStarted(): Promise<void> {
  if (startPromise) return startPromise
  startPromise = startNativeAsrRelay()
  try {
    await startPromise
  } finally {
    startPromise = null
  }
}

function startNativeAsrRelay(): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let port: chrome.runtime.Port

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    } catch (error) {
      reject(nativeHostError(error))
      return
    }

    relayPort = port
    let timeout: ReturnType<typeof setTimeout> | null = null

    const finish = (ok: boolean, error?: Error) => {
      if (settled) return
      settled = true
      if (timeout) globalThis.clearTimeout(timeout)
      port.onMessage.removeListener(onMessage)
      port.onDisconnect.removeListener(onDisconnect)
      if (ok) resolve()
      else reject(error ?? new Error('Native ASR relay host failed to start.'))
    }

    const onMessage = (message: unknown) => {
      const result = isRecord(message) ? (message as NativeAsrRelayResult) : {}
      if (result.type !== 'asr-relay-result') return
      if (result.ok === true) {
        finish(true)
        return
      }
      finish(false, new Error(stringValue(result.error) || 'Native ASR relay host failed to start.'))
    }

    const onDisconnect = () => {
      const message = chrome.runtime.lastError?.message
      relayPort = relayPort === port ? null : relayPort
      finish(false, new Error(nativeHostInstallMessage(message)))
    }

    port.onMessage.addListener(onMessage)
    port.onDisconnect.addListener(onDisconnect)
    port.postMessage({ type: 'start-asr-relay' })
    timeout = globalThis.setTimeout(() => {
      finish(false, new Error('Native ASR relay host did not respond in time.'))
      port.disconnect()
    }, NATIVE_START_TIMEOUT_MS)
  })
}

function nativeHostError(error: unknown): Error {
  return new Error(nativeHostInstallMessage(error instanceof Error ? error.message : String(error)))
}

function nativeHostInstallMessage(detail = ''): string {
  const suffix = detail ? ` Detail: ${detail}` : ''
  return `Native ASR relay host is not installed or cannot be started. Install it once with: EXTENSION_ID=${chrome.runtime.id} npm run native:install.${suffix}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
