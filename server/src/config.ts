import { readFileSync } from 'node:fs'
import { z } from 'zod'

const BooleanString = z.enum(['true', 'false']).transform((value) => value === 'true')

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.union([z.ipv4(), z.ipv6()]).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  PUBLIC_ORIGIN: z.url().default('http://127.0.0.1:5173'),
  SERVICE_ORIGIN: z.url().default('http://127.0.0.1:4100'),
  TRUST_PROXY: BooleanString.default(false),
  AUTH_MODE: z.enum(['dev-header', 'better-auth']).default('dev-header'),
  ALLOW_INSECURE_DEV_AUTH: BooleanString.default(false),
  DATABASE_URL: z.string().min(1).optional(),
  AUTH_DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
  DATABASE_SSL_CA_PEM: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).optional(),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),
  PASSKEY_RP_ID: z.string().min(1).max(253).default('localhost'),
  PASSKEY_RP_NAME: z.string().min(1).max(64).default('LineRecall'),
  MAGIC_LINK_FROM: z.string().email().optional(),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  PRIVATE_OBJECT_BUCKET: z.string().min(3).optional(),
  PUBLIC_DATA_BUCKET: z.string().min(3).optional(),
  CATALOG_MANIFEST_KEY: z.string().min(1).optional(),
  CATALOG_SIGNING_PUBLIC_KEY_PEM: z.string().min(1).optional(),
  PRIVATE_BUCKET_KMS_KEY_ID: z.string().min(1).optional(),
  BATCH_JOB_QUEUE: z.string().min(1).optional(),
  BATCH_IMPORT_JOB_DEFINITION: z.string().min(1).optional(),
  BATCH_STOCKFISH_JOB_DEFINITION: z.string().min(1).optional(),
  BATCH_SCID_JOB_DEFINITION: z.string().min(1).optional(),
  BATCH_REFRESH_JOB_DEFINITION: z.string().min(1).optional(),
  LICHESS_CLIENT_ID: z.string().min(3).max(128).optional(),
  TOKEN_KMS_KEY_ID: z.string().min(1).optional(),
  EXTERNAL_USER_AGENT: z.string().min(10).max(256).optional(),
}).strict()

export type AppConfig = ReturnType<typeof loadConfig>

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const selected: Record<string, string | undefined> = {}
  for (const key of Object.keys(ConfigSchema.shape)) selected[key] = environment[key]
  const config = ConfigSchema.parse(selected)
  const production = config.NODE_ENV === 'production'

  if (production && config.AUTH_MODE !== 'better-auth') throw new Error('Production requires AUTH_MODE=better-auth')
  if (config.AUTH_MODE === 'dev-header' && (!config.ALLOW_INSECURE_DEV_AUTH || production)) {
    throw new Error('Development header authentication requires ALLOW_INSECURE_DEV_AUTH=true and cannot run in production')
  }
  if (config.AUTH_MODE === 'better-auth') {
    for (const [name, value] of [
      ['AUTH_DATABASE_URL', config.AUTH_DATABASE_URL], ['BETTER_AUTH_SECRET', config.BETTER_AUTH_SECRET],
      ['MAGIC_LINK_FROM', config.MAGIC_LINK_FROM],
    ]) if (!value) throw new Error(`${name} is required for Better Auth`)
  }
  if (production && !config.REDIS_URL) throw new Error('Production requires REDIS_URL for distributed rate limiting')
  if (production && !config.DATABASE_SSL_CA_FILE && !config.DATABASE_SSL_CA_PEM) {
    throw new Error('Production requires DATABASE_SSL_CA_FILE or DATABASE_SSL_CA_PEM for verified PostgreSQL TLS')
  }
  if (production) {
    const publicOrigin = new URL(config.PUBLIC_ORIGIN)
    const serviceOrigin = new URL(config.SERVICE_ORIGIN)
    if (publicOrigin.protocol !== 'https:' || serviceOrigin.protocol !== 'https:') {
      throw new Error('Production public and service origins must use HTTPS')
    }
    if (
      publicOrigin.pathname !== '/' || publicOrigin.search || publicOrigin.hash ||
      serviceOrigin.pathname !== '/' || serviceOrigin.search || serviceOrigin.hash
    ) throw new Error('Production origins must not contain paths, queries, or fragments')
    const redisUrl = new URL(config.REDIS_URL!)
    if (redisUrl.protocol !== 'rediss:') throw new Error('Production Redis must use rediss:// transport encryption')
    if (config.PASSKEY_RP_ID === 'localhost' || !(
      publicOrigin.hostname === config.PASSKEY_RP_ID || publicOrigin.hostname.endsWith(`.${config.PASSKEY_RP_ID}`)
    )) throw new Error('PASSKEY_RP_ID must be a registrable suffix of the production public hostname')
    if (!config.TRUST_PROXY) throw new Error('Production behind the reference ALB requires TRUST_PROXY=true')
    for (const [name, value] of [
      ['DATABASE_URL', config.DATABASE_URL], ['PRIVATE_OBJECT_BUCKET', config.PRIVATE_OBJECT_BUCKET],
      ['PUBLIC_DATA_BUCKET', config.PUBLIC_DATA_BUCKET], ['CATALOG_MANIFEST_KEY', config.CATALOG_MANIFEST_KEY],
      ['CATALOG_SIGNING_PUBLIC_KEY_PEM', config.CATALOG_SIGNING_PUBLIC_KEY_PEM],
      ['PRIVATE_BUCKET_KMS_KEY_ID', config.PRIVATE_BUCKET_KMS_KEY_ID], ['BATCH_JOB_QUEUE', config.BATCH_JOB_QUEUE],
      ['BATCH_IMPORT_JOB_DEFINITION', config.BATCH_IMPORT_JOB_DEFINITION],
      ['BATCH_STOCKFISH_JOB_DEFINITION', config.BATCH_STOCKFISH_JOB_DEFINITION],
      ['BATCH_SCID_JOB_DEFINITION', config.BATCH_SCID_JOB_DEFINITION],
      ['BATCH_REFRESH_JOB_DEFINITION', config.BATCH_REFRESH_JOB_DEFINITION],
      ['LICHESS_CLIENT_ID', config.LICHESS_CLIENT_ID], ['TOKEN_KMS_KEY_ID', config.TOKEN_KMS_KEY_ID],
      ['EXTERNAL_USER_AGENT', config.EXTERNAL_USER_AGENT],
    ]) if (!value) throw new Error(`${name} is required in production`)
  }

  const databaseCa = config.DATABASE_SSL_CA_PEM ?? (config.DATABASE_SSL_CA_FILE ? readFileSync(config.DATABASE_SSL_CA_FILE, 'utf8') : undefined)
  const databaseSsl = databaseCa ? {
    ca: databaseCa,
    rejectUnauthorized: true as const,
  } : undefined

  return { ...config, production, databaseSsl }
}
