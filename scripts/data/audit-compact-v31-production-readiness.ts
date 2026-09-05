#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { freemem } from 'node:os'
import { access, mkdir, readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CompactV31PlanReviewSchema, CompactV31RunReceiptSchema } from './compact-v31-contracts.ts'
import {
  CompactV31ProductionAuthorizationSchema,
  CompactV31ProductionPlanReviewSchema,
  evaluateCompactV31ProductionReadiness,
} from './compact-v31-production-contracts.ts'
import { auditCompactV31ProductionCorpusChain } from './compact-v31-production-chain-audit.ts'
import { createIngestionSourceSnapshot } from './ingestion-source-snapshot.ts'

const PROPOSAL_SHA256 = 'c598a637c729be22a61583345b33589f462f1fb07294ef53678f0ecc85e857d5'
const OBSERVATION_SHA256 = '043b06dfd1fdf6adee65b1e1d29e18a561c0a046c4d6a5dd124aeb138465d56c'
const proposalPath = resolve(`data/manifests/compact-v31/bootstrap/broadcast-proposal-${PROPOSAL_SHA256}.json`)
const observationPath = resolve(`data/manifests/compact-v31/bootstrap/broadcast-observation-${OBSERVATION_SHA256}.json`)

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
  return resolve(value)
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function exactHash(path: string, expected: string): Promise<boolean> {
  try {
    const bytes = await readFile(path)
    return createHash('sha256').update(bytes).digest('hex') === expected
  } catch {
    return false
  }
}

async function completeBenchmarkRuns(campaignRoot: string): Promise<number> {
  let complete = 0
  for (const runDirectory of ['run-one', 'run-two']) {
    const runsRoot = join(campaignRoot, runDirectory, 'v31', 'runs')
    try {
      const entries = await readdir(runsRoot, { withFileTypes: true })
      if (entries.length !== 1 || !entries[0]!.isDirectory() || entries[0]!.isSymbolicLink()) continue
      CompactV31RunReceiptSchema.parse(await json(join(runsRoot, entries[0]!.name, 'receipt.json')))
      complete += 1
    } catch {
      // Missing, partial, linked, or invalid runs remain incomplete.
    }
  }
  return complete
}

async function validBenchmarkPlans(plansDirectory: string): Promise<boolean> {
  try {
    const entries = await readdir(plansDirectory, { withFileTypes: true })
    if (entries.length !== 79 || entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) return false
    const review = CompactV31PlanReviewSchema.parse(await json(join(plansDirectory, 'plan-review.json')))
    const snapshot = await createIngestionSourceSnapshot()
    return review.plans.length === 78 && review.sourceSnapshotSha256 === snapshot.treeSha256
  } catch {
    return false
  }
}

async function validProductionPlans(root: string): Promise<boolean> {
  try {
    const broadcast = CompactV31ProductionPlanReviewSchema.parse(await json(join(root, 'broadcast', 'plan-review.json')))
    const q2 = CompactV31ProductionPlanReviewSchema.parse(await json(join(root, 'standard-q2-2026', 'plan-review.json')))
    return broadcast.corpus === 'lichess-broadcasts' && q2.corpus === 'lichess-standard-rated-q2-2026'
  } catch {
    return false
  }
}

