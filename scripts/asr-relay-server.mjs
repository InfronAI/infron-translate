import { WebSocketServer, WebSocket } from 'ws'
import { HttpsProxyAgent } from 'https-proxy-agent'

export function startAsrRelay(options = {}) {
  const port = Number(options.port || process.env.ASR_RELAY_PORT || 8787)
  const host = options.host || process.env.ASR_RELAY_HOST || '127.0.0.1'
  const defaultUpstream =
    options.defaultUpstream ||
    process.env.STEPFUN_ASR_WS ||
    'wss://api.stepfun.com/v1/realtime/asr/stream'
  const proxyUrl =
    options.proxyUrl || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || ''

  return new Promise((resolve, reject) => {
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
          upstream = connectUpstream(
            client,
            control.upstream || defaultUpstream,
            apiKey,
            pending,
            proxyUrl,
          )
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

    server.once('listening', () => {
      resolve({
        server,
        host,
        port,
        endpoint: `ws://${host}:${port}/realtime/asr/stream`,
        alreadyRunning: false,
      })
    })
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        resolve({
          server: null,
          host,
          port,
          endpoint: `ws://${host}:${port}/realtime/asr/stream`,
          alreadyRunning: true,
        })
        return
      }
      reject(error)
    })
  })
}

function connectUpstream(client, upstreamUrl, apiKey, pending, proxyUrl) {
  const upstream = new WebSocket(upstreamUrl, {
    agent: proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined,
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  })
  let connected = false
  upstream.on('open', () => {
    connected = true
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
    sendError(client, upstreamErrorMessage(error, connected))
    safeClose(client, 1011, 'upstream error')
  })
  upstream.on('unexpected-response', (_request, response) => {
    let body = ''
    response.setEncoding('utf8')
    response.on('data', (chunk) => {
      body += chunk
      if (body.length > 1000) response.destroy()
    })
    response.on('end', () => {
      sendError(
        client,
        `StepFun ASR WebSocket rejected handshake with HTTP ${response.statusCode}${body ? `: ${compact(body)}` : ''}`,
      )
      safeClose(client, 1011, 'upstream rejected')
    })
  })
  return upstream
}

function sendError(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) return
  socket.send(JSON.stringify({
    type: 'error',
    error: { message },
  }))
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

function upstreamErrorMessage(error, connected) {
  const message = error instanceof Error ? error.message : String(error)
  return connected
    ? `StepFun ASR WebSocket error: ${message}`
    : `StepFun ASR WebSocket handshake failed: ${message}`
}

function compact(value) {
  return String(value).replace(/\s+/g, ' ').trim().slice(0, 500)
}
