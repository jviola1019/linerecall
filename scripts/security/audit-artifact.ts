import { EmbeddedSnapshotPayloadSchema } from '../../src/data/embedded-contract.ts'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import { verifyCsp } from './lib/csp.ts'
import { isExecutedDirectly, option, sha256Bytes } from './lib/files.ts'
import {
  attribute,
  elementOffset,
  elementsNamed,
  hasAttribute,
  parseHtmlSource,
  rawTextContent,
  type HtmlElement,
} from './lib/html-source.ts'
import { finishReport, makeReport, type CheckResult } from './lib/report.ts'

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024

function addMatches(
  findings: Array<Record<string, unknown>>,
  source: string,
  rule: string,
  pattern: RegExp,
  explanation: string,
  offsetBase = 0,
): void {
  for (const match of source.matchAll(pattern)) {
    findings.push({
      rule,
      offset: offsetBase + (match.index ?? 0),
      explanation,
    })
  }
}

type ArtifactRead =
  | { status: 'ready'; bytes: Uint8Array; html: string }
  | { status: 'failed'; rule: string; summary: string }

async function readStableArtifact(path: string): Promise<ArtifactRead> {
  let bytes: Buffer
  try {
    bytes = await readHandleBoundRegularFile(path, 'Release candidate', MAX_ARTIFACT_BYTES)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      status: 'failed',
      rule: code === 'ENOENT' || code === 'ENOTDIR' ? 'artifact-missing' : 'artifact-unreadable',
      summary: code === 'ENOENT' || code === 'ENOTDIR'
        ? 'The self-contained release candidate does not exist'
        : 'The self-contained release candidate could not be read as one stable regular file',
    }
  }

  try {
    const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { status: 'ready', bytes, html }
  } catch {
    return { status: 'failed', rule: 'artifact-invalid-utf8', summary: 'The release candidate is not valid UTF-8' }
  }
}

function addElementFinding(
  findings: Array<Record<string, unknown>>,
  element: HtmlElement,
  rule: string,
  explanation: string,
): void {
  findings.push({ rule, offset: elementOffset(element), explanation })
}

