#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const hostName = 'ai.infron.translate.asr_relay'
const extensionId = process.env.EXTENSION_ID || process.argv[2] || ''

if (!/^[a-p]{32}$/.test(extensionId)) {
  console.error('Usage: EXTENSION_ID=<chrome-extension-id> npm run native:install')
  console.error('Or: npm run native:install -- <chrome-extension-id>')
  process.exit(1)
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const hostPath = path.join(repoRoot, 'scripts', 'native-asr-host.mjs')
const manifestDir = nativeHostManifestDir()
const manifestPath = path.join(manifestDir, `${hostName}.json`)
const manifest = {
  name: hostName,
  description: 'Infron Translate local ASR relay launcher',
  path: hostPath,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
}

fs.mkdirSync(manifestDir, { recursive: true })
fs.chmodSync(hostPath, 0o755)
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`Installed native messaging host: ${manifestPath}`)
console.log(`Allowed extension: ${extensionId}`)

function nativeHostManifestDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts')
  }
  if (process.platform === 'win32') {
    throw new Error('Windows native host registry installation is not implemented by this script.')
  }
  return path.join(os.homedir(), '.config/google-chrome/NativeMessagingHosts')
}
