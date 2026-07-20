import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parseVerifiedJson, validateVerifiedJson } from '../../src/data/verified-json.ts'
import {
  WireAppManifestSchema,
  WireEvidenceShardSchema,
  WirePartitionSchema,
  type WireEvidenceShard,
} from '../../src/data/wire.ts'

const RUNS = 5
const directory = 'data/generated/app-snapshot'
const manifest = WireAppManifestSchema.parse(
  JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as unknown,
)

const partitions = Object.entries(manifest.partitions).map(([eco, receipt]) => {
  const json = gunzipSync(readFileSync(join(directory, ...receipt.path.split('/')))).toString('utf8')
  const partition = WirePartitionSchema.parse(JSON.parse(json) as unknown)
  const shardCompressedBytes = partition.s.reduce((sum, shardId) => {
    const shardReceipt = manifest.shards[shardId]
    if (!shardReceipt) throw new Error(`Missing evidence shard receipt ${shardId}`)
    return sum + shardReceipt.compressedBytes
  }, 0)
  return { eco, json, partition, shardCompressedBytes }
})
const selected = partitions.reduce((maximum, candidate) =>
  candidate.shardCompressedBytes > maximum.shardCompressedBytes ? candidate : maximum)
const shardJson = selected.partition.s.map((shardId) => {
  const receipt = manifest.shards[shardId]
  if (!receipt) throw new Error(`Missing evidence shard receipt ${shardId}`)
  return gunzipSync(readFileSync(join(directory, ...receipt.path.split('/')))).toString('utf8')
})

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

function collectSample(): { milliseconds: number; positions: number; engines: number } {
  const started = performance.now()
  const partition = validateVerifiedJson(
    parseVerifiedJson(selected.json),
    (value) => WirePartitionSchema.parse(value),
  )
  const shards: WireEvidenceShard[] = shardJson.map((json) => validateVerifiedJson(
    parseVerifiedJson(json),
    (value) => WireEvidenceShardSchema.parse(value),
  ))
  assert.deepEqual(shards.map((shard) => shard.s).sort(), [...partition.s].sort())
  return {
    milliseconds: performance.now() - started,
    positions: shards.reduce((sum, shard) => sum + shard.p.length, 0),
    engines: shards.reduce((sum, shard) => sum + shard.a.length, 0),
  }
}

collectSample()
const samples = Array.from({ length: RUNS }, collectSample)
const durations = samples.map((sample) => sample.milliseconds)
const medianMs = median(durations)
const result = {
  snapshot: directory,
  selectedEco: selected.eco,
  shardCount: selected.partition.s.length,
  shardCompressedBytes: selected.shardCompressedBytes,
  positions: samples[0]!.positions,
  enginePositions: samples[0]!.engines,
  runs: RUNS,
  validationBoundary: 'JSON.parse capability plus strict Zod partition and evidence-shard schemas',
  milliseconds: {
    median: Math.round(medianMs * 100) / 100,
    minimum: Math.round(Math.min(...durations) * 100) / 100,
    maximum: Math.round(Math.max(...durations) * 100) / 100,
  },
  under500Ms: medianMs < 500,
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
if (medianMs >= 500) throw new Error('Selected-ECO evidence validation exceeds 500 ms')
