import assert from 'node:assert/strict'
import test from 'node:test'
import { safeExternalReference } from '../../src/security/external-url.ts'

test('external references are limited to HTTPS and approved provenance hosts', () => {
  assert.equal(
    safeExternalReference('https://database.lichess.org/'),
    'https://database.lichess.org/',
  )
  assert.throws(() => safeExternalReference('http://database.lichess.org/'), /HTTPS/u)
  assert.throws(() => safeExternalReference('https://example.test/'), /not approved/u)
  assert.throws(() => safeExternalReference('https://user:password@github.com/'), /credentials/u) // secret-scan: allow — synthetic rejection fixture
  assert.throws(() => safeExternalReference('https://github.com.example.test/'), /not approved/u)
  assert.throws(() => safeExternalReference('https://github.com:444/'), /non-default port/u)
  assert.throws(() => safeExternalReference('https://git\nhub.com/'), /control/u)
  assert.throws(() => safeExternalReference(`https://github.com/${String.fromCharCode(0xd800)}`), /malformed Unicode/u)
  assert.throws(() => safeExternalReference(`https://github.com/${'x'.repeat(2_049)}`), /too long/u)
  assert.throws(() => safeExternalReference('not a URL'), /valid URL/u)
})
