import { BatchClient } from '@aws-sdk/client-batch'
import { readFileSync } from 'node:fs'
import { PgBoss, type Job } from 'pg-boss'
import { z } from 'zod'
import { AwsBatchComputeExecutor } from '../adapters/aws-batch-compute.js'
import { COMPUTE_WORKLOADS, PgBossJobQueue, deadLetterQueueName, parseDurableJobPayload, queueName } from './durable-queue.js'

const DispatcherConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
  DATABASE_SSL_CA_PEM: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).default('us-east-1'),
  BATCH_JOB_QUEUE: z.string().min(1),
  BATCH_IMPORT_JOB_DEFINITION: z.string().min(1),
  BATCH_STOCKFISH_JOB_DEFINITION: z.string().min(1),
  BATCH_SCID_JOB_DEFINITION: z.string().min(1),
  BATCH_REFRESH_JOB_DEFINITION: z.string().min(1),
}).strict()

function loadDispatcherConfig(environment: NodeJS.ProcessEnv = process.env) {
  const selected: Record<string, string | undefined> = {}
  for (const key of Object.keys(DispatcherConfigSchema.shape)) selected[key] = environment[key]
  const config = DispatcherConfigSchema.parse(selected)
  const ca = config.DATABASE_SSL_CA_PEM ?? (config.DATABASE_SSL_CA_FILE ? readFileSync(config.DATABASE_SSL_CA_FILE, 'utf8') : undefined)
  if (!ca) throw new Error('Dispatcher requires a verified PostgreSQL CA')
  return { ...config, ssl: { ca, rejectUnauthorized: true as const } }
}

const config = loadDispatcherConfig()
const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  ssl: config.ssl,
  application_name: 'linerecall-dispatcher',
  useListenNotify: true,
  warningQueueSize: 1_000,
})
boss.on('error', (error) => console.error('pg-boss error', error))
boss.on('warning', (warning) => console.warn('pg-boss warning', warning))
await boss.start()
const durable = new PgBossJobQueue(boss)
await durable.initialize()

const batch = new BatchClient({ region: config.AWS_REGION })
const compute = new AwsBatchComputeExecutor(batch, config.BATCH_JOB_QUEUE, {
  'pgn-import': config.BATCH_IMPORT_JOB_DEFINITION,
  stockfish: config.BATCH_STOCKFISH_JOB_DEFINITION,
  scid: config.BATCH_SCID_JOB_DEFINITION,
  'data-refresh': config.BATCH_REFRESH_JOB_DEFINITION,
})

for (const workload of COMPUTE_WORKLOADS) {
  await boss.work(queueName(workload), {
    localConcurrency: workload === 'pgn-import' ? 4 : 1,
    batchSize: 1,
    pollingIntervalSeconds: 2,
    notifyPollingIntervalSeconds: 30,
    heartbeatRefreshSeconds: 45,
  }, async (jobs: Job<unknown>[]) => {
    const input = parseDurableJobPayload(jobs[0]?.data)
    if (input.workload !== workload) throw new Error('Queue workload does not match the signed job envelope')
    return { providerJobId: await compute.submit(input) }
  })
  await boss.work(deadLetterQueueName(workload), { localConcurrency: 1, batchSize: 1 }, async (jobs: Job<unknown>[]) => {
    const input = parseDurableJobPayload(jobs[0]?.data)
    console.error('compute dispatch exhausted retries', { workload, jobId: input.jobId })
    return { acknowledged: true }
  })
}

let stopping = false
async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.info('dispatcher stopping', { signal })
  await durable.close().catch((error) => console.error('dispatcher stop failed', error))
  batch.destroy()
}
process.once('SIGTERM', () => void stop('SIGTERM'))
process.once('SIGINT', () => void stop('SIGINT'))
