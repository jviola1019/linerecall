import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

test('CSP hashing follows HTML parsing rules for unusual script end tags', () => {
  const source = '<!doctype html><html lang="en"><head></head><body>'
    + '<SCRIPT type="module">globalThis.ready = true</SCRIPT\t\n ignored-attribute>'
    + '</body></html>'
  const hardened = hardenHtml(source)
  assert.equal(verifyCsp(hardened.html).valid, true)
  assert.match(hardened.policy, /script-src 'sha256-/u)
})

test('CSP generation rejects mixed-case external script attributes', () => {
  assert.throws(
    () => hardenHtml('<!doctype html><html><head></head><body><ScRiPt SrC=app.js></sCrIpT></body></html>'),
    /self-contained artifact/u,
  )
})

test('CSP metadata is recognized by parsed attributes and remains idempotent', () => {
  const source = `<!doctype html><html><head>
    <META content="stale" HTTP-EQUIV="content-security-policy">
  </head><body><style>body { color: CanvasText }</style></body></html>`
  const once = hardenHtml(source)
  const twice = hardenHtml(once.html)
  assert.equal(twice.html, once.html)
  assert.equal(verifyCsp(twice.html).valid, true)
  assert.equal(twice.html.includes('content="stale"'), false)
})

test('CSP hashes browser-normalized inline newlines instead of platform source newlines', () => {
  const script = 'globalThis.first = true;\r\nglobalThis.second = true;\r'
  const normalized = script.replace(/\r\n?/gu, '\n')
  const expectedHash = createHash('sha256').update(normalized, 'utf8').digest('base64')
  const hardened = hardenHtml(
    `<!doctype html><html><head></head><body><script>${script}</script></body></html>`,
  )

  assert.equal(hardened.policy.includes(`'sha256-${expectedHash}'`), true)
  assert.equal(verifyCsp(hardened.html).valid, true)
})
