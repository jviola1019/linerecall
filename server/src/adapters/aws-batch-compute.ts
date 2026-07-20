import { BatchClient, SubmitJobCommand } from '@aws-sdk/client-batch'
import type { ComputeExecutor } from '../infrastructure/ports.js'

export class AwsBatchComputeExecutor implements ComputeExecutor {
  constructor(
    private readonly client: BatchClient,
    private readonly jobQueue: string,
    private readonly definitions: Readonly<Record<'pgn-import' | 'stockfish' | 'scid' | 'data-refresh', string>>,
  ) {}

  async submit(input: { jobId: string; workload: 'pgn-import' | 'stockfish' | 'scid' | 'data-refresh'; objectKey: string }): Promise<string> {
    if (!/^[0-9a-f-]{36}$/i.test(input.jobId)) throw new Error('Invalid compute job ID')
    const response = await this.client.send(new SubmitJobCommand({
      jobName: `linerecall-${input.workload}-${input.jobId}`.slice(0, 128),
      jobQueue: this.jobQueue,
      jobDefinition: this.definitions[input.workload],
      parameters: { jobId: input.jobId, objectKey: input.objectKey },
      retryStrategy: {
        attempts: 3,
        evaluateOnExit: [
          { onReason: 'Host EC2*', action: 'RETRY' },
          { onStatusReason: 'Task failed to start', action: 'RETRY' },
          { action: 'EXIT' },
        ],
      },
      timeout: { attemptDurationSeconds: 3600 },
      tags: { service: 'linerecall', workload: input.workload },
      propagateTags: true,
    }))
    if (!response.jobId) throw new Error('AWS Batch did not return a job identifier')
    return response.jobId
  }
}

export class LocalNoopComputeExecutor implements ComputeExecutor {
  async submit(): Promise<string> {
    // Local imports remain honestly queued; no analysis result is fabricated.
    return 'local-noop-unsubmitted'
  }
}
