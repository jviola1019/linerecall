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

test('registry audit reports structural, reviewer, blocker, catalog, and placeholder failures', () => {
  assert.equal(auditLocaleRegistry({}, {}).at(0)?.rule, 'invalid-registry-schema')

  const structural = structuredClone(LOCALE_REGISTRY)
  structural.locales[6] = structuredClone(structural.locales[1]!)
  structural.defaultLocale = 'es'
  structural.requiredMessageKeys.reverse()
  const source = structural.locales.find(({ id }) => id === 'en-US')!
  source.runtimeEnabled = false
  const structuralRules = new Set(auditLocaleRegistry(structural, {}).map(({ rule }) => rule))
  assert.ok(structuralRules.has('missing-locale'))
  assert.ok(structuralRules.has('duplicate-locale'))
  assert.ok(structuralRules.has('wrong-default-locale'))
  assert.ok(structuralRules.has('required-key-order'))
  assert.ok(structuralRules.has('source-locale-disabled'))
  assert.ok(structuralRules.has('invalid-source-catalog'))

  const blocked = structuredClone(LOCALE_REGISTRY)
  const blockedSpanish = blocked.locales.find(({ id }) => id === 'es')!
  blockedSpanish.blockers = []
  blockedSpanish.reviewStatus = 'source'
  const blockedRules = new Set(auditLocaleRegistry(blocked, {
    ...LOCALE_CATALOGS,
    es: LOCALE_CATALOGS['en-US'],
  }).map(({ rule }) => rule))
  assert.ok(blockedRules.has('multiple-source-locales'))
  assert.ok(blockedRules.has('blocked-catalog-embedded'))

  const approved = structuredClone(LOCALE_REGISTRY)
  const approvedSpanish = approved.locales.find(({ id }) => id === 'es')!
  approvedSpanish.runtimeEnabled = true
  approvedSpanish.catalogId = 'es'
  approvedSpanish.reviewStatus = 'approved'
  approvedSpanish.blockers = []
  approvedSpanish.reviewers = {
    language: null,
    layout: 'Layout Reviewer',
    assistiveTechnology: 'AT Reviewer',
  }
  const approvedRules = new Set(auditLocaleRegistry(approved, {
    ...LOCALE_CATALOGS,
    es: {},
  }).map(({ rule }) => rule))
  assert.ok(approvedRules.has('unnamed-reviewer'))
  assert.ok(approvedRules.has('invalid-enabled-catalog'))

  approvedSpanish.reviewers.language = 'Language Reviewer'
  const mismatchedCatalog = {
    ...LOCALE_CATALOGS['en-US']!,
    'status.itemsLoaded': 'Items loaded.',
  }
  const mismatchRules = auditLocaleRegistry(approved, {
    ...LOCALE_CATALOGS,
    es: mismatchedCatalog,
  })
  assert.ok(mismatchRules.some(({ rule, locale }) => rule === 'placeholder-mismatch' && locale === 'es'))
})
