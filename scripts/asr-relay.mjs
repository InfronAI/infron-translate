import { startAsrRelay } from './asr-relay-server.mjs'

try {
  const relay = await startAsrRelay()
  if (relay.alreadyRunning) {
    console.log(`Infron ASR relay already listening on ${relay.endpoint}`)
  } else {
    console.log(`Infron ASR relay listening on ${relay.endpoint}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
