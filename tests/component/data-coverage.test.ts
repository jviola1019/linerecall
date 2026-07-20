// @vitest-environment jsdom

import { webcrypto } from 'node:crypto'
import { Blob as NodeBlob } from 'node:buffer'
import { DecompressionStream as NodeDecompressionStream } from 'node:stream/web'
import { gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import embeddedSnapshot from '../../src/generated/embedded-snapshot.json' with { type: 'json' }
import {
  EmbeddedOpeningDataSource,
  SnapshotDataError,
} from '../../src/data/embedded-opening-data-source.ts'
import type { EmbeddedSnapshotPayload } from '../../src/data/embedded-contract.ts'
import {
  WireAppManifestSchema,
  WireEvidenceShardSchema,
  WirePartitionSchema,
  WireSearchSnapshotSchema,
  hydrateParsedWirePartition,
  type WireEvidenceShard,
  type WirePartitionEvidence,
  type WirePartition,
  type WireSearchSnapshot,
} from '../../src/data/wire.ts'
import { TaxonomySourceManifestSchema } from '../../src/data/taxonomy-schema.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
Object.defineProperty(globalThis, 'Blob', { value: NodeBlob, configurable: true })
Object.defineProperty(globalThis, 'DecompressionStream', { value: NodeDecompressionStream, configurable: true })

const payload = embeddedSnapshot as EmbeddedSnapshotPayload

function inflateJson<T>(base64: string): T {
  return JSON.parse(gunzipSync(Buffer.from(base64, 'base64')).toString('utf8')) as T
}

let search: WireSearchSnapshot
let c20Shards: WireEvidenceShard[]
let c20: WirePartition

beforeAll(() => {
  search = inflateJson<WireSearchSnapshot>(payload.blobs.search.base64)
  c20 = inflateJson<WirePartition>(payload.partitions.C20!.base64)
  c20Shards = c20.s.map((shardId) => inflateJson<WireEvidenceShard>(payload.shards[shardId]!.base64))
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

function fixture(): {
  search: WireSearchSnapshot
  evidence: WirePartitionEvidence
  partition: WirePartition
} {
  const positions = new Map<number, WireEvidenceShard['p'][number][1]>()
  const engines = new Map<number, WireEvidenceShard['a'][number][1]>()
  for (const shard of c20Shards) {
    for (const [index, position] of shard.p) positions.set(index, structuredClone(position))
    for (const [index, engine] of shard.a) engines.set(index, structuredClone(engine))
  }
  return {
    search,
    evidence: { positions, engines },
    partition: structuredClone(c20),
  }
}

function firstNode(options: ReturnType<typeof fixture>) {
  const variant = options.partition.x[0]!
  const node = variant[6][0]!
  const engineIndex = node[2]
  const positionIndex = node[3]
  const engine = structuredClone(options.evidence.engines.get(engineIndex)!)
  const position = structuredClone(options.evidence.positions.get(positionIndex)!)
  ;(options.evidence.engines as Map<number, typeof engine>).set(engineIndex, engine)
  ;(options.evidence.positions as Map<number, typeof position>).set(positionIndex, position)
  return {
    variant,
    node,
    engine,
    position,
  }
}

function expectHydrationError(
  mutate: (options: ReturnType<typeof fixture>) => void,
  message: RegExp,
): void {
  const options = fixture()
  mutate(options)
  expect(() => hydrateParsedWirePartition(options)).toThrow(message)
}

describe('wire schema audit branches', () => {
  test('accepts the real snapshots and reports every search-index invariant', () => {
    expect(WireSearchSnapshotSchema.parse(search)).toBeTruthy()
    const invalid = structuredClone(search)
    invalid.l[1]![0] = invalid.l[0]![0]
    invalid.c[0]![0] = 'A01'
    invalid.c[1]![1] += 1
    invalid.l[invalid.c[2]![1]]![1] = 'A03'
    invalid.c.at(-1)![2] += 1
    const result = WireSearchSnapshotSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        'Search line IDs must be unique',
        'Expected catalog ECO A00',
        'Catalog slices must be contiguous',
        'Catalog slice contains the wrong ECO',
        'Catalog slices do not cover every search line',
      ]))
    }
  })

  test('accepts real evidence shards and reports duplicate evidence keys', () => {
    for (const shard of c20Shards) expect(WireEvidenceShardSchema.parse(shard)).toBeTruthy()
    const source = c20Shards.find((shard) =>
      shard.c.length > 1 && shard.p.some((entry) => entry[1][3].length > 0 && entry[1][4].length > 0) &&
      shard.a.some((entry) => entry[1][3].length > 0 && entry[1][4].length > 0))!
    expect(source).toBeTruthy()
    const invalid = structuredClone(source)
    invalid.c.reverse()
    invalid.c.push(invalid.c[0]!)
    invalid.p.push(structuredClone(invalid.p[0]!))
    invalid.p[0]![1][1] = [1, 1]
    invalid.p[0]![1][3].push(structuredClone(invalid.p[0]![1][3][0]!))
    invalid.p[0]![1][4].push(structuredClone(invalid.p[0]![1][4][0]!))
    invalid.a.push(structuredClone(invalid.a[0]!))
    invalid.a[0]![1][3].push(structuredClone(invalid.a[0]![1][3][0]!))
    invalid.a[0]![1][4].push(structuredClone(invalid.a[0]![1][4][0]!))
    const result = WireEvidenceShardSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        'Evidence shard consumers must be sorted',
        'Evidence shard consumers must be unique',
        'Evidence shard position indexes must be unique',
        'Evidence shard EPDs must be unique',
        'Position line indexes must be unique',
        'Position moves must be unique',
        'Book moves must be unique',
        'Evidence shard engine indexes must be unique',
        'Evidence shard engine FENs must be unique',
        'MultiPV ranks must be unique',
        'Engine moves must be unique',
      ]))
    }
  })

  test('accepts a real partition and reports all duplicate/reference invariants', () => {
    expect(WirePartitionSchema.parse(c20)).toBeTruthy()
    const invalid = structuredClone(c20)
    invalid.l.push(invalid.l[0]!)
    invalid.x.push(structuredClone(invalid.x[0]!))
    invalid.x[1]![0] = invalid.x[0]![0]
    invalid.x[1]![1] = 0
    invalid.x[1]![2] = invalid.x[0]![2]
    const nodes = invalid.x[0]![6]
    nodes.push(structuredClone(nodes[0]!))
    nodes[1]![5].push(structuredClone(nodes[1]![5][0]!))
    const result = WirePartitionSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        'Partition line indexes must be unique',
        'Variant IDs must be unique',
        'Line trained-side variants must be unique',
        'Variant line index is outside the partition',
        'Variant node IDs and plies must be unique',
        'Node moves must be unique',
      ]))
    }
  })

  test('reconciles the real app manifest and rejects combined receipt inconsistencies', () => {
    const manifest = JSON.parse(readFileSync('data/generated/app-snapshot/manifest.json', 'utf8')) as unknown
    expect(WireAppManifestSchema.parse(manifest)).toBeTruthy()
    const invalid = structuredClone(manifest) as Record<string, unknown> & {
      blobs: Record<string, { path: string }>
      partitions: Record<string, { path: string }>
      totals: { compressedBytes: number; estimatedBase64Bytes: number }
    }
    invalid.blobs.search!.path = 'audit.json.gz'
    delete invalid.partitions.E99
    invalid.partitions.A00!.path = invalid.partitions.A01!.path
    invalid.totals.compressedBytes += 1
    invalid.totals.estimatedBase64Bytes += 1
    const result = WireAppManifestSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        'Expected search.json.gz',
        'Expected 500 partition receipts',
        'Partition receipt path does not match its ECO',
        'Blob receipt paths must be unique',
        'Compressed byte total does not reconcile',
        'Base64 byte estimate does not reconcile',
      ]))
    }
  })

  test('validates the approved taxonomy source and catches every cross-file invariant', () => {
    const manifest = JSON.parse(readFileSync('data/manifests/taxonomy.source.json', 'utf8'))
    expect(TaxonomySourceManifestSchema.parse(manifest)).toBeTruthy()
    const invalid = structuredClone(manifest)
    invalid.files[1].volume = invalid.files[0].volume
    invalid.files[2].url = invalid.files[2].url.replace(invalid.source.commit, 'a'.repeat(40))
    invalid.format.expectedRows += 1
    const result = TaxonomySourceManifestSchema.safeParse(invalid)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        'Source files must cover ECO volumes A-E exactly once',
        'Per-file rows do not equal expectedRows',
        'File path must match its ECO volume',
        'File URL is not pinned to the declared commit',
      ]))
    }
  })
})

