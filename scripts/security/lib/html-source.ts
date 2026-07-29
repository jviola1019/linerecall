import { parse, type DefaultTreeAdapterTypes } from 'parse5'

export type HtmlElement = DefaultTreeAdapterTypes.Element

export interface ParsedHtmlSource {
  readonly source: string
  readonly elements: readonly HtmlElement[]
  readonly doctypeCount: number
}

function visit(
  node: DefaultTreeAdapterTypes.Node,
  elements: HtmlElement[],
): number {
  let doctypeCount = node.nodeName === '#documentType' ? 1 : 0
  if ('tagName' in node) {
    elements.push(node)
    if ('content' in node) doctypeCount += visit(node.content, elements)
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) doctypeCount += visit(child, elements)
  }
  return doctypeCount
}

export function parseHtmlSource(source: string): ParsedHtmlSource {
  const document = parse(source, { sourceCodeLocationInfo: true })
  const elements: HtmlElement[] = []
  const doctypeCount = visit(document, elements)
  return { source, elements, doctypeCount }
}

export function elementsNamed(parsed: ParsedHtmlSource, tagName: string): HtmlElement[] {
  const normalized = tagName.toLowerCase()
  return parsed.elements.filter((element) => element.tagName === normalized)
}

export function attribute(element: HtmlElement, name: string): string | null {
  const normalized = name.toLowerCase()
  return element.attrs.find((candidate) => candidate.name.toLowerCase() === normalized)?.value ?? null
}

export function hasAttribute(element: HtmlElement, name: string): boolean {
  const normalized = name.toLowerCase()
  return element.attrs.some((candidate) => candidate.name.toLowerCase() === normalized)
}

export function elementOffset(element: HtmlElement): number {
  return element.sourceCodeLocation?.startOffset ?? 0
}

export function rawTextContent(
  parsed: ParsedHtmlSource,
  element: HtmlElement,
): { content: string; offset: number } {
  const location = element.sourceCodeLocation
  if (!location?.startTag || !location.endTag) {
    throw new Error(`<${element.tagName}> must have explicit start and end tags`)
  }
  return {
    content: parsed.source.slice(location.startTag.endOffset, location.endTag.startOffset),
    offset: location.startTag.endOffset,
  }
}

export function sourceRange(element: HtmlElement): { start: number; end: number } | null {
  const location = element.sourceCodeLocation
  if (!location) return null
  return { start: location.startOffset, end: location.endOffset }
}