async function validCorpusReceipt(path: string, expected: 'lichess-broadcasts' | 'lichess-standard-rated-q2-2026'): Promise<boolean> {
  try {
    const root = resolve('.')
    const absolute = resolve(path)
    const rel = relative(root, absolute)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false
    const bytes = await readFile(absolute)
    const details = await stat(absolute)
    if (!details.isFile() || details.size !== bytes.byteLength) return false
    const audit = await auditCompactV31ProductionCorpusChain({
      root,
      corpusReceipt: {
        path: rel.replaceAll('\\', '/'),
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    })
    return audit.receipt.corpus === expected
  } catch { return false }
}

async function main(): Promise<void> {
  const output = option('--output', 'audit/generated/compact-v31-production-readiness.json')
  const plansDirectory = option('--benchmark-plans', 'build/data-readiness/compact-v31-plans')
  const campaignRoot = option('--campaign-root', 'build/data-readiness/compact-v31-campaign')
  const productionPlansRoot = option('--production-plans', 'data/generated/v31/production-plans')
  const productionRoot = option('--production-root', 'data/generated/v31/production')
  const authorizationPath = resolve('data/manifests/compact-v31-production.authorization.json')
  let authorizationDecision: 'missing' | 'pending' | 'approved' | 'invalid' = 'missing'
  let limits: unknown = JSON.parse(await readFile('data/manifests/compact-v31-benchmark.limits.json', 'utf8')) as unknown
  if (await exists(authorizationPath)) {
    try {
      const authorization = CompactV31ProductionAuthorizationSchema.parse(await json(authorizationPath))
      authorizationDecision = authorization.decision
      limits = authorization.limits
    } catch {
      authorizationDecision = 'invalid'
    }
  }
  const puzzleIntegrity = await json('data/manifests/lichess-puzzles.integrity.json') as {
    approval?: { status?: unknown }
  }
  const editorial = await json('data/manifests/opening-family-editorial.proposal.json') as {
    editorialStatus?: unknown
    promotionEligible?: unknown
    decisions?: Array<{ decision?: unknown }>
  }
  const packageJson = await json('package.json') as { scripts?: Record<string, unknown> }
  const productionChainSource = await readFile('scripts/data/compact-v31-production-chain-audit.ts', 'utf8')
  const releaseGates = await json('config/release-gates.json') as {
    automated?: Array<{ id?: unknown; command?: unknown; args?: unknown }>
  }
  const q2AdaptiveApproval = await json('data/manifests/compact-v31-q2-adaptive-replay.authorization.json') as {
    decision?: unknown
  }
  const filesystem = await statfs(resolve('.'), { bigint: true })
  const freeStorage = filesystem.bavail * filesystem.bsize
  if (freeStorage > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Available storage exceeds the safe integer range')
  const facts = {
    authorizationDecision,
    exactBootstrapInputsPresent:
      await exactHash(proposalPath, PROPOSAL_SHA256) && await exactHash(observationPath, OBSERVATION_SHA256),
    benchmarkPlansPresent: await validBenchmarkPlans(plansDirectory),
    benchmarkRunCount: await completeBenchmarkRuns(campaignRoot),
    repeatabilityBindingPresent: await exists(join(campaignRoot, 'benchmark-repeatability.json')),
    productionPlanReviewsPresent: await validProductionPlans(productionPlansRoot),
    broadcastCorpusReceiptPresent: await validCorpusReceipt(
      join(productionRoot, 'broadcast-corpus-receipt.json'), 'lichess-broadcasts',
    ),
    standardQ2CorpusReceiptPresent: await validCorpusReceipt(
      join(productionRoot, 'standard-q2-2026-corpus-receipt.json'), 'lichess-standard-rated-q2-2026',
    ),
    productionCohortOrchestratorImplemented: await exists(resolve('scripts/data/compact-v31-production-executor.ts')),
    productionArchiveAdapterImplemented: await exists(resolve('scripts/data/compact-v31-production-archive-adapter.ts')),
    deterministicMergeVerifierImplemented:
      productionChainSource.includes('verifyCompactV31ExactMergePartition') &&
      productionChainSource.includes('Exact merge receipt row accounting differs from independently merged delta bytes'),
    productionHandoffImplemented: await exists(resolve('scripts/data/compact-v31-family-handoff.ts')),
    productionCandidateUsesAppWireV3:
      typeof packageJson.scripts?.['build:production-candidate'] === 'string' &&
      packageJson.scripts['build:production-candidate'].includes('data:embed-production') &&
      releaseGates.automated?.some((step) => step.id === 'candidate-build' && step.command === 'npm' &&
        Array.isArray(step.args) && JSON.stringify(step.args) === JSON.stringify(['run', 'build:production-candidate'])) === true,
    familyEligibilityInventoryPresent: await exists(resolve('data/generated/v31/family-eligibility-index.json')),
    q2AdaptivePly100Authorized: q2AdaptiveApproval.decision === 'approved',
    familyPromotionPresent: await exists(resolve('data/generated/v31/family-promotion-index.json')),
    stockfishProvisionPresent: await exists(resolve('.cache/stockfish/sf_18/provision-win32-x64.json')) &&
      await exists(resolve('.cache/stockfish/sf_18/extracted/win32-x64/stockfish/stockfish-windows-x86-64.exe')),
    scidProvisionPresent: await exists(resolve('.cache/scid/8ffd1e3a02b9f61b5616e38b18ce932b904e04ff/provision.json')) &&
      await exists(resolve('.cache/scid/8ffd1e3a02b9f61b5616e38b18ce932b904e04ff/scid.eco')),
    puzzleDigestApproved: puzzleIntegrity.approval?.status === 'approved',
    puzzlePromotionPresent: await exists(resolve('data/generated/v31/puzzle-promotion.json')),
    editorialLedgerApproved: editorial.editorialStatus === 'approved' && editorial.promotionEligible === true &&
      Array.isArray(editorial.decisions) && editorial.decisions.length === 149 &&
      editorial.decisions.every(({ decision }) => decision !== 'pending'),
    availableMemoryBytes: freemem(),
    workerResidentBytes: process.memoryUsage().rss,
    availableStorageBytes: Number(freeStorage),
    limits,
  }
  const result = evaluateCompactV31ProductionReadiness(facts)
  const report = {
    schemaVersion: 1,
    kind: 'linerecall-compact-v31-production-readiness-audit',
    observedAt: new Date().toISOString(),
    releaseEligible: false,
    status: result.status,
    facts,
    blockers: result.blockers,
    note: 'Presence is not promotion. Corpus totals remain absent until authenticated production receipts exist.',
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  process.stdout.write(`${JSON.stringify({ output, status: result.status, blockerCount: result.blockers.length }, null, 2)}\n`)
  if (result.status === 'blocked') process.exitCode = 2
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => {
    process.stderr.write(`Compact-v3.1 production readiness audit failed: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
