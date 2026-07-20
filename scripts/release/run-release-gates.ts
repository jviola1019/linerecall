import { spawn } from 'node:child_process'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  fileExists,
  option,
  sha256File,
  workspaceRelative,
  workspaceRoot,
  writeJsonAtomic,
} from '../security/lib/files.ts'
import {
  clearDefaultReleaseOutputs,
  defaultReleasePaths,
  readEvidence,
  readGateConfigAfterCleanup,
  type GateResult,
} from './lib/evidence-integrity.ts'
import {
  loadVerifiedReleaseBindings,
  type ReleaseBindings,
} from './lib/release-bindings.ts'

function tail(value: string, maximum = 3000): string {
  const stripped = value.replace(/\u001b\[[0-9;]*m/gu, '')
  return stripped.length <= maximum ? stripped : stripped.slice(-maximum)
}

function execute(command: string, args: readonly string[]): Promise<{ code: number; output: string; durationMs: number }> {
  return new Promise((resolveResult) => {
    const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    const executable = command === 'npm' ? process.execPath : command
    const effectiveArgs = command === 'npm' ? [npmCli, ...args] : [...args]
    const started = performance.now()
    const child = spawn(executable, effectiveArgs, {
      cwd: workspaceRoot,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    })
    const output: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk))
    child.once('error', (error) => resolveResult({
      code: 1,
      output: error instanceof Error ? error.message : String(error),
      durationMs: Math.round(performance.now() - started),
    }))
    child.once('close', (code) => resolveResult({
      code: code ?? 1,
      output: Buffer.concat(output).toString('utf8'),
      durationMs: Math.round(performance.now() - started),
    }))
  })
}

// Fail closed even if a malformed configuration cannot be parsed. These are
// the only production release paths supported by this repository.
await clearDefaultReleaseOutputs(workspaceRoot)
const configPath = option('--config', 'config/release-gates.json')
const config = await readGateConfigAfterCleanup(configPath, workspaceRoot)
const defaults = defaultReleasePaths(workspaceRoot)
const defaultArtifactPath = defaults.artifact
const defaultMarkerPath = defaults.marker
const defaultReportPath = defaults.report
const reportPath = resolve(workspaceRoot, config.report)
const markerPath = resolve(workspaceRoot, config.marker)
const candidatePath = resolve(workspaceRoot, config.candidate)
const artifactPath = resolve(workspaceRoot, config.artifact)
const reportOnly = process.argv.includes('--report-only')

for (const controlledPath of [candidatePath, artifactPath, markerPath, reportPath]) {
  const relative = controlledPath.slice(workspaceRoot.length)
  if (controlledPath === workspaceRoot || !relative.startsWith('\\') && !relative.startsWith('/')) {
    throw new Error(`Release path escapes the workspace: ${controlledPath}`)
  }
}
if (candidatePath === artifactPath) throw new Error('Candidate and release artifact paths must be different')
if (candidatePath !== resolve(workspaceRoot, 'build/candidate/linerecall.html')) {
  throw new Error('The release workflow may audit only build/candidate/linerecall.html')
}
if (artifactPath !== defaultArtifactPath || markerPath !== defaultMarkerPath) {
  throw new Error('The release workflow may promote only the controlled dist artifact and marker')
}
if (reportPath !== defaultReportPath) {
  throw new Error('The release workflow may write only the controlled release audit report')
}

// Prior release outputs never survive a fresh audit attempt. Only a passing
// audit may atomically promote the separately retained candidate into dist.
await rm(markerPath, { force: true })
await rm(artifactPath, { force: true })
await rm(reportPath, { force: true })

const automated: GateResult[] = []
for (const gate of config.automated) {
  if (reportOnly) {
    automated.push({ id: gate.id, status: 'not_run', summary: 'Skipped by --report-only' })
    continue
  }
  process.stdout.write(`Running ${gate.id}...\n`)
  const result = await execute(gate.command, gate.args)
  automated.push({
    id: gate.id,
    status: result.code === 0 ? 'pass' : 'fail',
    summary: result.code === 0 ? 'Command completed successfully' : `Command failed with exit code ${result.code}`,
    durationMs: result.durationMs,
    ...(result.code === 0 ? {} : { logTail: tail(result.output) }),
  })
}

const candidate = await fileExists(candidatePath)
  ? {
      path: workspaceRelative(candidatePath),
      bytes: (await stat(candidatePath)).size,
      sha256: await sha256File(candidatePath),
    }
  : null
