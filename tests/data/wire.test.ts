import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { gunzipSync } from 'node:zlib'
import { DataManifestSchema, OpeningPartitionSchema } from '../../src/domain/opening-data.ts'
import {
  WireAppManifestSchema,
  WireEvidenceShardSchema,
  WirePartitionSchema,
  WireSearchSnapshotSchema,
  hydrateParsedWirePartition,
} from '../../src/data/wire.ts'

async function gzipJson(path: string): Promise<unknown> {
  return JSON.parse(gunzipSync(await readFile(path)).toString('utf8')) as unknown
}

const generatedRoot = process.env.LINERECALL_REVIEW_FIXTURE_ROOT ?? 'build/review-data'
const generatedPath = (...parts: string[]): string => join(generatedRoot, ...parts)

async function a30Fixture() {
  const [search, audit, partition, auditedPartition] = await Promise.all([
    gzipJson(generatedPath('app-snapshot', 'search.json.gz')).then((value) => WireSearchSnapshotSchema.parse(value)),
    gzipJson(generatedPath('app-snapshot', 'audit.json.gz')).then((value) => DataManifestSchema.parse(value)),
    gzipJson(generatedPath('app-snapshot', 'partitions', 'A30.json.gz')).then((value) => WirePartitionSchema.parse(value)),
    gzipJson(generatedPath('release', 'partitions', 'A30.json.gz')).then((value) => OpeningPartitionSchema.parse(value)),
  ])
  const shards = await Promise.all(partition.s.map((shardId) =>
    gzipJson(generatedPath('app-snapshot', 'shards', `${shardId}.json.gz`))
      .then((value) => WireEvidenceShardSchema.parse(value))))
  const evidence = {
    positions: new Map(shards.flatMap((shard) => shard.p)),
    engines: new Map(shards.flatMap((shard) => shard.a)),
  }
  return { search, evidence, audit, partition, auditedPartition }
}

test('node-local analysis flags prevent shared-FEN evidence from changing audited semantics', async () => {
  const fixture = await a30Fixture()
  const variantId = 'tax_741e0a6bea28cf29dd226bff:white'
  const variant = fixture.partition.x.find((candidate) => candidate[0] === variantId)
  const wireNode = variant?.[6].find((candidate) => candidate[1] === 2)
  const wireMove = wireNode?.[5].find((candidate) => candidate[0] === 'e2e4')
  assert.ok(wireNode)
  assert.ok(wireMove)
  assert.equal(wireMove[1] & 1, 1, 'the alternative remains an accepted book transposition')
  assert.equal(wireMove[1] & 2, 0, 'this node did not independently analyze the alternative')
  const sharedEngineMove = fixture.evidence.engines.get(wireNode[2])?.[4].find((move) => move[0] === 'e2e4')
  assert.ok(sharedEngineMove)
  assert.notEqual(sharedEngineMove[1], null, 'another node populated the shared FEN cache')

  const hydrated = hydrateParsedWirePartition({
    search: fixture.search,
    evidence: fixture.evidence,
    partition: fixture.partition,
  })
  const hydratedMove = hydrated.verifiedLines
    .find((line) => line.id === variantId)?.nodes
    .find((node) => node.ply === 2)?.moves
    .find((move) => move.uci === 'e2e4')
  const auditedMove = fixture.auditedPartition.verifiedLines
    .find((line) => line.id === variantId)?.nodes
    .find((node) => node.ply === 2)?.moves
    .find((move) => move.uci === 'e2e4')
  assert.ok(hydratedMove)
  assert.deepEqual(hydratedMove, auditedMove)
  assert.equal(hydratedMove.independentlyEngineAnalyzed, false)
  assert.equal(hydratedMove.score, null)
  assert.equal(hydratedMove.centipawnLoss, null)
})

test('selected shards retain both-side terminal rates, detailed MultiPV, and exact provenance', async () => {
  const fixture = await a30Fixture()
  const hydrated = hydrateParsedWirePartition({
    search: fixture.search,
    evidence: fixture.evidence,
    partition: fixture.partition,
  })
  assert.deepEqual(
    hydrated.lines.map((line) => [line.terminalWhiteStats, line.terminalBlackStats]),
    fixture.auditedPartition.lines.map((line) => [line.terminalWhiteStats, line.terminalBlackStats]),
  )
  assert.deepEqual(
    hydrated.verifiedLines.flatMap((line) => line.nodes.map((node) => node.engine)),
    fixture.auditedPartition.verifiedLines.flatMap((line) => line.nodes.map((node) => node.engine)),
  )
  const auditProvenance = new Map(fixture.audit.provenance.map((entry) => [entry.id, entry]))
  for (const provenance of fixture.partition.r) {
    assert.deepEqual(provenance, auditProvenance.get(provenance.id))
  }
})

test('hydration rejects a partition outside its canonical catalog slice', async () => {
  const fixture = await a30Fixture()
  const corrupt = structuredClone(fixture.partition)
  corrupt.l[0]![0] += 1
  assert.throws(
    () => hydrateParsedWirePartition({
      search: fixture.search,
      evidence: fixture.evidence,
      partition: corrupt,
    }),
    /canonical catalog slice/u,
  )
})

test('search card metadata exactly covers drillable variants and rejects corrupt denominators', async () => {
  const fixture = await a30Fixture()
  assert.equal(fixture.search.x.length, fixture.audit.audit.drillableVariants)
  const expected = fixture.partition.x
    .filter((variant) => variant[3] === 1)
    .map((variant) => [variant[0], variant[1], variant[2], variant[6].length])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0]), 'en'))
  const actual = fixture.search.x.filter((summary) => fixture.search.l[summary[1]]?.[1] === 'A30')
  assert.deepEqual(actual, expected)
  for (const [variantId, sourceLineIndex, trainedSide, cardCount] of actual) {
    const source = fixture.search.l[sourceLineIndex]
    assert.ok(source)
    assert.equal(variantId, `${source[0]}:${trainedSide === 0 ? 'white' : 'black'}`)
    assert.ok(cardCount > 0)
  }

  const wrongCount = structuredClone(fixture.search)
  wrongCount.x[0]![3] += 1
  assert.equal(WireSearchSnapshotSchema.safeParse(wrongCount).success, false)
  const duplicate = structuredClone(fixture.search)
  duplicate.x[1] = [...duplicate.x[0]!]
  assert.equal(WireSearchSnapshotSchema.safeParse(duplicate).success, false)
  const wrongSideIdentity = structuredClone(fixture.search)
  wrongSideIdentity.x[0]![2] = wrongSideIdentity.x[0]![2] === 0 ? 1 : 0
  assert.equal(WireSearchSnapshotSchema.safeParse(wrongSideIdentity).success, false)
})

test('app manifest receipts are unique canonical relative POSIX paths', async () => {
  const manifest = WireAppManifestSchema.parse(
    JSON.parse(await readFile(generatedPath('app-snapshot', 'manifest.json'), 'utf8')) as unknown,
  )
  const paths = [
    ...Object.values(manifest.blobs),
    ...Object.values(manifest.shards),
    ...Object.values(manifest.partitions),
  ]
    .map((receipt) => receipt.path)
  assert.equal(paths.length, 2 + manifest.totals.shards + 500)
  assert.equal(new Set(paths).size, paths.length)
  assert.equal(paths.some((path) => /^(?:[A-Za-z]:|[\\/])|\\/u.test(path)), false)

  const corrupt = structuredClone(manifest)
  corrupt.blobs.search.path = 'C:/private/build/search.json.gz'
  assert.equal(WireAppManifestSchema.safeParse(corrupt).success, false)
})
