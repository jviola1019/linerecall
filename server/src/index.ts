import { S3Client } from '@aws-sdk/client-s3'
import { SESv2Client } from '@aws-sdk/client-sesv2'
import { KMSClient } from '@aws-sdk/client-kms'
import { Redis } from 'ioredis'
import { Pool } from 'pg'
import { createApp } from './app.js'
import {
  DisabledExternalConnectionService,
  DisabledLichessSyncService,
  HeaderAuthenticator,
  InMemoryRateLimiter,
  InMemoryRepertoireService,
  InMemorySyncStore,
  StaticCatalogService,
} from './adapters/memory.js'
import { PostgresRepertoireService } from './adapters/postgres-repertoire-service.js'
import { PostgresSyncStore } from './adapters/postgres-sync-store.js'
import { RedisRateLimiter } from './adapters/redis-rate-limiter.js'
import { S3ObjectStore } from './adapters/s3-object-store.js'
import { SignedS3CatalogService } from './adapters/signed-s3-catalog.js'
import { createBetterAuthGateway } from './auth/better-auth.js'
import { SesMagicLinkSender } from './auth/ses-magic-link-sender.js'
import { loadConfig } from './config.js'
import { KmsTokenVault } from './connections/kms-token-vault.js'
import { LichessConnectionService, RedisOAuthStateStore } from './connections/lichess.js'
import { PgBoss } from 'pg-boss'
import { PgBossJobQueue } from './jobs/durable-queue.js'
import {
  PgBossLichessSyncQueue,
  PostgresLichessSyncCoordinator,
  RedisLichessSyncWorkerAvailability,
} from './jobs/lichess-sync.js'
import type { ExternalConnectionService, LichessSyncService, RepertoireService, SyncStore } from './ports.js'
import type { CatalogService } from './ports.js'

const config = loadConfig()
const resources: Array<{ close(): Promise<unknown> | void }> = []

let appPool: Pool | undefined
let authPool: Pool | undefined
let catalog: CatalogService = new StaticCatalogService()
let sync: SyncStore
let repertoires: RepertoireService
let lichessSyncQueue: PgBossLichessSyncQueue | undefined
if (config.DATABASE_URL) {
  appPool = new Pool({
    connectionString: config.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'linerecall-api',
    ...(config.databaseSsl ? { ssl: config.databaseSsl } : {}),
  })
  resources.push({ close: () => appPool!.end() })
  if (config.production) {
    const s3 = new S3Client({ region: config.AWS_REGION })
    const objects = new S3ObjectStore(s3, config.PRIVATE_OBJECT_BUCKET!, config.PRIVATE_BUCKET_KMS_KEY_ID!)
    sync = new PostgresSyncStore(appPool, objects)
    catalog = new SignedS3CatalogService(
      s3, config.PUBLIC_DATA_BUCKET!, config.CATALOG_MANIFEST_KEY!, config.CATALOG_SIGNING_PUBLIC_KEY_PEM!,
    )
    const boss = new PgBoss({
      connectionString: config.DATABASE_URL,
      ...(config.databaseSsl ? { ssl: config.databaseSsl } : {}),
      application_name: 'linerecall-api-jobs',
      useListenNotify: false,
    })
    await boss.start()
    const jobs = new PgBossJobQueue(boss)
    await jobs.initialize()
    lichessSyncQueue = new PgBossLichessSyncQueue(boss)
    await lichessSyncQueue.initialize()
    repertoires = new PostgresRepertoireService(appPool, objects, jobs)
    resources.push({ close: () => jobs.close() }, { close: () => s3.destroy() })
  } else {
    sync = new PostgresSyncStore(appPool)
    repertoires = new InMemoryRepertoireService()
  }
} else {
  sync = new InMemorySyncStore()
  repertoires = new InMemoryRepertoireService()
}

