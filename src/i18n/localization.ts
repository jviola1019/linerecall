import { z } from 'zod'

export const SUPPORTED_LOCALE_IDS = ['en-US', 'es', 'de', 'fr', 'pt-BR', 'pl', 'ar'] as const
export const LocaleIdSchema = z.enum(SUPPORTED_LOCALE_IDS)
export type LocaleId = z.infer<typeof LocaleIdSchema>

export const DEFAULT_LOCALE = 'en-US' as const
export const RuntimeLocaleIdSchema = z.literal(DEFAULT_LOCALE)
export type RuntimeLocaleId = z.infer<typeof RuntimeLocaleIdSchema>

export const REQUIRED_MESSAGE_KEYS = [
  'app.name',
  'app.documentTitle',
  'app.loading',
  'app.unavailable',
  'navigation.today',
  'navigation.repertoire',
  'navigation.puzzles',
  'navigation.explore',
  'navigation.progress',
  'status.itemsLoaded',
  'status.sourceLocaleOnly',
] as const

export type MessageKey = (typeof REQUIRED_MESSAGE_KEYS)[number]
export type TextDirection = 'ltr' | 'rtl'

export const LocaleReviewStatusSchema = z.enum(['source', 'pending', 'approved'])
export type LocaleReviewStatus = z.infer<typeof LocaleReviewStatusSchema>

const ReviewerNameSchema = z.string().trim().min(2).max(120).nullable()
const LocaleBlockerSchema = z.enum([
  'catalog-translation',
  'named-language-review',
  'named-layout-review',
  'named-assistive-technology-review',
])

export const LocaleDefinitionSchema = z.object({
  id: LocaleIdSchema,
  direction: z.enum(['ltr', 'rtl']),
  runtimeEnabled: z.boolean(),
  catalogId: LocaleIdSchema.nullable(),
  reviewStatus: LocaleReviewStatusSchema,
  reviewers: z.object({
    language: ReviewerNameSchema,
    layout: ReviewerNameSchema,
    assistiveTechnology: ReviewerNameSchema,
  }).strict(),
  blockers: z.array(LocaleBlockerSchema).max(4),
}).strict()

export type LocaleDefinition = z.infer<typeof LocaleDefinitionSchema>

export const LocaleRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  defaultLocale: LocaleIdSchema,
  requiredMessageKeys: z.array(z.enum(REQUIRED_MESSAGE_KEYS)).length(REQUIRED_MESSAGE_KEYS.length),
  locales: z.array(LocaleDefinitionSchema).length(SUPPORTED_LOCALE_IDS.length),
}).strict()

export type LocaleRegistry = z.infer<typeof LocaleRegistrySchema>

const MessagePatternSchema = z.string().min(1).max(500)
  .refine((value) => !/[\u0000-\u001F\u007F-\u009F]/u.test(value), 'Message contains a control character')
  .refine((value) => !containsMalformedUnicode(value), 'Message contains malformed Unicode')
  .refine((value) => !/<\/?[a-z][^>]*>/iu.test(value), 'Message catalogs must contain text, not markup')

export type MessageCatalog = Readonly<Record<MessageKey, string>>

export function parseMessageCatalog(value: unknown): MessageCatalog {
  const record = z.record(z.string(), MessagePatternSchema).parse(value)
  const actual = Object.keys(record).sort()
  const expected = [...REQUIRED_MESSAGE_KEYS].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error('Message catalog keys do not exactly match the required interface keys')
  }
  return Object.freeze(record as Record<MessageKey, string>)
}

const ParameterName = '[A-Za-z][A-Za-z0-9_]{0,31}'
const PARAMETER_PATTERN = new RegExp(`\\{(${ParameterName})(?:,\\s*(number|date))?\\}`, 'gu')
const LEFTOVER_BRACE = /[{}]/u
const TEXT_PARAMETER = z.string().max(256)
  .refine((value) => !/[\u0000-\u001F\u007F-\u009F]/u.test(value), 'Message parameter contains a control character')
  .refine((value) => !/[<>]/u.test(value), 'Message parameter contains markup punctuation')
  .refine((value) => !containsMalformedUnicode(value), 'Message parameter contains malformed Unicode')

function containsMalformedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true
    }
  }
  return false
}

export type MessageParameter = string | number | Date
export type MessageParameters = Readonly<Record<string, MessageParameter>>

export interface MessagePlaceholder {
  name: string
  format: 'text' | 'number' | 'date'
}

/**
 * Parses the deliberately bounded ICU message subset used by LineRecall.
 * Supported tokens are `{name}`, `{count, number}`, and `{date, date}`.
 * Plural/select rules remain disabled until reviewed locale catalogs exist.
 */
export function messagePlaceholders(pattern: string): MessagePlaceholder[] {
  MessagePatternSchema.parse(pattern)
  const placeholders: MessagePlaceholder[] = []
  const remainder = pattern.replace(PARAMETER_PATTERN, (_token, name: string, format?: string) => {
    placeholders.push({
      name,
      format: format === 'number' || format === 'date' ? format : 'text',
    })
    return ''
  })
  if (LEFTOVER_BRACE.test(remainder)) throw new Error('Message contains unsupported ICU syntax')
  const firstByName = new Map<string, MessagePlaceholder>()
  for (const placeholder of placeholders) {
    const prior = firstByName.get(placeholder.name)
    if (prior && prior.format !== placeholder.format) {
      throw new Error(`Message parameter ${placeholder.name} uses conflicting formats`)
    }
    firstByName.set(placeholder.name, placeholder)
  }
  return [...firstByName.values()]
}

function parameterText(value: MessageParameter, format: MessagePlaceholder['format'], locale: LocaleId): string {
  if (format === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1_000_000_000_000) {
      throw new Error('Number message parameter is outside the supported range')
    }
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(value)
  }
  if (format === 'date') {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('Date message parameter is invalid')
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(value)
  }
  if (typeof value !== 'string') throw new Error('Text message parameter must be a string')
  return TEXT_PARAMETER.parse(value)
}

export function formatIcuText(
  pattern: string,
  parameters: MessageParameters = {},
  locale: LocaleId = DEFAULT_LOCALE,
): string {
  LocaleIdSchema.parse(locale)
  const placeholders = messagePlaceholders(pattern)
  const expected = new Set(placeholders.map(({ name }) => name))
  const actual = Object.keys(parameters)
  const missing = [...expected].find((name) => !Object.hasOwn(parameters, name))
  if (missing) throw new Error(`Message parameter ${missing} is missing`)
  const unexpected = actual.find((name) => !expected.has(name))
  if (unexpected) throw new Error(`Message parameter ${unexpected} is not used by this message`)
  const formats = new Map(placeholders.map(({ name, format }) => [name, format] as const))
  const formatted = pattern.replace(PARAMETER_PATTERN, (_token, name: string) => {
    const format = formats.get(name)
    if (!format) throw new Error(`Message parameter ${name} is not declared`)
    return parameterText(parameters[name]!, format, locale)
  })
  if (formatted.length > 2_000) throw new Error('Formatted message exceeds the text limit')
  return formatted
}
