import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  collectFiles,
  fileExists,
  option,
  workspaceRelative,
  workspaceRoot,
} from '../security/lib/files.ts'
import { finishReport, makeReport, type CheckResult } from '../security/lib/report.ts'

interface LcovFile {
  path: string
  linesFound: number
  linesHit: number
  functionsFound: number
  functionsHit: number
  branchesFound: number
  branchesHit: number
}

function percent(hit: number, found: number): number {
  return found === 0 ? 100 : (hit / found) * 100
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll('\\', '/')
  const sourceIndex = normalized.lastIndexOf('/src/')
  if (sourceIndex >= 0) return normalized.slice(sourceIndex + 1)
  return normalized.replace(/^\.\//u, '')
}

function parseLcov(source: string): LcovFile[] {
  const files: LcovFile[] = []
  let current: Partial<LcovFile> | null = null
  for (const line of source.split(/\r?\n/u)) {
    if (line.startsWith('SF:')) current = { path: normalizePath(line.slice(3)) }
    else if (current && line.startsWith('LF:')) current.linesFound = Number(line.slice(3))
    else if (current && line.startsWith('LH:')) current.linesHit = Number(line.slice(3))
    else if (current && line.startsWith('FNF:')) current.functionsFound = Number(line.slice(4))
    else if (current && line.startsWith('FNH:')) current.functionsHit = Number(line.slice(4))
    else if (current && line.startsWith('BRF:')) current.branchesFound = Number(line.slice(4))
    else if (current && line.startsWith('BRH:')) current.branchesHit = Number(line.slice(4))
    else if (line === 'end_of_record' && current?.path) {
      files.push({
        path: current.path,
        linesFound: current.linesFound ?? 0,
        linesHit: current.linesHit ?? 0,
        functionsFound: current.functionsFound ?? 0,
        functionsHit: current.functionsHit ?? 0,
        branchesFound: current.branchesFound ?? 0,
        branchesHit: current.branchesHit ?? 0,
      })
      current = null
    }
  }
  return files
}

function combined(files: readonly LcovFile[]): Omit<LcovFile, 'path'> {
  return files.reduce<Omit<LcovFile, 'path'>>((total, file) => ({
    linesFound: total.linesFound + file.linesFound,
    linesHit: total.linesHit + file.linesHit,
    functionsFound: total.functionsFound + file.functionsFound,
    functionsHit: total.functionsHit + file.functionsHit,
    branchesFound: total.branchesFound + file.branchesFound,
    branchesHit: total.branchesHit + file.branchesHit,
  }), { linesFound: 0, linesHit: 0, functionsFound: 0, functionsHit: 0, branchesFound: 0, branchesHit: 0 })
}

function mergeBySource(...groups: readonly LcovFile[][]): LcovFile[] {
  const merged = new Map<string, LcovFile>()
  for (const file of groups.flat()) {
    const current = merged.get(file.path)
    if (!current) {
      merged.set(file.path, { ...file })
      continue
    }
    // Both runners instrument the same TypeScript source differently. Taking
    // the maximum hit and found counts per metric is a conservative union when
    // a source is exercised by both suites: it never adds duplicate records or
    // sums the same branch twice.
    const linesFound = Math.max(current.linesFound, file.linesFound)
    const functionsFound = Math.max(current.functionsFound, file.functionsFound)
    const branchesFound = Math.max(current.branchesFound, file.branchesFound)
    merged.set(file.path, {
      path: file.path,
      linesFound,
      linesHit: Math.min(linesFound, Math.max(current.linesHit, file.linesHit)),
      functionsFound,
      functionsHit: Math.min(functionsFound, Math.max(current.functionsHit, file.functionsHit)),
      branchesFound,
      branchesHit: Math.min(branchesFound, Math.max(current.branchesHit, file.branchesHit)),
    })
  }
  return [...merged.values()].sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

const criticalPaths = [
  'src/domain/board-transition.ts',
  'src/domain/board.ts',
  'src/domain/deviation.ts',
  'src/domain/family-catalog-summary.ts',
  'src/domain/family-coverage-scope.ts',
  'src/domain/family-training-journal.ts',
  'src/domain/graph-training-session.ts',
  'src/domain/input-validation.ts',
  'src/domain/opening-family.ts',
  'src/domain/progress.ts',
  'src/domain/puzzle-progress.ts',
  'src/domain/repertoire.ts',
  'src/domain/tactical-puzzles.ts',
  'src/domain/training-session.ts',
  'src/infrastructure/progress-repository.ts',
]

async function criticalCheck(path: string): Promise<CheckResult> {
  if (!(await fileExists(path))) {
    return {
      id: 'critical-domain-branch-coverage',
      status: 'fail',
      summary: 'Critical-domain Node test LCOV is missing',
      findings: [{ path: workspaceRelative(path) }],
    }
  }
  const files = parseLcov(await readFile(path, 'utf8'))
  const byPath = new Map(files.map((file) => [file.path, file]))
  const findings: Array<Record<string, unknown>> = []
  for (const required of criticalPaths) {
    const file = byPath.get(required)
    if (!file) {
      findings.push({ rule: 'critical-file-missing', path: required })
      continue
    }
    const branchPercent = percent(file.branchesHit, file.branchesFound)
    const functionPercent = percent(file.functionsHit, file.functionsFound)
    if (branchPercent < 90) findings.push({ rule: 'critical-branch-below-90', path: required, branchPercent })
    if (functionPercent < 90) findings.push({ rule: 'critical-function-below-90', path: required, functionPercent })
  }
  const totals = combined(criticalPaths.flatMap((pathName) => byPath.get(pathName) ?? []))
  const perFileBranchMetrics = Object.fromEntries(criticalPaths.map((pathName) => {
    const file = byPath.get(pathName)
    return [`branchPercent:${pathName}`, file ? Number(percent(file.branchesHit, file.branchesFound).toFixed(2)) : 0]
  }))
  const perFileFunctionMetrics = Object.fromEntries(criticalPaths.map((pathName) => {
    const file = byPath.get(pathName)
    return [`functionPercent:${pathName}`, file ? Number(percent(file.functionsHit, file.functionsFound).toFixed(2)) : 0]
  }))
  return {
    id: 'critical-domain-branch-coverage',
    status: findings.length === 0 ? 'pass' : 'fail',
    summary: findings.length === 0 ? 'Every critical chess/transition/graph/SRS/storage module has at least 90% branch and function coverage' : `${findings.length} critical coverage finding(s)`,
    findings,
    metrics: {
      files: criticalPaths.length,
      linesPercent: Number(percent(totals.linesHit, totals.linesFound).toFixed(2)),
      functionsPercent: Number(percent(totals.functionsHit, totals.functionsFound).toFixed(2)),
      branchesPercent: Number(percent(totals.branchesHit, totals.branchesFound).toFixed(2)),
      ...perFileBranchMetrics,
      ...perFileFunctionMetrics,
    },
  }
}

async function overallCheck(componentPath: string, criticalPath: string): Promise<CheckResult> {
  const missingReports = []
  if (!(await fileExists(componentPath))) missingReports.push(workspaceRelative(componentPath))
  if (!(await fileExists(criticalPath))) missingReports.push(workspaceRelative(criticalPath))
  if (missingReports.length > 0) {
    return {
      id: 'overall-runtime-coverage',
      status: 'fail',
      summary: 'The merged domain plus component/UI LCOV set is incomplete; overall coverage is not claimed',
      findings: missingReports.map((path) => ({ rule: 'coverage-report-missing', path })),
    }
  }
  const files = mergeBySource(
    parseLcov(await readFile(criticalPath, 'utf8')),
    parseLcov(await readFile(componentPath, 'utf8')),
  )
  const byPath = new Map(files.map((file) => [file.path, file]))
  const runtimeFiles = (await collectFiles(['src'], { extensions: new Set(['.ts', '.tsx']) }))
    .map(workspaceRelative)
    .filter((pathName) => !pathName.endsWith('.d.ts') && !pathName.startsWith('src/generated/'))
  const missing = runtimeFiles.filter((pathName) => !byPath.has(pathName))
  const totals = combined(files.filter((file) => file.path.startsWith('src/')))
  const linePercent = percent(totals.linesHit, totals.linesFound)
  const functionPercent = percent(totals.functionsHit, totals.functionsFound)
  const branchPercent = percent(totals.branchesHit, totals.branchesFound)
  const findings: Array<Record<string, unknown>> = missing.map((pathName) => ({ rule: 'runtime-file-not-instrumented', path: pathName }))
  if (linePercent < 80 || functionPercent < 80 || branchPercent < 80) {
    findings.push({ rule: 'overall-below-80', linePercent, functionPercent, branchPercent })
  }
  return {
    id: 'overall-runtime-coverage',
    status: findings.length === 0 ? 'pass' : 'fail',
    summary: findings.length === 0 ? 'Merged domain and component/UI coverage represents all runtime source at 80% or better' : `${findings.length} merged overall coverage finding(s); UI coverage is not claimed`,
    findings,
    metrics: {
      runtimeFiles: runtimeFiles.length,
      instrumentedRuntimeFiles: runtimeFiles.length - missing.length,
      linesPercent: Number(linePercent.toFixed(2)),
      functionsPercent: Number(functionPercent.toFixed(2)),
      branchesPercent: Number(branchPercent.toFixed(2)),
    },
  }
}

const critical = option('--critical', 'coverage/domain.lcov')
const component = option('--component', 'coverage/component/lcov.info')
const output = option('--output', 'audit/generated/coverage.json')
await finishReport(output, makeReport('coverage-gate', [await criticalCheck(critical), await overallCheck(component, critical)]))
