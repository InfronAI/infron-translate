import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    sourcemap: true,
    // Stable, distinct names reduce CRX entry mix-ups between SW and content
    rollupOptions: {
      input: {
        meetingAudio: 'src/offscreen/meeting-audio.html',
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  // Prevent pre-bundling issues with chrome types in tests/build
  optimizeDeps: {
    exclude: ['@crxjs/vite-plugin'],
  },
})
