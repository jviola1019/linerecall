import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('tests/review-harness'),
  plugins: [react()],
  publicDir: false,
  build: {
    target: 'es2022',
    modulePreload: false,
    outDir: resolve('build/review-harness'),
    emptyOutDir: true,
    sourcemap: true,
    cssCodeSplit: true,
  },
})
