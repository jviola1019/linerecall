import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  publicDir: false,
  resolve: {
    dedupe: ['react', 'react-dom', 'zod', 'chess.js'],
  },
  server: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
    proxy: {
      '/api/auth': 'http://127.0.0.1:3000',
      '/v1': 'http://127.0.0.1:3000',
    },
  },
  build: {
    target: 'es2022',
    outDir: '../build/hosted',
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['tests/setup.ts'],
  },
})
