import { readFile } from 'node:fs/promises'
import { expect, test } from 'vitest'

const UI_STYLESHEETS = [
  new URL('../../src/app/styles.css', import.meta.url),
  new URL('../../src/app/components/puzzle.css', import.meta.url),
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
