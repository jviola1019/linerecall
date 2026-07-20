import { readFile, stat } from 'node:fs/promises'
import { EmbeddedSnapshotPayloadSchema } from '../../src/data/embedded-contract.ts'
import { verifyCsp } from './lib/csp.ts'
import { fileExists, isExecutedDirectly, option, sha256Bytes } from './lib/files.ts'
import { finishReport, makeReport, type CheckResult } from './lib/report.ts'

const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024

function count(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length
}

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

export async function auditArtifact(path: string): Promise<readonly CheckResult[]> {
  if (!(await fileExists(path))) {
    return [{
      id: 'artifact-present',
      status: 'fail',
      summary: 'The self-contained release candidate does not exist',
      findings: [{ path }],
    }]
  }

  const bytes = (await stat(path)).size
  const html = await readFile(path, 'utf8')
  const findings: Array<Record<string, unknown>> = []

  addMatches(findings, html, 'external-script', /<script\b[^>]*\bsrc\s*=/giu, 'Scripts must be embedded.')
  addMatches(findings, html, 'external-frame', /<(?:iframe|frame|embed|object)\b/giu, 'Embedded browsing/plugin contexts are prohibited.')
  addMatches(
    findings,
    html,
    'external-subresource',
    /<(?:img|audio|video|source|track|input)\b[^>]*\bsrc\s*=\s*(["'])(?!data:|blob:)[\s\S]*?\1/giu,
    'Binary subresources must use embedded data/blob URLs.',
  )
  const resourceLinkRelations = new Set([
    'stylesheet', 'modulepreload', 'preload', 'prefetch', 'preconnect',
    'dns-prefetch', 'icon', 'mask-icon', 'manifest',
  ])
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const tag = match[0]
    const relation = /\brel\s*=\s*(["'])([\s\S]*?)\1/iu.exec(tag)?.[2]?.toLowerCase()
    const href = /\bhref\s*=\s*(["'])([\s\S]*?)\1/iu.exec(tag)?.[2]
    if (!relation || !relation.split(/\s+/u).some((value) => resourceLinkRelations.has(value))) continue
    if (href?.startsWith('data:') || href?.startsWith('blob:')) continue
    findings.push({
      rule: 'external-link-resource',
      offset: match.index ?? 0,
      explanation: 'Styles, modules, icons, and manifests must be embedded.',
    })
  }
  addMatches(
    findings,
    html,
    'external-srcset',
    /<(?:img|source)\b[^>]*\bsrcset\s*=/giu,
    'Responsive image candidates are prohibited in the self-contained artifact.',
  )
  addMatches(
    findings,
    html,
    'external-video-poster',
    /<video\b[^>]*\bposter\s*=/giu,
    'Video poster subresources are prohibited in the self-contained artifact.',
  )
  addMatches(findings, html, 'anchor-ping', /<a\b[^>]*\bping\s*=/giu, 'Anchor ping telemetry is prohibited.')
  addMatches(findings, html, 'meta-refresh', /<meta\b[^>]*http-equiv\s*=\s*(["']?)refresh\1/giu, 'Meta refresh navigation is prohibited.')
  for (const style of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/giu)) {
    const content = style[1] ?? ''
    addMatches(
      findings,
      content,
      'css-external-url',
      /url\(\s*(["']?)(?!data:|blob:|#)[^)'"]+\1\s*\)/giu,
      'CSS resources must be embedded.',
      (style.index ?? 0) + style[0].indexOf(content),
    )
    addMatches(
      findings,
      content,
      'css-import',
      /@import\s+(?:url\s*\(|["'])/giu,
      'CSS imports are prohibited in the self-contained artifact.',
      (style.index ?? 0) + style[0].indexOf(content),
    )
  }
  addMatches(findings, html, 'style-attribute', /\sstyle\s*=\s*(["'])/giu, 'Inline style attributes violate the hash-only CSP.')
  addMatches(findings, html, 'network-api', /\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon\s*\()/gu, 'The artifact must not make data-network calls.')
  addMatches(findings, html, 'realtime-network', /\b(?:RTCPeerConnection|WebTransport)\b/gu, 'WebRTC and WebTransport are prohibited in the offline artifact.')
  addMatches(findings, html, 'worker-construction', /\bnew\s+(?:SharedWorker|Worker)\s*\(/gu, 'Runtime worker construction is prohibited.')
  addMatches(findings, html, 'service-worker', /\bserviceWorker\s*\.\s*register\s*\(/gu, 'Service-worker registration is prohibited.')
  addMatches(findings, html, 'dynamic-code', /\b(?:eval\s*\(|new\s+Function\s*\()/gu, 'Dynamic code evaluation is prohibited.')
  addMatches(findings, html, 'storage-policy', /\b(?:localStorage|sessionStorage)\b/gu, 'Only ProgressRepository cloud, supported Artifact storage, memory, and validated JSON adapters are approved; browser key-value storage is prohibited.')
  addMatches(findings, html, 'unsafe-url', /(?:javascript|vbscript)\s*:/giu, 'Executable URL schemes are prohibited.')
  addMatches(findings, html, 'inline-handler', /\son[a-z]+\s*=\s*(["'])/giu, 'Inline HTML handlers are prohibited.')
  addMatches(findings, html, 'remote-module-import', /\bimport\s*(?:\(|[^;]*?\bfrom\s*)["']https?:\/\//giu, 'Remote module imports are prohibited.')
  addMatches(findings, html, 'source-map-reference', /\/\/[#@]\s*sourceMappingURL\s*=\s*(?!data:)/giu, 'External source maps are prohibited.')

  const csp = verifyCsp(html)
  const cspFindings = csp.valid ? [] : [{
    rule: 'csp-mismatch',
    explanation: 'CSP is missing or does not exactly cover every inline script/style hash.',
    actual: csp.actual,
    expected: csp.expected,
  }]
  const structureFindings: Array<Record<string, unknown>> = []
  if (count(html, /<!doctype\s+html/giu) !== 1) structureFindings.push({ rule: 'doctype-count' })
  if (count(html, /<html\b/giu) !== 1) structureFindings.push({ rule: 'html-count' })
  if (!/<html\b[^>]*\blang\s*=\s*(["'])en-US\1/iu.test(html)) structureFindings.push({ rule: 'language-missing' })
  if (!/<html\b[^>]*\bdir\s*=\s*(["'])ltr\1/iu.test(html)) structureFindings.push({ rule: 'direction-missing' })
  if (!/<meta\b[^>]*\bname\s*=\s*(["'])viewport\1/iu.test(html)) structureFindings.push({ rule: 'viewport-missing' })

  const snapshotFindings: Array<Record<string, unknown>> = []
  const snapshotScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)]
    .filter((match) => /\bid\s*=\s*(["'])linerecall-embedded-snapshot\1/iu.test(match[1] ?? ''))
  if (snapshotScripts.length !== 1) {
    snapshotFindings.push({ rule: 'embedded-snapshot-count', actual: snapshotScripts.length, expected: 1 })
  } else {
    const attributes = snapshotScripts[0]?.[1] ?? ''
    const content = snapshotScripts[0]?.[2] ?? ''
    if (!/\btype\s*=\s*(["'])application\/json\1/iu.test(attributes)) {
      snapshotFindings.push({ rule: 'embedded-snapshot-not-inert' })
    }
    if (content.includes('<')) snapshotFindings.push({ rule: 'embedded-snapshot-raw-html-delimiter' })
    try {
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
      metrics: { bytes, sha256: sha256Bytes(html) },
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
