import { readFileSync } from 'node:fs'
import { z } from 'zod'

const WorkerConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
  DATABASE_SSL_CA_PEM: z.string().min(1).optional(),
  REDIS_URL: z.url(),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  TOKEN_KMS_KEY_ID: z.string().min(1),
  EXTERNAL_USER_AGENT: z.string().min(10).max(256).refine((value) => value.includes('@'), {
    message: 'EXTERNAL_USER_AGENT must include a monitored contact address',
  }),
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
}).strict()

/** Loads only the secrets and endpoints needed by the isolated sync worker. */
export function loadLichessSyncWorkerConfig(environment: NodeJS.ProcessEnv = process.env) {
  const selected: Record<string, string | undefined> = {}
  for (const key of Object.keys(WorkerConfigSchema.shape)) selected[key] = environment[key]
  const config = WorkerConfigSchema.parse(selected)
  const redisUrl = new URL(config.REDIS_URL)
  if (redisUrl.protocol !== 'rediss:') throw new Error('Lichess sync worker Redis must use rediss:// transport encryption')
  const ca = config.DATABASE_SSL_CA_PEM ?? (
    config.DATABASE_SSL_CA_FILE ? readFileSync(config.DATABASE_SSL_CA_FILE, 'utf8') : undefined
  )
  if (!ca?.trim()) throw new Error('Lichess sync worker requires a verified PostgreSQL CA')
  return { ...config, databaseSsl: { ca, rejectUnauthorized: true as const } }
}
