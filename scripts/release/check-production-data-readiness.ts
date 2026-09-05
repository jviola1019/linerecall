import { readFile } from 'node:fs/promises'
import { fileExists, option, sha256File, workspaceRelative } from '../security/lib/files.ts'
import { finishReport, makeReport } from '../security/lib/report.ts'
import {
  ProductionAppSnapshotManifestSchema,
  evaluateProductionDataReadiness,
} from './lib/production-data-readiness.ts'

const readinessPath = option('--readiness', 'data/generated/v3/production-data-readiness.json')
const appManifestPath = option('--app-manifest', 'data/generated/v3/app-snapshot-manifest.json')
const output = option('--output', 'audit/generated/production-data-readiness.json')
const missing = []
if (!(await fileExists(readinessPath))) missing.push(workspaceRelative(readinessPath))
if (!(await fileExists(appManifestPath))) missing.push(workspaceRelative(appManifestPath))

if (missing.length > 0) {
  const findings: Array<Record<string, unknown>> = missing.map((path) => ({ rule: 'required-production-data-file-missing', path }))
  if (await fileExists(appManifestPath)) {
    try {
      const appManifest = JSON.parse(await readFile(appManifestPath, 'utf8')) as unknown
      const productionManifest = ProductionAppSnapshotManifestSchema.safeParse(appManifest)
      if (!productionManifest.success) {
        findings.push({
          rule: 'legacy-or-invalid-app-snapshot',
          path: workspaceRelative(appManifestPath),
          summary: 'Production requires app-wire-v3 with all eligible audited branches and no hard practice-branch cap.',
        })
      }
    } catch (error) {
      findings.push({
        rule: 'app-snapshot-json-invalid',
        path: workspaceRelative(appManifestPath),
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  await finishReport(output, makeReport('production-data-readiness', [{
    id: 'evidence-complete-v3-production-data',
    status: 'fail',
    summary: 'Production v3 readiness evidence is incomplete; legacy review data cannot be promoted',
    findings,
  }]))
} else {
  let readiness: unknown
  let appManifest: unknown
  try {
    readiness = JSON.parse(await readFile(readinessPath, 'utf8')) as unknown
    appManifest = JSON.parse(await readFile(appManifestPath, 'utf8')) as unknown
  } catch (error) {
    await finishReport(output, makeReport('production-data-readiness', [{
      id: 'evidence-complete-v3-production-data',
      status: 'fail',
      summary: 'Production data evidence is not valid JSON',
      findings: [{ rule: 'production-data-json-invalid', error: error instanceof Error ? error.message : String(error) }],
    }]))
  }
  if (readiness !== undefined && appManifest !== undefined) {
    const findings = evaluateProductionDataReadiness(readiness, appManifest, await sha256File(appManifestPath))
    await finishReport(output, makeReport('production-data-readiness', [{
      id: 'evidence-complete-v3-production-data',
      status: findings.length === 0 ? 'pass' : 'fail',
      summary: findings.length === 0
        ? 'The complete v3 corpus, graph, engine, Scid, puzzle, and embedded-snapshot evidence is production eligible'
        : `${findings.length} production data readiness finding(s); the current build remains review-only`,
      findings,
    }]))
  }
}
