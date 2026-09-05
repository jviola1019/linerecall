import { LOCALE_CATALOGS, LOCALE_REGISTRY } from '../../src/i18n/registry.ts'
import { auditLocaleRegistry } from '../../src/i18n/registry-audit.ts'
import { isExecutedDirectly, option, writeJsonAtomic } from '../security/lib/files.ts'

export async function auditLocales(outputPath: string): Promise<void> {
  const findings = auditLocaleRegistry(LOCALE_REGISTRY, LOCALE_CATALOGS)
  const blockedLocales = LOCALE_REGISTRY.locales
    .filter(({ runtimeEnabled }) => !runtimeEnabled)
    .map(({ id, blockers }) => ({ id, blockers }))
  await writeJsonAtomic(outputPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: findings.length === 0 ? 'pass' : 'fail',
    defaultLocale: LOCALE_REGISTRY.defaultLocale,
    runtimeEnabledLocales: LOCALE_REGISTRY.locales.filter(({ runtimeEnabled }) => runtimeEnabled).map(({ id }) => id),
    blockedLocales,
    sourceLocaleReviewLimitations: LOCALE_REGISTRY.locales.find(({ id }) => id === 'en-US')?.blockers ?? [],
    findings,
  })
  process.stdout.write(`Locale audit: ${findings.length === 0 ? 'PASS' : 'FAIL'} (${blockedLocales.length} target locales remain blocked)\n`)
  if (findings.length > 0) process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
  await auditLocales(option('--output', 'audit/generated/locale-audit.json'))
}
