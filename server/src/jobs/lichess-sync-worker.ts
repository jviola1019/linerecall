/* c8 ignore file -- process/bootstrap glue is exercised in connected staging */
import { randomBytes } from 'node:crypto'
import { KMSClient } from '@aws-sdk/client-kms'
import { Redis } from 'ioredis'
import { PgBoss } from 'pg-boss'
import { Pool } from 'pg'
import { KmsTokenVault } from '../connections/kms-token-vault.js'
import { RedisLichessProviderGate } from '../connections/lichess-provider-gate.js'
import {
  LichessSyncRunner,
  PgBossLichessSyncQueue,
  PostgresLichessSyncDeadLetterHandler,
} from './lichess-sync.js'
import { loadLichessSyncWorkerConfig } from './lichess-sync-worker-config.js'
import {
  LichessSyncWorkerRuntime,
  RedisLichessSyncWorkerHeartbeat,
  type LichessSyncWorkerBoss,
} from './lichess-sync-worker-runtime.js'

const config = loadLichessSyncWorkerConfig()
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.databaseSsl,
  max: 4,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'linerecall-lichess-sync-worker',
})
const redis = new Redis(config.REDIS_URL, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  lazyConnect: false,
  tls: {},
})
const kms = new KMSClient({ region: config.AWS_REGION })
const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  ssl: config.databaseSsl,
  application_name: 'linerecall-lichess-sync-jobs',
  useListenNotify: true,
  warningQueueSize: 250,
})
boss.on('error', (error) => console.error('pg-boss error', { errorClass: error.name }))
boss.on('warning', () => console.warn('pg-boss warning', { warningClass: 'PgBossWarning' }))

const runtime = new LichessSyncWorkerRuntime(
  boss as unknown as LichessSyncWorkerBoss,
  new PgBossLichessSyncQueue(boss),
  new LichessSyncRunner(
    pool,
    new KmsTokenVault(kms, config.TOKEN_KMS_KEY_ID),
    new RedisLichessProviderGate(redis),
    config.EXTERNAL_USER_AGENT,
  ),
  new PostgresLichessSyncDeadLetterHandler(pool),
  new RedisLichessSyncWorkerHeartbeat(redis, { token: randomBytes(24).toString('base64url') }),
  { shutdownTimeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS },
)

await runtime.start()

let stopping = false
async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.info('Lichess sync worker stopping', { signal })
  try {
    await runtime.stop()
    await Promise.allSettled([pool.end(), redis.quit()])
    kms.destroy()
    process.exitCode = 0
  } catch (error) {
    console.error('Lichess sync worker shutdown failed', {
      errorClass: error instanceof Error ? error.name : 'UnknownError',
    })
    process.exitCode = 1
  }
}

process.once('SIGTERM', () => void stop('SIGTERM'))
process.once('SIGINT', () => void stop('SIGINT'))