describe('wire hydration fail-closed branches', () => {
  test('hydrates the real compact C20 partition', () => {
    const hydrated = hydrateParsedWirePartition(fixture())
    expect(hydrated.eco).toBe('C20')
    expect(hydrated.lines).toHaveLength(c20.l.length)
    expect(hydrated.verifiedLines).toHaveLength(c20.x.length)
    expect(hydrated.verifiedLines.flatMap((line) => line.nodes).length).toBeGreaterThan(0)
  })

  test('rejects mismatched generation, catalog, canonical slice, line evidence, and variants', () => {
    expectHydrationError((options) => { options.partition.g = '2026-01-01T00:00:00.000Z' }, /generation metadata/u)
    expectHydrationError((options) => { options.search = { ...options.search, c: options.search.c.filter((entry) => entry[0] !== 'C20') } }, /absent from the search catalog/u)
    expectHydrationError((options) => { options.partition.l.reverse() }, /canonical catalog slice/u)
    expectHydrationError((options) => { options.partition.x[0]![1] = 0 }, /outside partition/u)
    expectHydrationError((options) => { options.partition.x.push(structuredClone(options.partition.x[0]!)) }, /Duplicate wire variant/u)
    expectHydrationError((options) => {
      const copy = structuredClone(options.partition.x[0]!)
      copy[0] = `${copy[0]}-duplicate-side`
      options.partition.x.push(copy)
    }, /Duplicate trained-side/u)
    expectHydrationError((options) => {
      const index = options.partition.l[0]![0]
      options.search = { ...options.search, l: [...options.search.l] }
      const line = structuredClone(options.search.l[index]!)
      line[1] = 'A00'
      options.search.l[index] = line
    }, /invalid line index/u)
    expectHydrationError((options) => {
      const index = options.partition.l[0]![0]
      options.search = { ...options.search, l: [...options.search.l] }
      const line = structuredClone(options.search.l[index]!)
      line[5] = '8/8/8/8/8/8/8/K6k w - -'
      options.search.l[index] = line
    }, /terminal EPD/u)
    expectHydrationError((options) => {
      const index = options.partition.l[0]![0]
      options.search = { ...options.search, l: [...options.search.l] }
      const line = structuredClone(options.search.l[index]!)
      line[6] += 1
      options.search.l[index] = line
    }, /terminal sample/u)
    expectHydrationError((options) => { options.partition.x[0]![3] = 0 }, /drill\/quarantine/u)
  })

  test('rejects corrupt node references, positions, sides, moves, and engine claims', () => {
    expectHydrationError((options) => { firstNode(options).node[2] = 651 }, /exactly cover/u)
    expectHydrationError((options) => { firstNode(options).node[1] = 199 }, /no expected move/u)
    expectHydrationError((options) => { firstNode(options).node[1] = 0 }, /not a black decision ply/u)
    expectHydrationError((options) => { firstNode(options).position[0] = '8/8/8/8/8/8/8/K6k w - -' }, /positions differ/u)
    expectHydrationError((options) => {
      const { engine, position } = firstNode(options)
      engine[0] = engine[0].replace(' b ', ' w ')
      position[0] = engine[0].split(' ').slice(0, 4).join(' ')
    }, /wrong side to move/u)
    expectHydrationError((options) => {
      const { node } = firstNode(options)
      node[5].push(structuredClone(node[5][0]!))
    }, /Duplicate move/u)
    expectHydrationError((options) => {
      const context = firstNode(options)
      const missingIds = new Set(context.engine[4].filter((move) => move[1] === null).map((move) => move[0]))
      const unanalysed = context.node[5].find((move) => missingIds.has(move[0]))!
      unanalysed[1] |= 2
    }, /missing cached analysis/u)
    expectHydrationError((options) => {
      const { node } = firstNode(options)
      const nonBook = node[5].find((move) => move[0] === 'b7b5')!
      nonBook[1] |= 1
    }, /inconsistent book metadata/u)
    expectHydrationError((options) => {
      const { node } = firstNode(options)
      const expected = node[5].find((move) => move[0] === 'e7e5')!
      expected[1] |= 1
    }, /inconsistent book metadata/u)
    expectHydrationError((options) => {
      const move = firstNode(options).node[5][0]!
      move[0] = 'a1a8'
      move[1] = 0
    }, /is illegal/u)
    expectHydrationError((options) => {
      const { node } = firstNode(options)
      const exact = node[5].find((move) => move[3] !== null)!
      exact[3]! += 1
    }, /inconsistent centipawn loss/u)
    expectHydrationError((options) => {
      const { node } = firstNode(options)
      node[5] = node[5].filter((move) => move[0] !== 'e7e5')
    }, /does not retain its expected move/u)
    expectHydrationError((options) => {
      const { node } = firstNode(options)
      const expected = node[5].find((move) => move[0] === 'e7e5')!
      expected[3] = null
    }, /expected move lacks exact engine evidence/u)
    expectHydrationError((options) => { firstNode(options).engine[1] = 'a1a8' }, /best move .* illegal/u)
  })

  test('rejects every unsupported move-evidence policy combination', () => {
    const setLoss = (
      classification: 1 | 2 | 3 | 4,
      loss: number,
      alter?: (context: ReturnType<typeof firstNode>, moveUci: string) => void,
    ) => (options: ReturnType<typeof fixture>): void => {
      const context = firstNode(options)
      const move = context.node[5].find((candidate) => candidate[1] === 0)!
      const analysis = context.engine[4].find((candidate) => candidate[0] === move[0])!
      const best = context.engine[2]
      expect(best[0]).toBe(0)
      analysis[1] = [0, best[1] - loss]
      move[1] |= 2
      move[2] = classification
      move[3] = loss
      alter?.(context, move[0])
    }
    expectHydrationError(setLoss(1, 51), /Playable classification/u)
    expectHydrationError(setLoss(2, 50), /Inaccuracy classification/u)
    expectHydrationError(setLoss(3, 99), /Mistake classification/u)
    expectHydrationError(setLoss(4, 35), /Unverified deviation/u)
    expectHydrationError((options) => {
      const { node } = firstNode(options)
      const expected = node[5].find((move) => move[0] === 'e7e5')!
      expected[2] = 1
    }, /non-book classification/u)
    expectHydrationError((options) => {
      const context = firstNode(options)
      const unanalysed = context.node[5].find((move) => (move[1] & 2) === 0)!
      unanalysed[3] = 1
    }, /Centipawn loss has no engine score/u)
  })
})

