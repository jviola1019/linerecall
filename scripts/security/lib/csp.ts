import { createHash } from 'node:crypto'
import {
  attribute,
  elementsNamed,
  hasAttribute,
  parseHtmlSource,
  rawTextContent,
  sourceRange,
  type HtmlElement,
} from './html-source.ts'

function cspHash(value: string): string {
  return `'sha256-${createHash('sha256').update(value, 'utf8').digest('base64')}'`
}

function browserInlineText(value: string): string {
  // The HTML input stream normalizes CRLF and lone CR to LF before inline
  // script/style text reaches CSP. Hash the browser-observed value rather than
  // the platform-specific source slice.
  return value.replace(/\r\n?/gu, '\n')
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export function stripCspMeta(html: string): string {
  const parsed = parseHtmlSource(html)
  const ranges = elementsNamed(parsed, 'meta')
    .filter(isCspMeta)
    .map((element) => sourceRange(element))
    .filter((range): range is { start: number; end: number } => range !== null)
    .map((range) => expandWhitespaceOnlyLine(html, range))
    .sort((left, right) => right.start - left.start)

  let stripped = html
  for (const range of ranges) {
    stripped = `${stripped.slice(0, range.start)}${stripped.slice(range.end)}`
  }
  return stripped
}

export function buildCsp(htmlWithNoCsp: string): string {
  const parsed = parseHtmlSource(htmlWithNoCsp)
  const scriptHashes: string[] = []
  for (const script of elementsNamed(parsed, 'script')) {
    if (hasAttribute(script, 'src')) {
      throw new Error('A self-contained artifact cannot contain a script src attribute')
    }
    scriptHashes.push(cspHash(browserInlineText(rawTextContent(parsed, script).content)))
  }

  const styleHashes = uniqueSorted(
    elementsNamed(parsed, 'style')
      .map((style) => cspHash(browserInlineText(rawTextContent(parsed, style).content))),
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
  const parsed = parseHtmlSource(withoutCsp)
  const heads = elementsNamed(parsed, 'head').filter((head) => head.sourceCodeLocation?.startTag)
  if (heads.length !== 1) throw new Error('HTML must have exactly one explicit head element')
  const insertionOffset = heads[0]!.sourceCodeLocation!.startTag!.endOffset
  const policy = buildCsp(withoutCsp)
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`
  return {
    html: `${withoutCsp.slice(0, insertionOffset)}\n    ${meta}${withoutCsp.slice(insertionOffset)}`,
    policy,
  }
}

export function readCspMeta(html: string): string | null {
  const parsed = parseHtmlSource(html)
  const metas = elementsNamed(parsed, 'meta').filter(isCspMeta)
  if (metas.length !== 1) return null
  return attribute(metas[0]!, 'content')
}

export function verifyCsp(html: string): { valid: boolean; expected: string; actual: string | null } {
  const actual = readCspMeta(html)
  const expected = buildCsp(stripCspMeta(html))
  return { valid: actual === expected, expected, actual }
}

function isCspMeta(element: HtmlElement): boolean {
  return attribute(element, 'http-equiv')?.trim().toLowerCase() === 'content-security-policy'
}

function expandWhitespaceOnlyLine(
  source: string,
  range: { start: number; end: number },
): { start: number; end: number } {
  const lineStart = source.lastIndexOf('\n', Math.max(0, range.start - 1)) + 1
  const nextNewline = source.indexOf('\n', range.end)
  const lineEnd = nextNewline < 0 ? source.length : nextNewline + 1
  const before = source.slice(lineStart, range.start)
  const after = source.slice(range.end, nextNewline < 0 ? source.length : nextNewline)
  return before.trim().length === 0 && after.trim().length === 0
    ? { start: lineStart, end: lineEnd }
    : range
}
