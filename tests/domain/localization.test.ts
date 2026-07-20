import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCALE_CATALOGS,
  LOCALE_REGISTRY,
  resolveRuntimeLocale,
} from '../../src/i18n/registry.ts'
import { auditLocaleRegistry } from '../../src/i18n/registry-audit.ts'
import { formatIcuText, parseMessageCatalog } from '../../src/i18n/localization.ts'

test('only the source locale is enabled and Arabic retains RTL metadata', () => {
  assert.deepEqual(LOCALE_REGISTRY.locales.filter(({ runtimeEnabled }) => runtimeEnabled).map(({ id }) => id), ['en-US'])
  assert.equal(LOCALE_REGISTRY.locales.find(({ id }) => id === 'ar')?.direction, 'rtl')
  assert.equal(auditLocaleRegistry(LOCALE_REGISTRY, LOCALE_CATALOGS).length, 0)
})

test('blocked locale requests fail closed to source text and direction', () => {
  const runtime = resolveRuntimeLocale('ar')
  assert.equal(runtime.id, 'en-US')
  assert.equal(runtime.direction, 'ltr')
  assert.equal(runtime.message('status.itemsLoaded', { count: 1234 }), '1,234 lines loaded.')
})

test('bounded ICU text formatting rejects missing, extra, markup, malformed, and mistyped parameters', () => {
  assert.equal(formatIcuText('Reviewed {count, number} lines on {date, date}.', {
    count: 12,
    date: new Date('2026-07-16T00:00:00.000Z'),
  }), 'Reviewed 12 lines on Jul 16, 2026.')
  assert.throws(() => formatIcuText('Hello {name}.', {}), /missing/u)
  assert.throws(() => formatIcuText('Hello.', { name: 'extra' }), /not used/u)
  assert.throws(() => formatIcuText('Hello {name}.', { name: '<script>' }), /markup/u)
  assert.equal(formatIcuText('Hello {name}.', { name: 'Ada ♟️' }), 'Hello Ada ♟️.')
  assert.throws(() => formatIcuText('Hello {name}.', { name: String.fromCharCode(0xd800) }), /malformed Unicode/u)
  assert.throws(() => formatIcuText('Count {count, number}.', { count: '12' }), /Number/u)
  assert.throws(() => formatIcuText('Unsupported {count, plural, one {line}}.', { count: 1 }), /unsupported ICU/u)
})

test('catalog and registry audits fail closed on missing keys, unreviewed enablement, and wrong RTL', () => {
  assert.throws(() => parseMessageCatalog({ 'app.name': 'LineRecall' }), /keys/u)
  const unsafe = structuredClone(LOCALE_REGISTRY)
  const spanish = unsafe.locales.find(({ id }) => id === 'es')!
  spanish.runtimeEnabled = true
  spanish.catalogId = 'es'
  const arabic = unsafe.locales.find(({ id }) => id === 'ar')!
  arabic.direction = 'ltr'
  const findings = auditLocaleRegistry(unsafe, { ...LOCALE_CATALOGS, es: LOCALE_CATALOGS['en-US'] })
  assert.ok(findings.some(({ rule, locale }) => rule === 'unreviewed-locale-enabled' && locale === 'es'))
  assert.ok(findings.some(({ rule, locale }) => rule === 'wrong-direction' && locale === 'ar'))
})
