import { readFile } from 'node:fs/promises'
import { option, workspaceRelative } from '../security/lib/files.ts'
import { finishReport, makeReport } from '../security/lib/report.ts'
import {
  measureCriticalServerCoverage,
  type IstanbulCoverageMap,
} from './lib/istanbul-critical.ts'

const input = option('--input', 'server/coverage/critical/coverage-final.json')
const output = option('--output', 'audit/generated/server-critical-coverage.json')

let coverage: IstanbulCoverageMap | null = null
try {
  coverage = JSON.parse(await readFile(input, 'utf8')) as IstanbulCoverageMap
} catch (error) {
  await finishReport(output, makeReport('server-critical-coverage', [{
    id: 'security-sync-storage-per-file-coverage',
    status: 'fail',
    summary: 'The server Istanbul coverage report is missing or malformed',
    findings: [{ path: workspaceRelative(input), error: error instanceof Error ? error.message : String(error) }],
  }]))
}

if (coverage !== null) {
  const measured = measureCriticalServerCoverage(coverage)
  await finishReport(output, makeReport('server-critical-coverage', [{
    id: 'security-sync-storage-per-file-coverage',
    status: measured.findings.length === 0 ? 'pass' : 'fail',
    summary: measured.findings.length === 0
      ? 'Every security-critical, sync, scheduling, provider, and storage module has at least 90% branch and function coverage'
      : `${measured.findings.length} per-file server coverage finding(s); aggregate coverage is not accepted as a substitute`,
    findings: measured.findings,
    metrics: {
      requiredFiles: measured.metrics.length,
      filesAtBranchThreshold: measured.metrics.filter(({ branchPercent }) => branchPercent >= 90).length,
      filesAtFunctionThreshold: measured.metrics.filter(({ functionPercent }) => functionPercent >= 90).length,
    },
  }]))
}
