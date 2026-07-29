import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  COMPACT_MINIMUM_FREE_RESERVE_BYTES,
  COMPACT_STORAGE_MODEL,
  CompactArchiveCheckpointSchema,
  CompactPreflightPlanSchema,
  type CompactPreflightPlan,
} from '../../scripts/data/compact-v3-contracts.ts'
import { receiptDigest } from '../../scripts/data/compact-v3-foundation.ts'
import {
  compactRetainedStateBytes,
  ensureSecureCompactWorkDirectory,
  readBoundedRegularFile,
  readVerifiedCompactCheckpoint,
  removeFileIfUnchanged,
  runCompactArchivePass,
  syncCompactParentDirectory,
  withValidatedRegularFile,
  type CompactArchivePassOptions,
  type CompactCandidatePassSummary,
  type CompactExactPassSummary,
} from '../../scripts/data/compact-v3-orchestrator.ts'

const fixtureBytes = Buffer.from('fixture compressed archive bytes\n', 'utf8')
const fixtureSha256 = createHash('sha256').update(fixtureBytes).digest('hex')

const bounds = {
  candidateSketchMaxBytes: 64,
  candidateIndexMaxBytes: 4_096,
  baselineShardMaxBytes: 4_096,
  adaptiveShardMaxBytes: 4_096,
  exactWorkMaxBytes: 4_096,
  checkpointMaxBytes: 8_192,
  atomicPromotionMaxBytes: 128,
  inputStagingMaxBytes: 0,
  retainedCorpusMaxBytes: 32_768,
}

const peakBound = Object.values(bounds).reduce((sum, value) => sum + value, 0)

function planFor(bytes: Buffer = fixtureBytes, sha256: string = fixtureSha256): CompactPreflightPlan {
  return CompactPreflightPlanSchema.parse({
    schemaVersion: 3,
    storageModel: COMPACT_STORAGE_MODEL,
    archive: {
      archiveId: 'fixture-standard-2026-04',
      sourceId: 'lichess-standard-rated-q2-2026',
      sourceManifestSha256: 'a'.repeat(64),
      licenseSpdxId: 'CC0-1.0',
      cutoff: '2026-06-30',
      month: '2026-04',
      filename: 'fixture-standard-2026-04.pgn.zst',
      url: 'https://database.lichess.org/standard/fixture-standard-2026-04.pgn.zst',
      compressedBytes: bytes.byteLength,
      sha256,
      retrievedAt: '2026-07-16T12:00:00.000Z',
      etagObserved: 'fixture-etag',
      lastModifiedObserved: 'Thu, 16 Jul 2026 12:00:00 GMT',
    },
    limits: {
      completeBaselineMaxPly: 30,
      adaptiveEvidenceMaxPly: 100,
      adaptiveCandidateMinimumSample: 100,
      archiveConcurrency: 1,
      minimumFreeReserveBytes: COMPACT_MINIMUM_FREE_RESERVE_BYTES,
      countMinWidth: 8,
      countMinDepth: 2,
      maximumCandidates: 1_000,
    },
    bounds,
    benchmark: {
      status: 'approved',
      method: 'complete-broadcast-replay-with-enforced-hard-caps',
      receiptSha256: 'b'.repeat(64),
      measuredAt: '2026-07-16T12:05:00.000Z',
      acceptedGames: 12,
      observations: 400,
      peakResidentBytes: 1_024,
      peakAdditionalStorageBytes: peakBound,
      note: 'Fixture-only approval used to test orchestration; it is not corpus release evidence.',
    },
  })
}

function candidateSummary(): CompactCandidatePassSummary {
  return {
    pass: 'candidate',
    priorCandidateStateSha256: null,
    recordsSeen: 4,
    accepted: 2,
    deduplicated: 1,
    rejected: { malformed_pgn: 1 },
    adaptiveObservationsSeen: 220,
    candidateRows: 2,
  }
}

function exactSummary(candidateReceiptSha256: string): CompactExactPassSummary {
  return {
    pass: 'exact',
    finalCandidateSetReceiptSha256: candidateReceiptSha256,
    recordsSeen: 4,
    accepted: 2,
    deduplicated: 1,
    rejected: { malformed_pgn: 1 },
    completeBaselineObservationsRetained: 40,
    adaptiveCandidateObservationsRetained: 12,
    adaptiveNoncandidateObservationsRejected: 3,
    normalizedPositionRows: 20,
    normalizedEdgeRows: 19,
  }
}

function clock(): () => Date {
  let tick = 0
  return () => new Date(Date.UTC(2026, 6, 16, 13, 0, tick++))
}

