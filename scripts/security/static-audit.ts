import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  collectFiles,
  option,
  workspaceRelative,
  workspaceRoot,
} from './lib/files.ts'
import { finishReport, makeReport, type CheckResult } from './lib/report.ts'
import { EMBEDDED_CONTEXT_PATTERN } from './lib/static-patterns.ts'

interface StaticRule {
  id: string
  explanation: string
  pattern: RegExp
}

const rules: readonly StaticRule[] = [
  { id: 'react-raw-html', explanation: 'dangerouslySetInnerHTML bypasses text escaping', pattern: /\bdangerouslySetInnerHTML\b/u },
  { id: 'eval', explanation: 'eval is prohibited', pattern: /\beval\s*\(/u },
  { id: 'function-constructor', explanation: 'dynamic Function construction is prohibited', pattern: /\bnew\s+Function\s*\(/u },
  { id: 'document-write', explanation: 'document.write is prohibited', pattern: /\bdocument\s*\.\s*write\s*\(/u },
  { id: 'raw-inner-html', explanation: 'raw innerHTML assignment is prohibited', pattern: /\.\s*innerHTML\s*=/u },
  { id: 'bracket-html-sink', explanation: 'bracket-notation HTML sink access is prohibited', pattern: /\[\s*['"](?:innerHTML|outerHTML|insertAdjacentHTML)['"]\s*\]/u },
  { id: 'adjacent-html', explanation: 'insertAdjacentHTML is prohibited', pattern: /\.\s*insertAdjacentHTML\s*\(/u },
  { id: 'dynamic-script', explanation: 'dynamic script element creation is prohibited', pattern: /createElement\s*\(\s*['"]script['"]\s*\)/u },
  {
    id: 'embedded-context',
    explanation: 'iframes, object/embed, and srcDoc are prohibited',
    pattern: EMBEDDED_CONTEXT_PATTERN,
  },
  { id: 'inline-handler', explanation: 'HTML inline event attributes are prohibited', pattern: /\son[a-z]+\s*=\s*['"]/iu },
  { id: 'jsx-inline-style', explanation: 'Inline style attributes are incompatible with the hash-only CSP', pattern: /\bstyle\s*=\s*\{/u },
  { id: 'javascript-url', explanation: 'javascript/vbscript URLs are prohibited', pattern: /(?:javascript|vbscript)\s*:/iu },
  { id: 'local-storage', explanation: 'localStorage and sessionStorage are prohibited', pattern: /\b(?:localStorage|sessionStorage)\b/u },
  { id: 'fetch', explanation: 'runtime fetch is prohibited in the offline application source', pattern: /\bfetch\s*\(/u },
  { id: 'xhr', explanation: 'XMLHttpRequest is prohibited in the offline application source', pattern: /\bXMLHttpRequest\b/u },
  { id: 'websocket', explanation: 'WebSocket is prohibited in the offline application source', pattern: /\bWebSocket\b/u },
  { id: 'event-source', explanation: 'EventSource is prohibited in the offline application source', pattern: /\bEventSource\b/u },
  { id: 'beacon', explanation: 'sendBeacon is prohibited in the offline application source', pattern: /\bsendBeacon\s*\(/u },
  { id: 'realtime-network', explanation: 'WebRTC and WebTransport are prohibited in the offline application', pattern: /\b(?:RTCPeerConnection|WebTransport)\b/u },
  { id: 'worker-construction', explanation: 'Runtime Worker and SharedWorker construction are prohibited', pattern: /\bnew\s+(?:SharedWorker|Worker)\s*\(/u },
  { id: 'anchor-ping', explanation: 'Anchor ping telemetry is prohibited', pattern: /\bping\s*=\s*(?:['"]|\{)/u },
  { id: 'meta-refresh', explanation: 'Meta refresh navigation is prohibited', pattern: /<meta\b[^>]*http-equiv\s*=\s*['"]?refresh/iu },
  { id: 'bracket-network-api', explanation: 'bracket-notation network API access is prohibited', pattern: /\b(?:window|globalThis|self)\s*\[\s*['"](?:fetch|XMLHttpRequest|WebSocket|EventSource)['"]\s*\]/u },
  { id: 'service-worker', explanation: 'service-worker registration is prohibited for the single-file offline artifact', pattern: /\bserviceWorker\s*\.\s*register\s*\(/u },
  { id: 'remote-import', explanation: 'remote dynamic/static module imports are prohibited', pattern: /\bimport\s*(?:\(|[^;]*?\bfrom\s*)["']https?:\/\//u },
  { id: 'telemetry-sdk', explanation: 'known client telemetry SDK usage is prohibited', pattern: /(?:@sentry|google-analytics|googletagmanager|segment\.com|mixpanel|posthog|amplitude)/iu },
]

const offlineOnlyRuleIds = new Set([
  'fetch', 'xhr', 'websocket', 'event-source', 'beacon', 'realtime-network',
  'bracket-network-api', 'service-worker', 'worker-construction',
])

const sourceExtensions = new Set([
  '', '.hcl', '.html', '.js', '.json', '.jsx', '.mts', '.sql', '.tf', '.tfvars', '.ts', '.tsx', '.yaml', '.yml',
])

function rulesFor(path: string): readonly StaticRule[] {
  // The downloaded client is deliberately network-free. The connected API has
  // two reviewed, fixed-destination provider fetches, so client-only network
  // prohibitions must not hide the common injection/dynamic-code checks there.
  return path.startsWith('hosted/') || path.startsWith('server/') || path.startsWith('infra/')
    ? rules.filter((rule) => !offlineOnlyRuleIds.has(rule.id))
    : rules
}

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

export async function auditStaticSource(): Promise<CheckResult> {
  const roots = [
    'src',
    'hosted/src',
    'hosted/index.html',
    'hosted/package.json',
    'hosted/tsconfig.json',
    'hosted/vite.config.ts',
    'server/src',
    'server/migrations',
    'server/Dockerfile',
    'server/compose.yaml',
    'server/package.json',
    'server/tsconfig.json',
    'server/tsconfig.build.json',
    'infra',
  ]
  for (const htmlEntry of ['linerecall.html', 'index.html']) {
    if (await import('node:fs/promises').then(({ stat }) => stat(resolve(workspaceRoot, htmlEntry)).then(() => true, () => false))) {
      roots.push(htmlEntry)
    }
  }
  const files = await collectFiles(roots, { extensions: sourceExtensions, maxBytes: 2 * 1024 * 1024 })
  const findings: Array<Record<string, unknown>> = []
  for (const file of files) {
    const source = await readFile(file, 'utf8')
    const relativePath = workspaceRelative(file)
    for (const rule of rulesFor(relativePath)) {
      for (const match of source.matchAll(new RegExp(rule.pattern.source, `${rule.pattern.flags}g`))) {
        findings.push({
          rule: rule.id,
          path: workspaceRelative(file),
          line: lineNumber(source, match.index ?? 0),
          explanation: rule.explanation,
        })
      }
    }

    if (/\.(?:tsx|jsx)$/u.test(file)) {
      for (const match of source.matchAll(/\b(?:href|src)\s*=\s*['"]https?:\/\//giu)) {
        findings.push({
          rule: 'unvalidated-external-url',
          path: workspaceRelative(file),
          line: lineNumber(source, match.index ?? 0),
          explanation: 'External references must pass through safeExternalReference and use rel="noopener noreferrer".',
        })
      }
    }
  }
  return {
    id: 'static-runtime-policy',
    status: findings.length === 0 ? 'pass' : 'fail',
    summary: findings.length === 0
      ? `${files.length} client, connected-server, and infrastructure source/config files satisfy their static policies`
      : `${findings.length} prohibited runtime source pattern(s) found`,
    findings,
    metrics: {
      filesScanned: files.length,
      connectedFiles: files.filter((file) => workspaceRelative(file).startsWith('server/')).length,
      hostedFiles: files.filter((file) => workspaceRelative(file).startsWith('hosted/')).length,
      infrastructureFiles: files.filter((file) => workspaceRelative(file).startsWith('infra/')).length,
      findingCount: findings.length,
    },
  }
}

const output = option('--output', 'audit/generated/static-source.json')
await finishReport(output, makeReport('static-source-audit', [await auditStaticSource()]))
