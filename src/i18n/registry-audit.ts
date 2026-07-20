import {
  DEFAULT_LOCALE,
  REQUIRED_MESSAGE_KEYS,
  SUPPORTED_LOCALE_IDS,
  LocaleRegistrySchema,
  messagePlaceholders,
  parseMessageCatalog,
  type LocaleId,
  type LocaleRegistry,
  type MessageCatalog,
} from './localization.ts'

export interface LocaleAuditFinding {
  rule: string
  locale: string
  detail: string
}

const REQUIRED_BLOCKERS = [
  'catalog-translation',
  'named-language-review',
  'named-layout-review',
  'named-assistive-technology-review',
] as const

function placeholderSignature(catalog: MessageCatalog, key: keyof MessageCatalog): string {
  return messagePlaceholders(catalog[key])
    .map(({ name, format }) => `${name}:${format}`)
    .sort()
    .join('|')
}

export function auditLocaleRegistry(
  registryValue: unknown,
  catalogsValue: Readonly<Partial<Record<LocaleId, unknown>>>,
): LocaleAuditFinding[] {
  let registry: LocaleRegistry
  try {
    registry = LocaleRegistrySchema.parse(registryValue)
  } catch (error) {
    return [{ rule: 'invalid-registry-schema', locale: '*', detail: error instanceof Error ? error.message : 'Invalid locale registry' }]
  }
  const findings: LocaleAuditFinding[] = []
  const byId = new Map(registry.locales.map((locale) => [locale.id, locale]))
  for (const id of SUPPORTED_LOCALE_IDS) {
    if (!byId.has(id)) findings.push({ rule: 'missing-locale', locale: id, detail: 'Required target locale is absent' })
  }
  if (new Set(registry.locales.map(({ id }) => id)).size !== registry.locales.length) {
    findings.push({ rule: 'duplicate-locale', locale: '*', detail: 'Locale IDs must be unique' })
  }
  if (registry.defaultLocale !== DEFAULT_LOCALE) {
    findings.push({ rule: 'wrong-default-locale', locale: registry.defaultLocale, detail: `Default locale must be ${DEFAULT_LOCALE}` })
  }
  if (registry.requiredMessageKeys.some((key, index) => key !== REQUIRED_MESSAGE_KEYS[index])) {
    findings.push({ rule: 'required-key-order', locale: '*', detail: 'Required message key contract has changed or is out of order' })
  }
  const source = byId.get(DEFAULT_LOCALE)
  if (!source?.runtimeEnabled || source.reviewStatus !== 'source' || source.catalogId !== DEFAULT_LOCALE) {
    findings.push({ rule: 'source-locale-disabled', locale: DEFAULT_LOCALE, detail: 'The source locale must be the only source-enabled catalog' })
  }

  let sourceCatalog: MessageCatalog | null = null
  try {
    sourceCatalog = parseMessageCatalog(catalogsValue[DEFAULT_LOCALE])
  } catch (error) {
    findings.push({ rule: 'invalid-source-catalog', locale: DEFAULT_LOCALE, detail: error instanceof Error ? error.message : 'Source catalog is invalid' })
  }

  for (const locale of registry.locales) {
    const expectedDirection = locale.id === 'ar' ? 'rtl' : 'ltr'
    if (locale.direction !== expectedDirection) {
      findings.push({ rule: 'wrong-direction', locale: locale.id, detail: `${locale.id} must use ${expectedDirection}` })
    }
    if (locale.runtimeEnabled && locale.reviewStatus === 'pending') {
      findings.push({ rule: 'unreviewed-locale-enabled', locale: locale.id, detail: 'A pending locale cannot be enabled' })
    }
    if (locale.runtimeEnabled && locale.reviewStatus === 'approved') {
      const missingReviewer = Object.entries(locale.reviewers).find(([, reviewer]) => reviewer === null)
      if (missingReviewer) {
        findings.push({ rule: 'unnamed-reviewer', locale: locale.id, detail: `${missingReviewer[0]} review has no named reviewer` })
      }
    }
    if (locale.reviewStatus === 'source' && locale.id !== DEFAULT_LOCALE) {
      findings.push({ rule: 'multiple-source-locales', locale: locale.id, detail: 'Only en-US may use source-locale status' })
    }
    if (locale.id !== DEFAULT_LOCALE && locale.reviewStatus === 'pending') {
      const declaredBlockers = new Set<string>(locale.blockers)
      for (const blocker of REQUIRED_BLOCKERS) {
        if (!declaredBlockers.has(blocker)) {
          findings.push({ rule: 'missing-review-blocker', locale: locale.id, detail: `Pending locale does not declare ${blocker}` })
        }
      }
    }
    const rawCatalog = catalogsValue[locale.id]
    if (!locale.runtimeEnabled && rawCatalog !== undefined) {
      findings.push({ rule: 'blocked-catalog-embedded', locale: locale.id, detail: 'A blocked locale must not ship an unreviewed catalog' })
    }
    if (!locale.runtimeEnabled) continue
    if (locale.id !== DEFAULT_LOCALE && locale.reviewStatus !== 'approved') {
      findings.push({ rule: 'unapproved-locale-enabled', locale: locale.id, detail: 'Translated locales require approved status before activation' })
    }
    let catalog: MessageCatalog
    try {
      catalog = parseMessageCatalog(rawCatalog)
    } catch (error) {
      findings.push({ rule: 'invalid-enabled-catalog', locale: locale.id, detail: error instanceof Error ? error.message : 'Catalog is invalid' })
      continue
    }
    if (sourceCatalog && locale.id !== DEFAULT_LOCALE) {
      for (const key of REQUIRED_MESSAGE_KEYS) {
        if (placeholderSignature(catalog, key) !== placeholderSignature(sourceCatalog, key)) {
          findings.push({ rule: 'placeholder-mismatch', locale: locale.id, detail: `${key} does not preserve source placeholders` })
        }
      }
    }
  }
  return findings
}
