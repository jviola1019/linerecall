import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'

const UI_STYLESHEETS = [
  new URL('../../src/app/styles.css', import.meta.url),
  new URL('../../src/app/components/board.css', import.meta.url),
  new URL('../../src/app/components/puzzle.css', import.meta.url),
  new URL('../../src/app/components/training-puzzle.css', import.meta.url),
]

test('the frontend visual language has no decorative gradients, glass blur, or bundled-font dependency', async () => {
  const css = (await Promise.all(UI_STYLESHEETS.map(async (url) => readFile(url, 'utf8')))).join('\n')
  expect(css).not.toMatch(/(?:repeating-)?(?:linear|radial|conic)-gradient\s*\(/iu)
  expect(css).not.toMatch(/backdrop-filter\s*:/iu)
  expect(css).not.toMatch(/font-family\s*:\s*(?:Inter|Newsreader|"Instrument Sans")/iu)
  expect(css).not.toMatch(/drop-shadow\(\s*0\s+0\s+/iu)
  expect(css).not.toMatch(/\.drill-thumb-dock\s*\{[^}]*position\s*:\s*(?:fixed|sticky)/isu)
  expect(css).not.toMatch(/\.puzzle-board-actions\s*\{[^}]*position\s*:\s*(?:fixed|sticky)/isu)
})

test('the shared application theme uses one explicit, accessible token system', async () => {
  const css = await readFile(new URL('../../src/app/styles.css', import.meta.url), 'utf8')

  for (const token of [
    '--bg',
    '--surface',
    '--surface-raised',
    '--surface-muted',
    '--text',
    '--muted',
    '--border',
    '--border-strong',
    '--accent',
    '--accent-hover',
    '--focus',
    '--space-1',
    '--space-7',
    '--radius-sm',
    '--radius-lg',
    '--control-height',
    '--font-mono',
  ]) {
    expect(css).toContain(`${token}:`)
  }

  expect(css).toMatch(/font-family:\s*system-ui,\s*-apple-system,\s*BlinkMacSystemFont,\s*"Segoe UI",\s*sans-serif/iu)
  expect(css).toMatch(/html\s*\{[^}]*min-width:\s*320px/isu)
  expect(css).toMatch(/button,\s*input,\s*textarea,\s*select\s*\{[^}]*min-height:\s*44px/isu)
  expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/iu)
  expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)/iu)
  expect(css).toMatch(/\.primary-action[\s\S]*?background:\s*var\(--accent\)/iu)
  expect(css).toMatch(/\.secondary-button\s*\{[^}]*background:\s*transparent/isu)
})

test('shared route surfaces reflow without relying on clipped horizontal card tracks', async () => {
  const css = await readFile(new URL('../../src/app/styles.css', import.meta.url), 'utf8')

  expect(css).toMatch(/\.family-card-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/isu)
  expect(css).toMatch(/@media\s*\(max-width:\s*900px\)[\s\S]*?\.family-card-grid\s*\{[^}]*grid-template-columns:\s*1fr/isu)
  expect(css).toMatch(/@media\s*\(max-width:\s*600px\)[\s\S]*?\.family-card-grid\s*\{[^}]*grid-template-columns:\s*1fr/isu)
  expect(css).toMatch(/\.today-grid\s*\{[^}]*display:\s*grid/isu)
  expect(css).not.toMatch(/\.family-card-grid\s*\{[^}]*overflow-x:\s*(?:auto|scroll)/isu)
})

test('route styles use only the shared 600, 900, and 1100px width thresholds', async () => {
  const css = (await Promise.all(UI_STYLESHEETS.map(async (url) => readFile(url, 'utf8')))).join('\n')
  const queries = [...css.matchAll(/@media\s*\(\s*(min|max)-width:\s*(\d+)px\s*\)/giu)]
    .map((match) => `${match[1]}:${match[2]}`)
  const allowed = new Set(['max:600', 'max:900', 'max:1100', 'min:1101'])

  expect(queries.length).toBeGreaterThan(0)
  expect([...new Set(queries.filter((query) => !allowed.has(query)))]).toEqual([])
  expect(css).toMatch(/@media\s*\(max-width:\s*900px\)\s*and\s*\(max-height:\s*820px\)/iu)
})