export async function auditArtifact(path: string): Promise<readonly CheckResult[]> {
  const artifact = await readStableArtifact(path)
  if (artifact.status === 'failed') {
    return [{
      id: 'artifact-present',
      status: 'fail',
      summary: artifact.summary,
      findings: [{ path, rule: artifact.rule }],
    }]
  }

  const bytes = artifact.bytes.byteLength
  const html = artifact.html
  const parsed = parseHtmlSource(html)
  const findings: Array<Record<string, unknown>> = []

  for (const script of elementsNamed(parsed, 'script')) {
    if (hasAttribute(script, 'src')) {
      addElementFinding(findings, script, 'external-script', 'Scripts must be embedded.')
    }
  }
  for (const tagName of ['iframe', 'frame', 'embed', 'object']) {
    for (const element of elementsNamed(parsed, tagName)) {
      addElementFinding(findings, element, 'external-frame', 'Embedded browsing/plugin contexts are prohibited.')
    }
  }
  for (const tagName of ['img', 'audio', 'video', 'source', 'track', 'input']) {
    for (const element of elementsNamed(parsed, tagName)) {
      if (!hasAttribute(element, 'src')) continue
      const source = attribute(element, 'src') ?? ''
      if (source.startsWith('data:') || source.startsWith('blob:')) continue
      addElementFinding(findings, element, 'external-subresource', 'Binary subresources must use embedded data/blob URLs.')
    }
  }
  const resourceLinkRelations = new Set([
    'stylesheet', 'modulepreload', 'preload', 'prefetch', 'preconnect',
    'dns-prefetch', 'icon', 'mask-icon', 'manifest',
  ])
  for (const link of elementsNamed(parsed, 'link')) {
    const relation = attribute(link, 'rel')?.toLowerCase()
    const href = attribute(link, 'href')
    if (!relation || !relation.split(/\s+/u).some((value) => resourceLinkRelations.has(value))) continue
    if (href?.startsWith('data:') || href?.startsWith('blob:')) continue
    addElementFinding(findings, link, 'external-link-resource', 'Styles, modules, icons, and manifests must be embedded.')
  }
  for (const tagName of ['img', 'source']) {
    for (const element of elementsNamed(parsed, tagName)) {
      if (hasAttribute(element, 'srcset')) {
        addElementFinding(findings, element, 'external-srcset', 'Responsive image candidates are prohibited in the self-contained artifact.')
      }
    }
  }
  for (const video of elementsNamed(parsed, 'video')) {
    if (hasAttribute(video, 'poster')) {
      addElementFinding(findings, video, 'external-video-poster', 'Video poster subresources are prohibited in the self-contained artifact.')
    }
  }
  for (const anchor of elementsNamed(parsed, 'a')) {
    if (hasAttribute(anchor, 'ping')) {
      addElementFinding(findings, anchor, 'anchor-ping', 'Anchor ping telemetry is prohibited.')
    }
  }
  for (const meta of elementsNamed(parsed, 'meta')) {
    if (attribute(meta, 'http-equiv')?.trim().toLowerCase() === 'refresh') {
      addElementFinding(findings, meta, 'meta-refresh', 'Meta refresh navigation is prohibited.')
    }
  }
  for (const style of elementsNamed(parsed, 'style')) {
    let block
    try {
      block = rawTextContent(parsed, style)
    } catch {
      addElementFinding(findings, style, 'malformed-style-element', 'Style elements must have explicit end tags.')
      continue
    }
    const { content, offset } = block
    addMatches(
      findings,
      content,
      'css-external-url',
      /url\(\s*(["']?)(?!data:|blob:|#)[^)'"]+\1\s*\)/giu,
      'CSS resources must be embedded.',
      offset,
    )
    addMatches(
      findings,
      content,
      'css-import',
      /@import\s+(?:url\s*\(|["'])/giu,
      'CSS imports are prohibited in the self-contained artifact.',
      offset,
    )
  }
  for (const element of parsed.elements) {
    if (hasAttribute(element, 'style')) {
      addElementFinding(findings, element, 'style-attribute', 'Inline style attributes violate the hash-only CSP.')
    }
    if (element.attrs.some((candidate) => candidate.name.toLowerCase().startsWith('on'))) {
      addElementFinding(findings, element, 'inline-handler', 'Inline HTML handlers are prohibited.')
    }
  }
  addMatches(findings, html, 'network-api', /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon\s*\()/gu, 'The artifact must not make data-network calls.')
  addMatches(findings, html, 'realtime-network', /\b(?:RTCPeerConnection|WebTransport)\b/gu, 'WebRTC and WebTransport are prohibited in the offline artifact.')
  addMatches(findings, html, 'worker-construction', /\bnew\s+(?:SharedWorker|Worker)\s*\(/gu, 'Runtime worker construction is prohibited.')
  addMatches(findings, html, 'service-worker', /\bserviceWorker\s*\.\s*register\s*\(/gu, 'Service-worker registration is prohibited.')
  addMatches(findings, html, 'dynamic-code', /\b(?:eval\s*\(|new\s+Function\s*\()/gu, 'Dynamic code evaluation is prohibited.')
  addMatches(findings, html, 'storage-policy', /\b(?:localStorage|sessionStorage)\b/gu, 'Only ProgressRepository cloud, supported Artifact storage, memory, and validated JSON adapters are approved; browser key-value storage is prohibited.')
  addMatches(findings, html, 'unsafe-url', /(?:javascript|vbscript)\s*:/giu, 'Executable URL schemes are prohibited.')
  addMatches(findings, html, 'remote-module-import', /\bimport\s*(?:\(|[^;]*?\bfrom\s*)["']https?:\/\//giu, 'Remote module imports are prohibited.')
  addMatches(findings, html, 'source-map-reference', /\/\/[#@]\s*sourceMappingURL\s*=\s*(?!data:)/giu, 'External source maps are prohibited.')

  let csp: ReturnType<typeof verifyCsp>
  let cspParseFailure = false
  try {
    csp = verifyCsp(html)
  } catch {
    csp = { valid: false, actual: null, expected: '' }
    cspParseFailure = true
  }
  const cspFindings = csp.valid ? [] : [{
    rule: 'csp-mismatch',
    explanation: cspParseFailure
      ? 'CSP could not be verified because an inline block or external script was malformed.'
      : 'CSP is missing or does not exactly cover every inline script/style hash.',
    actual: csp.actual,
    expected: csp.expected,
  }]
  const structureFindings: Array<Record<string, unknown>> = []
  if (parsed.doctypeCount !== 1) structureFindings.push({ rule: 'doctype-count' })
  const explicitHtmlElements = elementsNamed(parsed, 'html').filter((element) => element.sourceCodeLocation !== null && element.sourceCodeLocation !== undefined)
  if (explicitHtmlElements.length !== 1) structureFindings.push({ rule: 'html-count' })
  const documentElement = explicitHtmlElements[0]
  if (!documentElement || attribute(documentElement, 'lang') !== 'en-US') structureFindings.push({ rule: 'language-missing' })
  if (!documentElement || attribute(documentElement, 'dir') !== 'ltr') structureFindings.push({ rule: 'direction-missing' })
  const hasViewport = elementsNamed(parsed, 'meta')
    .some((meta) => attribute(meta, 'name')?.trim().toLowerCase() === 'viewport')
  if (!hasViewport) structureFindings.push({ rule: 'viewport-missing' })

  const snapshotFindings: Array<Record<string, unknown>> = []
  const snapshotScripts = elementsNamed(parsed, 'script')
    .filter((script) => attribute(script, 'id') === 'linerecall-embedded-snapshot')
  if (snapshotScripts.length !== 1) {
    snapshotFindings.push({ rule: 'embedded-snapshot-count', actual: snapshotScripts.length, expected: 1 })
  } else {
    const snapshotScript = snapshotScripts[0]!
    if (attribute(snapshotScript, 'type')?.trim().toLowerCase() !== 'application/json') {
      snapshotFindings.push({ rule: 'embedded-snapshot-not-inert' })
    }
    try {
      const { content } = rawTextContent(parsed, snapshotScript)
      if (content.includes('<')) snapshotFindings.push({ rule: 'embedded-snapshot-raw-html-delimiter' })
      EmbeddedSnapshotPayloadSchema.parse(JSON.parse(content) as unknown)
    } catch {
      snapshotFindings.push({ rule: 'embedded-snapshot-json-or-shape' })
    }
  }

  return [
    {
      id: 'artifact-present',
      status: 'pass',
      summary: 'Self-contained artifact exists',
      findings: [],
      metrics: { bytes, sha256: sha256Bytes(artifact.bytes) },
    },
    {
      id: 'artifact-size',
      status: bytes <= MAX_ARTIFACT_BYTES ? 'pass' : 'fail',
      summary: `${bytes} bytes (${MAX_ARTIFACT_BYTES} maximum)`,
      findings: bytes <= MAX_ARTIFACT_BYTES ? [] : [{ bytes, maximumBytes: MAX_ARTIFACT_BYTES }],
      metrics: { bytes, maximumBytes: MAX_ARTIFACT_BYTES },
    },
    {
      id: 'offline-self-contained',
      status: findings.length === 0 ? 'pass' : 'fail',
      summary: findings.length === 0 ? 'No external subresources, network APIs, or prohibited sinks found' : `${findings.length} offline/security finding(s)`,
      findings,
    },
    {
      id: 'content-security-policy',
      status: csp.valid ? 'pass' : 'fail',
      summary: csp.valid ? 'CSP hashes exactly match embedded script/style blocks' : 'CSP is missing or stale',
      findings: cspFindings,
    },
    {
      id: 'document-basics',
      status: structureFindings.length === 0 ? 'pass' : 'fail',
      summary: structureFindings.length === 0 ? 'Document language, viewport, and structure are present' : `${structureFindings.length} document structure finding(s)`,
      findings: structureFindings,
    },
    {
      id: 'embedded-snapshot-container',
      status: snapshotFindings.length === 0 ? 'pass' : 'fail',
      summary: snapshotFindings.length === 0
        ? 'Exactly one inert, parseable, raw-text-safe opening snapshot is embedded'
        : `${snapshotFindings.length} embedded snapshot container finding(s)`,
      findings: snapshotFindings,
    },
  ]
}

if (isExecutedDirectly(import.meta.url)) {
  const artifact = option('--artifact', 'build/candidate/linerecall.html')
  const output = option('--output', 'audit/generated/artifact-audit.json')
  await finishReport(output, makeReport('artifact-audit', await auditArtifact(artifact)))
}
