import assert from 'node:assert/strict'
import test from 'node:test'
import { EMBEDDED_CONTEXT_PATTERN } from '../../scripts/security/lib/static-patterns.ts'

test('embedded-context policy distinguishes JSX elements from TypeScript generics', () => {
  for (const safe of [
    'new WeakMap<object, Value>()',
    'const value: Record<string, object> = {}',
    'type Pair = [object, string]',
  ]) assert.equal(EMBEDDED_CONTEXT_PATTERN.test(safe), false, safe)

  for (const prohibited of [
    '<iframe title="external" />',
    '< object data="payload">',
    '<embed/>',
    '<Component srcDoc={untrusted} />',
  ]) assert.equal(EMBEDDED_CONTEXT_PATTERN.test(prohibited), true, prohibited)
})
