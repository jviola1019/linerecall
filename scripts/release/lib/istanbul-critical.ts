export interface IstanbulFileCoverage {
  path?: string
  s?: Record<string, number>
  f?: Record<string, number>
  b?: Record<string, number[]>
}

export type IstanbulCoverageMap = Record<string, IstanbulFileCoverage>

export interface CriticalCoverageMetric {
  path: string
  branchesFound: number
  branchesHit: number
  branchPercent: number
  functionsFound: number
  functionsHit: number
  functionPercent: number
}

export const CRITICAL_SERVER_PATHS = [
  'server/src/app.ts',
  'server/src/config.ts',
  'server/src/contracts.ts',
  'server/src/errors.ts',
  'server/src/family-training-contracts.ts',
  'server/src/ids.ts',
  'server/src/puzzle-record.ts',
  'server/src/adapters/aws-batch-compute.ts',
  'server/src/adapters/memory.ts',
  'server/src/adapters/postgres-repertoire-service.ts',
  'server/src/adapters/postgres-sync-store.ts',
  'server/src/adapters/redis-rate-limiter.ts',
  'server/src/adapters/s3-object-store.ts',
  'server/src/adapters/signed-s3-catalog.ts',
  'server/src/auth/better-auth.ts',
  'server/src/auth/ses-magic-link-sender.ts',
  'server/src/connections/kms-token-vault.ts',
  'server/src/connections/lichess-game-stream.ts',
  'server/src/connections/lichess-provider-gate.ts',
  'server/src/connections/lichess.ts',
  'server/src/domain/sm2.ts',
  'server/src/jobs/durable-queue.ts',
  'server/src/jobs/lichess-sync-worker-config.ts',
  'server/src/jobs/lichess-sync-worker-runtime.ts',
  'server/src/jobs/lichess-sync.ts',
] as const

function normalizedCoveragePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  const serverIndex = normalized.lastIndexOf('/server/src/')
  if (serverIndex >= 0) return normalized.slice(serverIndex + 1)
  return normalized.replace(/^\.\//u, '')
}

function percentage(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100
}

export function measureCriticalServerCoverage(
  coverage: IstanbulCoverageMap,
  requiredPaths: readonly string[] = CRITICAL_SERVER_PATHS,
): { metrics: CriticalCoverageMetric[]; findings: Array<Record<string, unknown>> } {
  const byPath = new Map(
    Object.entries(coverage).map(([key, value]) => [normalizedCoveragePath(value.path ?? key), value]),
  )
  const metrics: CriticalCoverageMetric[] = []
  const findings: Array<Record<string, unknown>> = []
  for (const path of requiredPaths) {
    const file = byPath.get(path)
    if (!file) {
      findings.push({ rule: 'critical-server-file-missing', path })
      continue
    }
    const branches = Object.values(file.b ?? {}).flat()
    const functions = Object.values(file.f ?? {})
    const branchesHit = branches.filter((value) => value > 0).length
    const functionsHit = functions.filter((value) => value > 0).length
    const metric: CriticalCoverageMetric = {
      path,
      branchesFound: branches.length,
      branchesHit,
      branchPercent: Number(percentage(branchesHit, branches.length).toFixed(2)),
      functionsFound: functions.length,
      functionsHit,
      functionPercent: Number(percentage(functionsHit, functions.length).toFixed(2)),
    }
    metrics.push(metric)
    if (metric.branchPercent < 90) {
      findings.push({ rule: 'critical-server-branch-below-90', path, branchPercent: metric.branchPercent })
    }
    if (metric.functionPercent < 90) {
      findings.push({ rule: 'critical-server-function-below-90', path, functionPercent: metric.functionPercent })
    }
  }
  return { metrics, findings }
}
