import { createHash } from 'node:crypto'

const CSP_META_PATTERN = /<meta\s+[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/giu
const CSP_META_LINE_PATTERN = /^[\t ]*<meta\s+[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>[\t ]*(?:\r?\n)?/gimu
const SCRIPT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu
const STYLE_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu

function cspHash(value: string): string {
  return `'sha256-${createHash('sha256').update(value, 'utf8').digest('base64')}'`
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export function stripCspMeta(html: string): string {
  return html.replace(CSP_META_LINE_PATTERN, '').replace(CSP_META_PATTERN, '')
}

export function buildCsp(htmlWithNoCsp: string): string {
  const scriptHashes: string[] = []
  for (const match of htmlWithNoCsp.matchAll(SCRIPT_PATTERN)) {
    const attributes = match[1] ?? ''
    if (/\bsrc\s*=/iu.test(attributes)) {
      throw new Error('A self-contained artifact cannot contain a script src attribute')
    }
    scriptHashes.push(cspHash(match[2] ?? ''))
  }

  const styleHashes = uniqueSorted(
    [...htmlWithNoCsp.matchAll(STYLE_PATTERN)].map((match) => cspHash(match[1] ?? '')),
  )
  const scripts = uniqueSorted(scriptHashes)

  return [
    "default-src 'none'",
    "base-uri 'none'",
    "child-src 'none'",
    "connect-src 'none'",
    'font-src data:',
    "form-action 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    'img-src data: blob:',
    "manifest-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    `script-src ${scripts.length > 0 ? scripts.join(' ') : "'none'"}`,
    `style-src ${styleHashes.length > 0 ? styleHashes.join(' ') : "'none'"}`,
    "worker-src 'none'",
  ].join('; ')
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}

export function hardenHtml(html: string): { html: string; policy: string } {
  const withoutCsp = stripCspMeta(html)
  if (!/<head(?:\s[^>]*)?>/iu.test(withoutCsp)) throw new Error('HTML has no head element')
  const policy = buildCsp(withoutCsp)
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`
  return {
    html: withoutCsp.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}\n    ${meta}`),
    policy,
  }
}

export function readCspMeta(html: string): string | null {
  const tag = html.match(CSP_META_PATTERN)?.[0]
  if (!tag) return null
  const content = tag.match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/iu)?.[2]
  if (!content) return null
  return content.replaceAll('&quot;', '"').replaceAll('&amp;', '&')
}

export function verifyCsp(html: string): { valid: boolean; expected: string; actual: string | null } {
  const actual = readCspMeta(html)
  const expected = buildCsp(stripCspMeta(html))
  return { valid: actual === expected, expected, actual }
}
