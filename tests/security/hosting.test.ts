import assert from 'node:assert/strict'
import test from 'node:test'
import { hardenHtml } from '../../scripts/security/lib/csp.ts'
import {
  buildHostingManifest,
  cspDirectives,
  HostingManifestSchema,
  HostingPolicySchema,
  loadHostingPolicy,
} from '../../scripts/security/lib/hosting.ts'

const source = '<!doctype html><html lang="en"><head><style>body{color:#fff}</style></head><body><script>document.body.dataset.ready="true"</script></body></html>'

test('hosted routes bind exact hardened bytes to strict response headers and cache classes', async () => {
  const hardened = hardenHtml(source)
  const policy = await loadHostingPolicy()
  const manifest = buildHostingManifest(hardened.html, policy)

  assert.equal(manifest.routes[0].headers['Content-Security-Policy'], hardened.policy)
  assert.equal(manifest.routes[0].headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(manifest.routes[0].headers['Referrer-Policy'], 'no-referrer')
  assert.equal(manifest.routes[0].headers['X-Frame-Options'], 'DENY')
  assert.equal(manifest.routes[0].headers['Cache-Control'], 'no-store, max-age=0, must-revalidate')
  assert.equal(manifest.routes[1].headers['Cache-Control'], 'public, max-age=31536000, immutable')
  assert.ok(manifest.deployment.immutableRoute.includes(manifest.artifact.sha256))
  assert.deepEqual(HostingManifestSchema.parse(manifest), manifest)
})

test('hosting generation fails closed for stale CSP and header injection', async () => {
  const hardened = hardenHtml(source)
  const policy = await loadHostingPolicy()
  assert.throws(() => buildHostingManifest(hardened.html.replace('color:#fff', 'color:#000'), policy), /CSP is missing or stale/u)
  assert.throws(() => HostingPolicySchema.parse({
    ...policy,
    requiredResponseHeaders: { ...policy.requiredResponseHeaders, 'X-Test': 'safe\r\nInjected: yes' },
  }), /control delimiters/u)
})

test('CSP parser rejects duplicate directives for unambiguous deployment policy', () => {
  const directives = cspDirectives("default-src 'none'; frame-ancestors 'none'")
  assert.deepEqual(directives.get('frame-ancestors'), ["'none'"])
  assert.throws(() => cspDirectives("default-src 'none'; default-src https:"), /duplicate default-src/u)
})

test('permissions policy is fail-closed and cannot silently grant a feature', async () => {
  const policy = await loadHostingPolicy()
  const weakened = {
    ...policy,
    requiredResponseHeaders: {
      ...policy.requiredResponseHeaders,
      'Permissions-Policy': 'camera=(self)',
    },
  }
  assert.throws(() => buildHostingManifest(hardenHtml(source).html, weakened), /empty feature allowlists/u)
})
