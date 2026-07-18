import { defineManifest } from '@crxjs/vite-plugin'

export default defineManifest({
  manifest_version: 3,
  name: 'Infron Translate',
  description: 'Automatically detect webpage language and add bilingual full-page translations.',
  version: '0.2.0',
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Infron Translate',
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
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*'],
      js: ['src/content/main.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage', 'tabs', 'scripting'],
  host_permissions: ['http://*/*', 'https://*/*'],
})
