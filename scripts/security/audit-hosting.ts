import { readFile } from 'node:fs/promises'
import {
  buildHostingManifest,
  cspDirectives,
  HostingManifestSchema,
  loadHostingPolicy,
} from './lib/hosting.ts'
import { option } from './lib/files.ts'
import { finishReport, makeReport, type CheckResult } from './lib/report.ts'

function valuesAre(directives: ReadonlyMap<string, readonly string[]>, name: string, expected: readonly string[]): boolean {
  const actual = directives.get(name)
  return actual !== undefined && actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

const artifactPath = option('--artifact', 'build/candidate/linerecall.html')
const policyPath = option('--policy', 'config/hosting-policy.json')
const manifestPath = option('--manifest', 'build/candidate/hosting-manifest.json')
const outputPath = option('--output', 'audit/generated/hosting-audit.json')

const checks: CheckResult[] = []
try {
  const [html, policy, manifestRaw] = await Promise.all([
    readFile(artifactPath, 'utf8'),
    loadHostingPolicy(policyPath),
    readFile(manifestPath, 'utf8'),
  ])
  const manifest = HostingManifestSchema.parse(JSON.parse(manifestRaw) as unknown)
  const expected = buildHostingManifest(html, policy)
  const manifestMatches = JSON.stringify(manifest) === JSON.stringify(expected)
  checks.push({
    id: 'hosting-manifest-bound-to-artifact',
    status: manifestMatches ? 'pass' : 'fail',
    summary: manifestMatches
      ? 'Hosted routes and response headers are bound to the exact hardened candidate bytes'
      : 'Hosting manifest is stale or differs from the required deployment policy',
    findings: manifestMatches ? [] : [{ artifactSha256: expected.artifact.sha256, manifestSha256: manifest.artifact.sha256 }],
    metrics: { bytes: expected.artifact.bytes, sha256: expected.artifact.sha256 },
  })

  const aliasHeaders = manifest.routes[0].headers
  const immutableHeaders = manifest.routes[1].headers
  const responseFindings: Array<Record<string, unknown>> = []
  for (const [name, value] of Object.entries(policy.requiredResponseHeaders)) {
    if (aliasHeaders[name] !== value || immutableHeaders[name] !== value) {
      responseFindings.push({ header: name, expected: value })
    }
  }
  if (aliasHeaders['Cache-Control'] !== policy.aliasCacheControl) responseFindings.push({ header: 'Cache-Control', route: 'alias' })
  if (immutableHeaders['Cache-Control'] !== policy.immutableCacheControl) responseFindings.push({ header: 'Cache-Control', route: 'immutable' })
  if (!manifest.deployment.immutableRoute.includes(manifest.artifact.sha256)) {
    responseFindings.push({ rule: 'immutable-route-is-not-content-addressed' })
  }
  checks.push({
    id: 'hosted-security-and-cache-headers',
    status: responseFindings.length === 0 ? 'pass' : 'fail',
    summary: responseFindings.length === 0
      ? 'Both hosted routes enforce the required security, privacy, MIME, framing, HTTPS, and cache headers'
      : `${responseFindings.length} hosted response-header finding(s)`,
    findings: responseFindings,
  })

  const directives = cspDirectives(aliasHeaders['Content-Security-Policy'] ?? '')
  const cspFindings: Array<Record<string, unknown>> = []
  const noneOnly = [
    'default-src', 'base-uri', 'child-src', 'connect-src', 'form-action',
    'frame-ancestors', 'frame-src', 'manifest-src', 'media-src', 'object-src', 'worker-src',
  ]
  for (const directive of noneOnly) {
    if (!valuesAre(directives, directive, ["'none'"])) cspFindings.push({ directive, expected: "'none'" })
  }
  if (!valuesAre(directives, 'font-src', ['data:'])) cspFindings.push({ directive: 'font-src', expected: 'data:' })
  for (const directive of ['script-src', 'style-src']) {
    const values = directives.get(directive) ?? []
    if (values.length === 0 || values.some((value) => !/^'sha256-[A-Za-z0-9+/]+=*'$/u.test(value))) {
      cspFindings.push({ directive, expected: 'one or more SHA-256 hashes only' })
    }
  }
  if (!valuesAre(directives, 'img-src', ['data:', 'blob:'])) cspFindings.push({ directive: 'img-src', expected: 'data: blob:' })
  if ([...directives.values()].flat().some((value) => /unsafe-|https?:|\*|data:/u.test(value) && value !== 'data:')) {
    cspFindings.push({ rule: 'unsafe-or-network-csp-source' })
  }
  if (aliasHeaders['Content-Security-Policy'] !== immutableHeaders['Content-Security-Policy']) {
    cspFindings.push({ rule: 'route-csp-mismatch' })
  }
  checks.push({
    id: 'hosted-content-security-policy',
    status: cspFindings.length === 0 ? 'pass' : 'fail',
    summary: cspFindings.length === 0
      ? "Response CSP exactly denies framing/network/code injection and allows only audited inline code and data assets"
      : `${cspFindings.length} hosted CSP finding(s)`,
    findings: cspFindings,
  })
} catch (error) {
  checks.push({
    id: 'hosting-configuration-readable',
    status: 'fail',
    summary: error instanceof Error ? error.message : String(error),
    findings: [{ artifactPath, policyPath, manifestPath }],
  })
}

await finishReport(outputPath, makeReport('hosting-deployment-audit', checks))
