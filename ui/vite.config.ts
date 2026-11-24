import { defineConfig } from 'vite'

import { foldkit } from '@foldkit/vite-plugin'

export default defineConfig({
  plugins: [foldkit()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    fs: {
      allow: ['..'],
    },
    proxy: {
      // `npm run dev` talks to the TurboAPI backend running on 8734.
      '/api': 'http://127.0.0.1:8734',
    },
  },
})
