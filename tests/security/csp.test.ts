import assert from 'node:assert/strict'
import test from 'node:test'
import { hardenHtml, verifyCsp } from '../../scripts/security/lib/csp.ts'

test('CSP hashes every inline script and style without unsafe allowances', () => {
  const source = '<!doctype html><html lang="en"><head><style>body{color:#fff}</style></head><body><script type="module">document.body.dataset.ready="true"</script></body></html>'
  const hardened = hardenHtml(source)
  assert.match(hardened.policy, /script-src 'sha256-/u)
  assert.match(hardened.policy, /style-src 'sha256-/u)
  assert.doesNotMatch(hardened.policy, /unsafe-inline|unsafe-eval|https?:/u)
  assert.equal(verifyCsp(hardened.html).valid, true)
})

test('CSP verification fails closed after inline code changes', () => {
  const hardened = hardenHtml('<!doctype html><html lang="en"><head></head><body><script>void 0</script></body></html>')
  assert.equal(verifyCsp(hardened.html.replace('void 0', 'void 1')).valid, false)
})

test('CSP generation rejects external scripts', () => {
  assert.throws(
    () => hardenHtml('<!doctype html><html lang="en"><head></head><body><script src="app.js"></script></body></html>'),
    /self-contained artifact/u,
  )
})

test('CSP hardening is idempotent', () => {
  const source = '<!doctype html><html lang="en"><head>\n    <style>body{color:#fff}</style></head><body></body></html>'
  const once = hardenHtml(source)
  const twice = hardenHtml(once.html)
  assert.equal(twice.html, once.html)
  assert.equal(twice.policy, once.policy)
})