describe('embedded data source integrity and cache branches', () => {
  test('reports typed errors and validates abort, ECO, missing partition, and partition cache behavior', async () => {
    const typed = new SnapshotDataError('missing', 'missing')
    expect(typed.name).toBe('SnapshotDataError')
    expect(typed.code).toBe('missing')

    const source = new EmbeddedOpeningDataSource(payload)
    const aborted = new AbortController()
    aborted.abort()
    await expect(source.initialize(aborted.signal)).rejects.toMatchObject({ code: 'aborted' })
    const initialized = await source.initialize()
    expect(initialized.catalog).toHaveLength(500)
    await expect(source.loadPartition('bad')).rejects.toMatchObject({ code: 'missing' })
    const missingPayload = { ...payload, partitions: { ...payload.partitions } }
    delete missingPayload.partitions.C20
    await expect(new EmbeddedOpeningDataSource(missingPayload).loadPartition('C20')).rejects.toMatchObject({ code: 'corrupt' })
    const first = source.loadPartition('C20')
    const second = source.loadPartition('C20')
    expect(await first).toBe(await second)
    await expect(source.loadPartition('C20', aborted.signal)).rejects.toMatchObject({ code: 'aborted' })
  }, 30_000)

  test('loads an embedded DOM payload and rejects absent or malformed DOM manifests', async () => {
    const script = document.createElement('script')
    script.id = 'linerecall-embedded-snapshot'
    script.type = 'application/json'
    script.textContent = JSON.stringify(payload)
    document.body.append(script)
    expect((await new EmbeddedOpeningDataSource().initialize()).catalog).toHaveLength(500)

    document.body.replaceChildren()
    await expect(new EmbeddedOpeningDataSource().initialize()).rejects.toMatchObject({ code: 'missing' })
    const malformed = document.createElement('script')
    malformed.id = 'linerecall-embedded-snapshot'
    malformed.type = 'application/json'
    malformed.textContent = '{'
    document.body.append(malformed)
    await expect(new EmbeddedOpeningDataSource().initialize()).rejects.toMatchObject({ code: 'corrupt' })
  }, 30_000)

  test('fails fast on manifest and receipt metadata corruption, resetting initialization for retry', async () => {
    const badManifest = { ...payload, version: 1 } as unknown as EmbeddedSnapshotPayload
    const source = new EmbeddedOpeningDataSource(badManifest)
    await expect(source.initialize()).rejects.toMatchObject({ code: 'corrupt' })
    await expect(source.initialize()).rejects.toMatchObject({ code: 'corrupt' })

    const receipts = [
      { compressedBytes: 0 },
      { compressedBytes: 2 * 1024 * 1024 + 1 },
      { uncompressedBytes: 0 },
      { uncompressedBytes: 8 * 1024 * 1024 + 1 },
      { sha256: 'bad' },
      { base64: '***', compressedBytes: 3 },
      { base64: payload.blobs.search.base64, compressedBytes: payload.blobs.search.compressedBytes + 1 },
      { sha256: '0'.repeat(64) },
    ]
    for (const mutation of receipts) {
      const corrupted = structuredClone(payload)
      Object.assign(corrupted.blobs.search, mutation)
      await expect(new EmbeddedOpeningDataSource(corrupted).initialize()).rejects.toMatchObject({ code: 'corrupt' })
    }
  }, 30_000)
})
