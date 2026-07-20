import { writeJsonAtomic } from './files.ts'

export type CheckStatus = 'pass' | 'fail' | 'not_run'

export interface CheckResult {
  id: string
  status: CheckStatus
  summary: string
  findings: ReadonlyArray<Record<string, unknown>>
  metrics?: Readonly<Record<string, number | string | boolean>>
}

export interface ToolReport {
  schemaVersion: 1
  tool: string
  generatedAt: string
  status: CheckStatus
  checks: readonly CheckResult[]
}

export function makeReport(tool: string, checks: readonly CheckResult[]): ToolReport {
  return {
    schemaVersion: 1,
    tool,
    generatedAt: new Date().toISOString(),
    status: checks.some((check) => check.status === 'fail')
      ? 'fail'
      : checks.some((check) => check.status === 'not_run')
        ? 'not_run'
        : 'pass',
    checks,
  }
}

export async function finishReport(path: string, report: ToolReport): Promise<never | void> {
  await writeJsonAtomic(path, report)
  process.stdout.write(`${report.tool}: ${report.status.toUpperCase()} (${path})\n`)
  for (const check of report.checks) {
    process.stdout.write(`  ${check.status.toUpperCase()} ${check.id}: ${check.summary}\n`)
  }
  if (report.status !== 'pass') process.exitCode = 1
}
