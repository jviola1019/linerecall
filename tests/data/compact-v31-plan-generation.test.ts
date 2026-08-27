import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { CompactV31ResourceLimitsSchema } from '../../scripts/data/compact-v31-contracts.ts'
import {
  generateCompactV31BenchmarkPlanBundle,
  writeCompactV31BenchmarkPlanBundle,
} from '../../scripts/data/generate-compact-v31-benchmark-plans.ts'

const proposalPath = 'build/data-readiness/broadcast-proposal-191600fe.json'
const observationPath = 'build/data-readiness/broadcast-observation-191600fe.json'

test('exact authorized observation produces 78 release-ineligible log-structured plans', {
  skip: !existsSync(proposalPath) || !existsSync(observationPath),
}, async () => {
  const bundle = generateCompactV31BenchmarkPlanBundle({
    proposalBytes: await readFile(proposalPath),
    observationBytes: await readFile(observationPath),
    authorizationBytes: await readFile('data/manifests/compact-v31-benchmark.authorization.json'),
    pipelineSourceSnapshotSha256: 'f'.repeat(64),
    generatedAt: '2026-08-27T12:00:00.000Z',
    limits: CompactV31ResourceLimitsSchema.parse(JSON.parse(
      await readFile('data/manifests/compact-v31-benchmark.limits.json', 'utf8'),
    ) as unknown),
  })
  assert.equal(bundle.plans.length, 78)
  assert.equal(bundle.review.archiveCount, 78)
  assert.equal(bundle.review.releaseEligible, false)
  assert.ok(bundle.plans.every((plan, index) =>
    plan.archiveOrdinal === index &&
    plan.storageModel === 'log-structured-external-merge-v3.1' &&
    plan.executionPurpose === 'benchmark-bootstrap' &&
    plan.releaseEligible === false))
  assert.equal(new Set(bundle.plans.map(({ configurationSha256 }) => configurationSha256)).size, 1)
  assert.equal(bundle.plans.reduce((sum, plan) => sum + plan.archive.compressedBytes, 0), 670_155_109)
})

test('plan generation rejects a one-byte proposal or authorization change', {
  skip: !existsSync(proposalPath) || !existsSync(observationPath),
}, async () => {
  const proposal = await readFile(proposalPath)
  const authorization = JSON.parse(
    await readFile('data/manifests/compact-v31-benchmark.authorization.json', 'utf8'),
  ) as Record<string, unknown>
  const observation = await readFile(observationPath)
  const limits = CompactV31ResourceLimitsSchema.parse(JSON.parse(
    await readFile('data/manifests/compact-v31-benchmark.limits.json', 'utf8'),
  ) as unknown)
  authorization.proposalSha256 = '0'.repeat(64)
  assert.throws(() => generateCompactV31BenchmarkPlanBundle({
    proposalBytes: proposal,
    observationBytes: observation,
    authorizationBytes: Buffer.from(JSON.stringify(authorization)),
    pipelineSourceSnapshotSha256: 'f'.repeat(64),
    generatedAt: '2026-08-27T12:00:00.000Z',
    limits,
  }), /does not bind/iu)
})

test('plan bundle publication is immutable and leaves no late-failure staging directory', {
  skip: !existsSync(proposalPath) || !existsSync(observationPath),
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-v31-plan-bundle-'))
  const bundle = generateCompactV31BenchmarkPlanBundle({
    proposalBytes: await readFile(proposalPath),
    observationBytes: await readFile(observationPath),
    authorizationBytes: await readFile('data/manifests/compact-v31-benchmark.authorization.json'),
    pipelineSourceSnapshotSha256: 'f'.repeat(64),
    generatedAt: '2026-08-27T12:00:00.000Z',
    limits: CompactV31ResourceLimitsSchema.parse(JSON.parse(
      await readFile('data/manifests/compact-v31-benchmark.limits.json', 'utf8'),
    ) as unknown),
  })
  const destination = join(root, 'plans')
  await writeCompactV31BenchmarkPlanBundle(destination, bundle)
  const entries = await readdir(destination)
  assert.equal(entries.length, 79)
  assert.ok(entries.includes('plan-review.json'))
  await assert.rejects(
    writeCompactV31BenchmarkPlanBundle(destination, bundle),
    /exist|directory|rename/iu,
  )
  assert.deepEqual((await readdir(root)).sort(), ['plans'])
})
