import {
  DEFAULT_LOCALE,
  LocaleRegistrySchema,
  REQUIRED_MESSAGE_KEYS,
  formatIcuText,
  parseMessageCatalog,
  type LocaleDefinition,
  type LocaleId,
  type MessageCatalog,
  type MessageKey,
  type MessageParameters,
  type RuntimeLocaleId,
} from './localization.ts'

export const EN_US_MESSAGES = parseMessageCatalog({
  'app.name': 'LineRecall',
  'app.documentTitle': 'LineRecall — Audited Chess Opening Trainer',
  'app.loading': 'Preparing the audited opening database…',
  'app.unavailable': 'LineRecall could not continue.',
  'navigation.today': 'Today',
  'navigation.repertoire': 'Repertoire',
  'navigation.puzzles': 'Puzzles',
  'navigation.explore': 'Explore',
  'navigation.progress': 'Progress',
  'status.itemsLoaded': '{count, number} lines loaded.',
  'status.sourceLocaleOnly': 'English (United States) is the only enabled interface language in this build.',
})

const pendingReviewers = Object.freeze({ language: null, layout: null, assistiveTechnology: null })
const blockedReview = Object.freeze({
  runtimeEnabled: false,
  catalogId: null,
  reviewStatus: 'pending' as const,
  reviewers: pendingReviewers,
  blockers: [
    'catalog-translation',
    'named-language-review',
    'named-layout-review',
    'named-assistive-technology-review',
  ] as const,
})

export const LOCALE_REGISTRY = LocaleRegistrySchema.parse({
  schemaVersion: 1,
  defaultLocale: DEFAULT_LOCALE,
  requiredMessageKeys: REQUIRED_MESSAGE_KEYS,
  locales: [
    {
      id: 'en-US',
      direction: 'ltr',
      runtimeEnabled: true,
      catalogId: 'en-US',
      reviewStatus: 'source',
      reviewers: pendingReviewers,
      blockers: ['named-layout-review', 'named-assistive-technology-review'],
    },
    { id: 'es', direction: 'ltr', ...blockedReview },
    { id: 'de', direction: 'ltr', ...blockedReview },
    { id: 'fr', direction: 'ltr', ...blockedReview },
    { id: 'pt-BR', direction: 'ltr', ...blockedReview },
    { id: 'pl', direction: 'ltr', ...blockedReview },
    { id: 'ar', direction: 'rtl', ...blockedReview },
  ],
})

export const LOCALE_CATALOGS: Readonly<Partial<Record<LocaleId, MessageCatalog>>> = Object.freeze({
  'en-US': EN_US_MESSAGES,
})

export interface RuntimeLocale {
  id: RuntimeLocaleId
  direction: 'ltr'
  definition: LocaleDefinition
  message(key: MessageKey, parameters?: MessageParameters): string
}

/** Disabled locale requests fail closed to the audited source catalog. */
export function resolveRuntimeLocale(requested: LocaleId): RuntimeLocale {
  const requestedDefinition = LOCALE_REGISTRY.locales.find(({ id }) => id === requested)
  const sourceDefinition = LOCALE_REGISTRY.locales.find(({ id }) => id === DEFAULT_LOCALE)
  const definition = requestedDefinition?.runtimeEnabled && requestedDefinition.catalogId
    ? requestedDefinition
    : sourceDefinition
  if (!definition || definition.id !== DEFAULT_LOCALE || definition.direction !== 'ltr') {
    throw new Error('The enabled source locale registry is invalid')
  }
  const catalog = LOCALE_CATALOGS[definition.id]
  if (!catalog) throw new Error('The enabled source locale catalog is missing')
  return {
    id: DEFAULT_LOCALE,
    direction: 'ltr',
    definition,
    message: (key, parameters = {}) => formatIcuText(catalog[key], parameters, DEFAULT_LOCALE),
  }
}