const evidence: GateResult[] = []
for (const requirement of config.evidence) {
  evidence.push(await readEvidence(
    requirement.id,
    requirement.path,
    candidate?.sha256 ?? null,
    workspaceRoot,
    requirement.sourceSnapshot,
  ))
}

const blockers = [
  ...automated.filter((gate) => gate.status !== 'pass').map((gate) => `${gate.id}: ${gate.summary}`),
  ...evidence.filter((gate) => gate.status !== 'pass').map((gate) => `${gate.id}: ${gate.summary}`),
]
if (candidate === null) blockers.push(`candidate: ${config.candidate} is missing`)

let releaseBindings: ReleaseBindings | null = null
if (candidate !== null) {
  try {
    releaseBindings = await loadVerifiedReleaseBindings({
      root: workspaceRoot,
      configPath,
      config,
      automated,
      evidence,
      candidate: { bytes: candidate.bytes, sha256: candidate.sha256 },
    })
  } catch (error) {
    blockers.push(`release-bindings: ${error instanceof Error ? error.message : String(error)}`)
  }
}

type ArtifactReceipt = { path: string; bytes: number; sha256: string }

function releaseReport(artifact: ArtifactReceipt | null) {
  const shippable = blockers.length === 0 && artifact !== null && releaseBindings !== null
  return {
    schemaVersion: 2 as const,
    generatedAt: new Date().toISOString(),
    status: shippable ? 'pass' as const : 'fail' as const,
    shippable,
    candidate,
    artifact,
    automated,
    evidence,
    bindings: releaseBindings,
    blockers,
    limitations: config.limitations,
  }
}

let artifact: ArtifactReceipt | null = null
const temporaryArtifact = `${artifactPath}.${process.pid}.tmp`
try {
  if (blockers.length === 0 && candidate !== null && releaseBindings !== null) {
    await mkdir(dirname(artifactPath), { recursive: true })
    await rm(temporaryArtifact, { force: true })
    await copyFile(candidatePath, temporaryArtifact)
    await rename(temporaryArtifact, artifactPath)
    artifact = {
      path: workspaceRelative(artifactPath),
      bytes: (await stat(artifactPath)).size,
      sha256: await sha256File(artifactPath),
    }
    if (artifact.sha256 !== candidate.sha256 || artifact.bytes !== candidate.bytes) {
      throw new Error('Promoted artifact does not match the audited candidate')
    }

    // A marker is written only after the audit report is safely committed.
    const passingReport = releaseReport(artifact)
    await writeJsonAtomic(reportPath, passingReport)
    await writeJsonAtomic(markerPath, {
      schemaVersion: 3,
      shippable: true,
      releaseId: releaseBindings.releaseId,
      auditedAt: passingReport.generatedAt,
      artifact,
      report: workspaceRelative(reportPath),
      reportSha256: await sha256File(reportPath),
      bindings: {
        gateConfigSha256: releaseBindings.gateConfig.sha256,
        sourceSnapshotSha256: releaseBindings.sourceSnapshot.sha256,
        sourceTreeSha256: releaseBindings.sourceSnapshot.treeSha256,
        productionReadinessSha256: releaseBindings.productionReadiness.sha256,
        appSnapshotManifestSha256: releaseBindings.appSnapshotManifest.sha256,
        automatedGateStatusSha256: releaseBindings.automatedGateStatusSha256,
        preSigningEvidenceBundleSha256: releaseBindings.preSigningEvidenceBundleSha256,
        evidenceBundleSha256: releaseBindings.evidenceBundleSha256,
        signingAttestationSha256: releaseBindings.signingAttestation.sha256,
        signingPayloadSha256: releaseBindings.signingAttestation.payloadSha256,
        signingKeyId: releaseBindings.signingAttestation.keyId,
      },
    })
    process.stdout.write(`RELEASE GATES PASS: ${config.artifact} is marked shippable.\n`)
  } else {
    await writeJsonAtomic(reportPath, releaseReport(null))
  }
} catch (error) {
  blockers.push(`promotion: ${error instanceof Error ? error.message : String(error)}`)
  artifact = null
  await rm(markerPath, { force: true })
  await rm(artifactPath, { force: true })
  await writeJsonAtomic(reportPath, releaseReport(null))
} finally {
  await rm(temporaryArtifact, { force: true })
}

if (artifact === null || blockers.length > 0) {
  // Defense in depth: a failed run never leaves stale or partially promoted
  // release outputs, even if a future gate acquires a dist-side effect.
  await rm(markerPath, { force: true })
  await rm(artifactPath, { force: true })
  process.stderr.write(`RELEASE GATES FAIL: ${blockers.length} blocker(s). No shippable marker was created.\n`)
  process.exitCode = 1
}
