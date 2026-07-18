import { WebSocketServer, WebSocket } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'

const port = Number(process.env.ASR_RELAY_PORT || 8787)
const host = process.env.ASR_RELAY_HOST || '127.0.0.1'
const defaultUpstream = process.env.STEPFUN_ASR_WS || 'wss://api.stepfun.com/v1/realtime/asr/stream'
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || ''

const server = new WebSocketServer({ host, port, path: '/realtime/asr/stream' })

server.on('connection', (client) => {
  let upstream = null
  let ready = false
  const pending = []

  client.on('message', (data) => {
    if (!ready) {
      const control = parseControl(data)
      if (!control) {
        client.close(1008, 'relay.connect required')
        return
      }
      const apiKey = control.apiKey || process.env.STEPFUN_API_KEY
      if (!apiKey) {
        client.close(1008, 'StepFun API key is missing')
        return
      }
      upstream = connectUpstream(client, control.upstream || defaultUpstream, apiKey, pending)
      ready = true
      return
    }
    if (upstream?.readyState === WebSocket.OPEN) upstream.send(data)
    else pending.push(data)
  })

  client.on('close', () => {
    upstream?.close()
  })
  client.on('error', () => {
    upstream?.close()
  })
})

server.on('listening', () => {
  console.log(`Infron ASR relay listening on ws://${host}:${port}/realtime/asr/stream`)
})

function connectUpstream(client, upstreamUrl, apiKey, pending) {
  const upstream = new WebSocket(upstreamUrl, {
    agent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })
  upstream.on('open', () => {
    client.send(JSON.stringify({ type: 'relay.ready' }))
    while (pending.length && upstream.readyState === WebSocket.OPEN) upstream.send(pending.shift())
  })
  upstream.on('message', (data) => {
    if (client.readyState === WebSocket.OPEN) client.send(data)
  })
  upstream.on('close', (code, reason) => {
    safeClose(client, code, reason)
  })
  upstream.on('error', (error) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'error',
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      }))
      client.close(1011, 'upstream error')
    }
  })
  return upstream
}

function safeClose(socket, code = 1011, reason = '') {
  if (socket.readyState !== WebSocket.OPEN) return
  const closeCode = code >= 1000 && code <= 4999 && code !== 1005 && code !== 1006
    ? code
    : 1011
  const closeReason = Buffer.from(String(reason)).subarray(0, 120).toString()
  socket.close(closeCode, closeReason)
}

function parseControl(data) {
  try {
    const value = JSON.parse(data.toString())
    if (!value || value.type !== 'relay.connect') return null
    return {
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : '',
      upstream: typeof value.upstream === 'string' ? value.upstream : '',
    }
  } catch {
    return null
  }
}
