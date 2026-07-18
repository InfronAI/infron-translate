import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Infron Translate',
  description: 'Full-page translation and meeting assistant for live summaries and bilingual transcripts.',
  version: '0.2.0',
  icons: {
    16: 'icons/icon16.png',
    32: 'icons/icon32.png',
    48: 'icons/icon48.png',
    128: 'icons/icon128.png',
  },
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Infron Translate',
    default_icon: {
      16: 'icons/icon16.png',
      32: 'icons/icon32.png',
      48: 'icons/icon48.png',
      128: 'icons/icon128.png',
    },
  },
  options_ui: {
    page: 'src/options/index.html',
    open_in_tab: true,
  },
  background: {
    // Unique filename (not index.ts) — avoids CRXJS swapping SW/content bundles
    service_worker: 'src/background/sw.ts',
    type: 'module',
  },
  content_security_policy: {
    extension_pages:
      "script-src 'self'; object-src 'self'; connect-src 'self' https://* ws://127.0.0.1:8787 wss://api.stepfun.com",
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/main.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: [
    'storage',
    'tabs',
    'scripting',
    'offscreen',
    'tabCapture',
  ],
  host_permissions: ['http://*/*', 'https://*/*', 'ws://127.0.0.1/*', 'wss://api.stepfun.com/*'],
  web_accessible_resources: [
    {
      resources: ['icons/infron-mark.png', 'worklets/pcm-capture.js'],
      matches: ['http://*/*', 'https://*/*'],
    },
  ],
})