function baseOptions(
  directory: string,
  archivePath: string,
  plan: CompactPreflightPlan,
): Omit<CompactArchivePassOptions, 'pass' | 'process'> {
  return {
    plan,
    workDirectory: directory,
    openCompressedInput: () => createReadStream(archivePath),
    toolchain: {
      node: '24.4.1',
      chessJs: '1.4.0',
      zstd: 'fixture-identity-stream',
      sourceSnapshotSha256: 'c'.repeat(64),
    },
    outputExtension: 'bundle',
    availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound,
    now: clock(),
  }
}

async function consumeToOutput(
  context: Parameters<CompactArchivePassOptions['process']>[0],
): Promise<void> {
  for await (const chunk of context.input) await context.output.write(chunk)
}

test('compact work boundaries create private v3 and SQLite directories before pathname reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-private-boundary-'))
  try {
    const boundary = await ensureSecureCompactWorkDirectory(directory, { createAdapterWorking: true })
    assert.equal(boundary.workDirectory, directory)
    assert.equal(boundary.v3Directory, join(directory, 'v3'))
    assert.equal(boundary.adapterWorkingDirectory, join(directory, 'v3', '.adapter-working'))
    assert.equal(typeof await syncCompactParentDirectory(join(directory, 'v3', 'checkpoint.json')), 'boolean')
    if (process.platform !== 'win32') {
      assert.equal((await stat(boundary.v3Directory!)).mode & 0o077, 0)
      assert.equal((await stat(boundary.adapterWorkingDirectory!)).mode & 0o077, 0)
      assert.equal(boundary.windowsAclVerified, true)
    } else {
      assert.equal(boundary.windowsAclVerified, false)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('compact work boundaries reject writable POSIX roots and non-sticky writable parents', {
  skip: process.platform === 'win32',
}, async () => {
  const container = await mkdtemp(join(tmpdir(), 'linerecall-v3-unsafe-boundary-'))
  const unsafeParent = join(container, 'unsafe-parent')
  const nestedRoot = join(unsafeParent, 'work')
  try {
    await chmod(container, 0o777)
    await assert.rejects(
      ensureSecureCompactWorkDirectory(container),
      /must not be group- or world-writable/u,
    )
    await chmod(container, 0o700)
    const protectedBoundary = await ensureSecureCompactWorkDirectory(container)
    const unsafeNested = join(protectedBoundary.v3Directory!, 'unsafe-nested')
    await mkdir(unsafeNested, { mode: 0o777 })
    await assert.rejects(
      compactRetainedStateBytes(container),
      /Retained schema-v3 directory must not be group- or world-writable/u,
    )
    await rm(unsafeNested, { recursive: true, force: true })
    await mkdir(unsafeParent, { mode: 0o777 })
    await mkdir(nestedRoot, { mode: 0o700 })
    await assert.rejects(
      ensureSecureCompactWorkDirectory(nestedRoot),
      /writable non-sticky parent/u,
    )
  } finally {
    await chmod(container, 0o700).catch(() => undefined)
    await rm(container, { recursive: true, force: true })
  }
})

test('compact work boundaries reject a symbolic-link root', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-root-link-'))
  const target = join(directory, 'target')
  const linkedRoot = join(directory, 'linked-root')
  await mkdir(target, { mode: 0o700 })
  await symlink(target, linkedRoot, 'dir')
  try {
    await assert.rejects(
      ensureSecureCompactWorkDirectory(linkedRoot),
      /non-symbolic-link directory/u,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('validated compact files stay handle-bound and atomic removal preserves a changed pathname', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-handle-bound-'))
  const path = join(directory, 'evidence.json')
  const moved = join(directory, 'opened-evidence.json')
  const original = Buffer.from('approved evidence\n', 'utf8')
  const replacement = Buffer.from('replacement evidence\n', 'utf8')
  await writeFile(path, original)
  try {
    const observed = await withValidatedRegularFile(
      path,
      { label: 'Fixture evidence', maximumBytes: 1_024, minimumBytes: 1 },
      async ({ handle, size }) => {
        await rename(path, moved)
        await writeFile(path, replacement)
        const bytes = Buffer.alloc(size)
        const result = await handle.read(bytes, 0, size, 0)
        assert.equal(result.bytesRead, size)
        return bytes
      },
    )
    assert.deepEqual(observed, original)

    await assert.rejects(
      removeFileIfUnchanged(path, original, 1_024, 'Fixture evidence'),
      /changed before its atomic removal claim/u,
    )
    assert.deepEqual(await readFile(path), replacement)
    assert.deepEqual(await readBoundedRegularFile(path, 1_024, 'Fixture evidence', 1), replacement)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('validated compact files reject symbolic-link path entries where no-follow is supported', {
  skip: process.platform === 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-no-follow-'))
  const target = join(directory, 'target.json')
  const path = join(directory, 'evidence.json')
  await writeFile(target, 'approved evidence\n')
  await symlink(target, path, 'file')
  try {
    await assert.rejects(
      readBoundedRegularFile(path, 1_024, 'Fixture evidence', 1),
      /symbolic link|ELOOP/iu,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('candidate orchestration hashes input in-stream and commits content-addressed shard, receipt, then checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-orchestrator-'))
  const archivePath = join(directory, 'fixture.pgn.zst')
  await writeFile(archivePath, fixtureBytes)
  const plan = planFor()
  try {
    const result = await runCompactArchivePass({
      ...baseOptions(directory, archivePath, plan),
      pass: 'candidate',
      process: async (context) => {
        await consumeToOutput(context)
        return candidateSummary()
      },
    })
    assert.equal(result.status, 'promoted')
    assert.equal(result.receipt.pass, 'candidate')
    assert.equal(result.receipt.compressedInput.sha256, fixtureSha256)
    assert.equal(result.receipt.output.sha256, fixtureSha256)
    assert.equal(result.receipt.nextCandidateStateSha256, fixtureSha256)
    assert.equal(result.receiptSha256, receiptDigest(result.receipt))
    assert.match(result.receipt.output.path, new RegExp(`${fixtureSha256}\\.candidate\\.bundle$`, 'u'))

    const output = await readFile(join(directory, ...result.receipt.output.path.split('/')))
    assert.deepEqual(output, fixtureBytes)
    const receiptPath = join(
      directory,
      'v3',
      plan.archive.archiveId,
      'receipts',
      'sha256',
      `${result.receiptSha256}.json`,
    )
    const receiptBytes = await readFile(receiptPath)
    assert.equal(createHash('sha256').update(receiptBytes).digest('hex'), result.receiptSha256)
    const checkpoint = await readVerifiedCompactCheckpoint(directory, plan)
    assert.equal(checkpoint?.candidateReceipt?.output.sha256, fixtureSha256)
    assert.equal(checkpoint?.exactReceipt, null)

    let reopened = false
    const repeated = await runCompactArchivePass({
      ...baseOptions(directory, archivePath, plan),
      openCompressedInput: () => {
        reopened = true
        return createReadStream(archivePath)
      },
      pass: 'candidate',
      process: async () => {
        throw new Error('already committed work must not run')
      },
    })
    assert.equal(repeated.status, 'already-committed')
    assert.equal(reopened, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('exact pass requires candidate commit and preserves the candidate across a failed replay', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-exact-orchestration-'))
  const archivePath = join(directory, 'fixture.pgn.zst')
  await writeFile(archivePath, fixtureBytes)
  const plan = planFor()
  try {
    await assert.rejects(runCompactArchivePass({
      ...baseOptions(directory, archivePath, plan),
      pass: 'exact',
      process: async () => exactSummary('d'.repeat(64)),
    }), /before the candidate pass commits/u)

    const candidate = await runCompactArchivePass({
      ...baseOptions(directory, archivePath, plan),
      pass: 'candidate',
      process: async (context) => {
        await consumeToOutput(context)
        return candidateSummary()
      },
    })
    await assert.rejects(runCompactArchivePass({
      ...baseOptions(directory, archivePath, plan),
      pass: 'exact',
      process: async (context) => {
        await consumeToOutput(context)
        throw new Error('fixture parser failed')
      },
    }), /fixture parser failed/u)
    let checkpoint = await readVerifiedCompactCheckpoint(directory, plan)
    assert.equal(checkpoint?.candidateReceipt?.output.sha256, candidate.receipt.output.sha256)
    assert.equal(checkpoint?.exactReceipt, null)

    const exact = await runCompactArchivePass({
      ...baseOptions(directory, archivePath, plan),
      pass: 'exact',
      process: async (context) => {
        await consumeToOutput(context)
        return exactSummary(candidate.receiptSha256)
      },
    })
    assert.equal(exact.status, 'promoted')
    assert.equal(exact.receipt.pass, 'exact')
    checkpoint = await readVerifiedCompactCheckpoint(directory, plan)
    assert.equal(CompactArchiveCheckpointSchema.parse(checkpoint).exactReceipt?.pass, 'exact')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('checksum mismatch and partial consumption never promote output or checkpoint state', async () => {
  for (const scenario of ['checksum', 'partial'] as const) {
    const directory = await mkdtemp(join(tmpdir(), `linerecall-v3-${scenario}-`))
    const archivePath = join(directory, 'fixture.pgn.zst')
    await writeFile(archivePath, fixtureBytes)
    const plan = scenario === 'checksum' ? planFor(fixtureBytes, 'f'.repeat(64)) : planFor()
    try {
      await assert.rejects(runCompactArchivePass({
        ...baseOptions(directory, archivePath, plan),
        pass: 'candidate',
        process: async (context) => {
          if (scenario === 'checksum') await consumeToOutput(context)
          else {
            for await (const chunk of context.input) {
              await context.output.write(chunk.subarray(0, 4))
              break
            }
          }
          return candidateSummary()
        },
      }), scenario === 'checksum' ? /SHA-256 mismatch/u : /did not consume the complete/u)
      assert.equal(await readVerifiedCompactCheckpoint(directory, plan), null)
      const archiveDirectory = join(directory, 'v3', plan.archive.archiveId)
      const entries = await readdir(archiveDirectory, { recursive: true })
      assert.equal(entries.some((entry) => entry.endsWith('.bundle') || entry.endsWith('checkpoint.json')), false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
})

test('free-space preflight blocks before opening input and the staging sink fails closed at its byte cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-bounds-'))
  const archivePath = join(directory, 'fixture.pgn.zst')
  await writeFile(archivePath, fixtureBytes)
  const plan = planFor()
  try {
    let opened = false
    await assert.rejects(runCompactArchivePass({
      ...baseOptions(directory, archivePath, plan),
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + peakBound - 1,
      openCompressedInput: () => {
        opened = true
        return createReadStream(archivePath)
      },
      pass: 'candidate',
      process: async () => candidateSummary(),
    }), /insufficient-free-space/u)
    assert.equal(opened, false)

    await assert.rejects(runCompactArchivePass({
      ...baseOptions(directory, archivePath, plan),
      pass: 'candidate',
      process: async (context) => {
        for await (const chunk of context.input) await context.output.write(chunk)
        await context.output.write(Buffer.alloc(bounds.atomicPromotionMaxBytes))
        return candidateSummary()
      },
    }), /hard cap/u)
    assert.equal(await readVerifiedCompactCheckpoint(directory, plan), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('resume refuses a corrupted content-addressed shard instead of trusting checkpoint JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-corrupt-resume-'))
  const archivePath = join(directory, 'fixture.pgn.zst')
  await writeFile(archivePath, fixtureBytes)
  const plan = planFor()
  try {
    const candidate = await runCompactArchivePass({
      ...baseOptions(directory, archivePath, plan),
      pass: 'candidate',
      process: async (context) => {
        await consumeToOutput(context)
        return candidateSummary()
      },
    })
    await writeFile(join(directory, ...candidate.receipt.output.path.split('/')), 'corrupt')
    await assert.rejects(
      readVerifiedCompactCheckpoint(directory, plan),
      /content-addressed candidate shard is corrupt/iu,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('benchmark receipts are explicit and promotion cannot cross the corpus-wide retained-state cap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'linerecall-v3-retained-cap-'))
  const archivePath = join(directory, 'fixture.pgn.zst')
  await writeFile(archivePath, fixtureBytes)
  const approved = planFor()
  const plan = CompactPreflightPlanSchema.parse({
    ...approved,
    bounds: { ...approved.bounds, retainedCorpusMaxBytes: 1 },
    benchmark: {
      status: 'pending',
      method: 'complete-broadcast-replay-with-enforced-hard-caps',
      receiptSha256: null,
      measuredAt: null,
      acceptedGames: 0,
      observations: 0,
      peakResidentBytes: 0,
      peakAdditionalStorageBytes: 0,
      note: 'Fixture bootstrap is deliberately provisional.',
    },
  })
  const tightBound = Object.values(plan.bounds).reduce((sum, value) => sum + value, 0)
  try {
    await assert.rejects(runCompactArchivePass({
      ...baseOptions(directory, archivePath, plan),
      availableBytes: async () => COMPACT_MINIMUM_FREE_RESERVE_BYTES + tightBound,
      executionPurpose: 'benchmark-bootstrap',
      pass: 'candidate',
      process: async (context) => {
        await consumeToOutput(context)
        return candidateSummary()
      },
    }), /retained-state hard cap/iu)
    assert.equal(await readVerifiedCompactCheckpoint(directory, plan), null)
    const entries = await readdir(join(directory, 'v3', plan.archive.archiveId), { recursive: true })
    assert.equal(entries.some((entry) => entry.endsWith('.bundle') || entry.endsWith('checkpoint.json')), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
