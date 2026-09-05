import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node's built-in test runner owns data, domain, verification, and security
    // suites. Vitest is reserved for browser-shaped unit/component coverage so
    // neither Playwright specs nor node:test suites are discovered twice.
    include: ['tests/component/**/*.test.{ts,tsx}'],
    exclude: ['tests/e2e/**', 'tests/data/**', 'tests/domain/**', 'tests/security/**', 'tests/verification/**'],
    passWithNoTests: false,
    coverage: {
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/generated/**'],
      all: true,
    },
  },
})
