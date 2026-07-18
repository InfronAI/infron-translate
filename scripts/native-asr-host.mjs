#!/usr/bin/env node
import { startAsrRelay } from './asr-relay-server.mjs'

let relayPromise = null

process.stdin.on('readable', () => {
  for (;;) {
    const header = process.stdin.read(4)
    if (!header) return
    const length = header.readUInt32LE(0)
    const body = process.stdin.read(length)
    if (!body) return
    void handleMessage(parseMessage(body))
  }
})

process.stdin.on('end', () => {
  process.exit(0)
})

async function handleMessage(message) {
  if (!message || message.type !== 'start-asr-relay') {
    writeMessage({ type: 'asr-relay-result', ok: false, error: 'Unsupported native host message' })
    return
  }

  try {
    relayPromise ??= startAsrRelay()
    const relay = await relayPromise
    writeMessage({
      type: 'asr-relay-result',
      ok: true,
      endpoint: relay.endpoint,
      alreadyRunning: relay.alreadyRunning,
    })
  } catch (error) {
    relayPromise = null
    writeMessage({
      type: 'asr-relay-result',
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function parseMessage(body) {
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
}

function writeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  process.stdout.write(header)
  process.stdout.write(body)
}