let auth
let connections: ExternalConnectionService = new DisabledExternalConnectionService()
let lichessSync: LichessSyncService = new DisabledLichessSyncService()
if (config.AUTH_MODE === 'better-auth') {
  const betterAuthPool = new Pool({
    connectionString: config.AUTH_DATABASE_URL!,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'linerecall-auth',
    ...(config.databaseSsl ? { ssl: config.databaseSsl } : {}),
  })
  authPool = betterAuthPool
  const ses = new SESv2Client({ region: config.AWS_REGION })
  resources.push({ close: () => betterAuthPool.end() }, { close: () => ses.destroy() })
  auth = createBetterAuthGateway({
    pool: betterAuthPool,
    baseURL: config.SERVICE_ORIGIN,
    publicOrigin: config.PUBLIC_ORIGIN,
    secret: config.BETTER_AUTH_SECRET!,
    rpID: config.PASSKEY_RP_ID,
    rpName: config.PASSKEY_RP_NAME,
    sender: new SesMagicLinkSender(ses, config.MAGIC_LINK_FROM!),
    production: config.production,
    deleteUserData: async (userId) => {
      await connections.revokeForAccountDeletion(userId, new Date())
      await sync.deleteAccount(userId, new Date())
    },
  })
} else {
  auth = new HeaderAuthenticator(config.ALLOW_INSECURE_DEV_AUTH)
}

let rateLimiter
let redisClient: Redis | undefined
if (config.REDIS_URL) {
  const redis = new Redis(config.REDIS_URL, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
    tls: config.REDIS_URL.startsWith('rediss:') ? {} : undefined,
  })
  resources.push({ close: () => redis.quit() })
  redisClient = redis
  rateLimiter = new RedisRateLimiter(redis)
} else {
  rateLimiter = new InMemoryRateLimiter()
}

if (config.production && appPool && redisClient) {
  const kms = new KMSClient({ region: config.AWS_REGION })
  resources.push({ close: () => kms.destroy() })
  connections = new LichessConnectionService(
    appPool,
    redisClient,
    new RedisOAuthStateStore(redisClient),
    new KmsTokenVault(kms, config.TOKEN_KMS_KEY_ID!),
    config.LICHESS_CLIENT_ID!,
    config.EXTERNAL_USER_AGENT!,
  )
  if (lichessSyncQueue) {
    lichessSync = new PostgresLichessSyncCoordinator(
      appPool,
      lichessSyncQueue,
      new RedisLichessSyncWorkerAvailability(redisClient),
    )
  }
}

const app = await createApp({
  auth,
  sync,
  rateLimiter,
  repertoires,
  catalog,
  connections,
  lichessSync,
  readiness: {
    async check() {
      const checks: Record<string, boolean> = { process: true }
      if (appPool) {
        checks.applicationDatabase = await appPool.query('SELECT 1').then(() => true, () => false)
      } else checks.applicationDatabase = !config.production
      if (authPool) checks.authenticationDatabase = await authPool.query('SELECT 1').then(() => true, () => false)
      else checks.authenticationDatabase = config.AUTH_MODE !== 'better-auth'
      if (redisClient) checks.redis = await redisClient.ping().then((value) => value === 'PONG', () => false)
      else checks.redis = !config.production
      checks.signedCatalog = await catalog.getManifest().then(() => true, () => false)
      return checks
    },
  },
}, {
  publicOrigin: config.PUBLIC_ORIGIN,
  serviceOrigin: config.SERVICE_ORIGIN,
  production: config.production,
  logger: true,
  trustProxy: config.TRUST_PROXY,
})

let shuttingDown = false
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  app.log.info({ signal }, 'graceful shutdown')
  const timeout = setTimeout(() => process.exit(1), 15_000)
  timeout.unref()
  try {
    await app.close()
    await Promise.allSettled(resources.map((resource) => resource.close()))
    clearTimeout(timeout)
    process.exit(0)
  } catch (error) {
    app.log.error({ err: error }, 'shutdown failed')
    process.exit(1)
  }
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))

await app.listen({ host: config.HOST, port: config.PORT })
