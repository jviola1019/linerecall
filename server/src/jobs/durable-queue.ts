import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { Db, Queue } from 'pg-boss'

export const COMPUTE_WORKLOADS = ['pgn-import', 'stockfish', 'scid', 'data-refresh'] as const
export type ComputeWorkload = (typeof COMPUTE_WORKLOADS)[number]

const JobPayloadSchema = z.object({
  jobId: z.uuid(),
  workload: z.enum(COMPUTE_WORKLOADS),
  objectKey: z.string().min(1).max(1_024).regex(/^(private\/imports|staging)\/[A-Za-z0-9/_-]+$/),
}).strict()

export type DurableJobPayload = z.infer<typeof JobPayloadSchema>

interface BossClient {
  createQueue(name: string, options?: Omit<Queue, 'name'>): Promise<void>
  updateQueue(name: string, options?: Omit<Queue, 'name'>): Promise<void>
  send(name: string, data?: object | null, options?: Record<string, unknown>): Promise<string | null>
  stop(options?: { graceful?: boolean; timeout?: number; wait?: boolean }): Promise<void>
}

export interface TransactionalJobQueue {
  enqueue(client: PoolClient, input: DurableJobPayload): Promise<void>
}

export const queueName = (workload: ComputeWorkload): string => `linerecall-${workload}`
export const deadLetterQueueName = (workload: ComputeWorkload): string => `${queueName(workload)}-dead-letter`

const queueOptions = (workload: ComputeWorkload): Omit<Queue, 'name'> => ({
  policy: 'standard',
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
  expireInSeconds: workload === 'data-refresh' ? 21_600 : 3_600,
  retentionSeconds: 1_209_600,
  deleteAfterSeconds: 604_800,
  heartbeatSeconds: 120,
  deadLetter: deadLetterQueueName(workload),
  warningQueueSize: 1_000,
  notify: true,
})

function transactionDatabase(client: PoolClient): Db {
  return {
    async executeSql(text, values) {
      const result = await client.query(text, values)
      return { rows: result.rows }
    },
  }
}

export class PgBossJobQueue implements TransactionalJobQueue {
  constructor(private readonly boss: BossClient) {}

  async initialize(): Promise<void> {
    for (const workload of COMPUTE_WORKLOADS) {
      await this.boss.createQueue(deadLetterQueueName(workload), {
        policy: 'standard',
        retentionSeconds: 2_592_000,
        deleteAfterSeconds: 0,
        warningQueueSize: 1,
        notify: true,
      })
      const options = queueOptions(workload)
      await this.boss.createQueue(queueName(workload), options)
      await this.boss.updateQueue(queueName(workload), options)
    }
  }

  async enqueue(client: PoolClient, candidate: DurableJobPayload): Promise<void> {
    const input = JobPayloadSchema.parse(candidate)
    const id = await this.boss.send(queueName(input.workload), input, {
      id: input.jobId,
      singletonKey: input.jobId,
      db: transactionDatabase(client),
    })
    if (!id) throw new Error('Durable queue rejected the job')
  }

  async close(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 15_000 })
  }
}

export function parseDurableJobPayload(value: unknown): DurableJobPayload {
  return JobPayloadSchema.parse(value)
}
