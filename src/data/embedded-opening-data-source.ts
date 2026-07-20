import { z } from 'zod'
import {
  DataManifestSchema,
  type OpeningCatalogEntry,
  type OpeningPartition,
} from '../domain/opening-data.ts'
import type { OpeningSearchEntry } from '../domain/input-validation.ts'
import {
  EmbeddedSnapshotPayloadSchema,
  MAX_EMBEDDED_COMPRESSED_BLOB_BYTES,
  MAX_EMBEDDED_UNCOMPRESSED_BLOB_BYTES,
  type EmbeddedBlobReceipt,
  type EmbeddedSnapshotPayload,
} from './embedded-contract.ts'
import type { OpeningDataCore, OpeningDataSource, OpeningVariantSummary } from './opening-data-source.ts'
import {
  WirePartitionSchema,
  WireEvidenceShardSchema,
  WireSearchSnapshotSchema,
  hydrateParsedWirePartition,
  type WireEvidenceShard,
  type WirePartition,
  type WirePartitionEvidence,
} from './wire.ts'
import {
  parseVerifiedJson,
  type VerifiedJsonParseResult,
  validateVerifiedJson,
} from './verified-json.ts'

const ECO_PATTERN = /^[A-E][0-9]{2}$/u
export class SnapshotDataError extends Error {
  readonly code: 'aborted' | 'unsupported' | 'corrupt' | 'missing'

  constructor(code: SnapshotDataError['code'], message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SnapshotDataError'
    this.code = code
  }
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SnapshotDataError('aborted', 'Opening data loading was cancelled')
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch (cause) {
    throw new SnapshotDataError('corrupt', 'Embedded opening data is not valid base64', { cause })
  }
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function performanceMark(name: string): void {
  globalThis.performance?.mark?.(name)
}

function performanceMeasure(name: string, start: string): void {
  globalThis.performance?.measure?.(name, start)
}

async function verifiedJson(
  receipt: EmbeddedBlobReceipt,
  label: 'search' | 'audit' | 'partition' | 'shard',
): Promise<VerifiedJsonParseResult> {
  const measureStart = `linerecall-${label}-blob-start`
  performanceMark(measureStart)
  const envelopeStart = `linerecall-${label}-envelope-start`
  performanceMark(envelopeStart)
  if (
    !Number.isSafeInteger(receipt.compressedBytes) || receipt.compressedBytes < 1 ||
    receipt.compressedBytes > MAX_EMBEDDED_COMPRESSED_BLOB_BYTES ||
    !Number.isSafeInteger(receipt.uncompressedBytes) || receipt.uncompressedBytes < 1 ||
    receipt.uncompressedBytes > MAX_EMBEDDED_UNCOMPRESSED_BLOB_BYTES ||
    !/^[a-f0-9]{64}$/u.test(receipt.sha256)
  ) throw new SnapshotDataError('corrupt', 'Embedded opening data has invalid integrity metadata')
  performanceMeasure(`linerecall-${label}-envelope`, envelopeStart)
  const base64Start = `linerecall-${label}-base64-start`
  performanceMark(base64Start)
  const compressed = decodeBase64(receipt.base64)
  if (compressed.byteLength !== receipt.compressedBytes) {
    throw new SnapshotDataError('corrupt', 'Embedded opening data has an unexpected compressed size')
  }
  performanceMeasure(`linerecall-${label}-base64`, base64Start)
  if (!globalThis.crypto?.subtle) {
    throw new SnapshotDataError('unsupported', 'This browser cannot verify the opening database checksum')
  }
  const compressedBuffer = new ArrayBuffer(compressed.byteLength)
  new Uint8Array(compressedBuffer).set(compressed)
  const digestStart = `linerecall-${label}-digest-start`
  performanceMark(digestStart)
  const digest = await globalThis.crypto.subtle.digest('SHA-256', compressedBuffer)
  if (hex(digest) !== receipt.sha256) {
    throw new SnapshotDataError('corrupt', 'Embedded opening data failed its SHA-256 integrity check')
  }
  performanceMeasure(`linerecall-${label}-digest`, digestStart)
  if (typeof DecompressionStream === 'undefined') {
    throw new SnapshotDataError('unsupported', 'This browser cannot decompress the offline opening database')
  }
  let uncompressed: Uint8Array
  const decompressionStart = `linerecall-${label}-decompression-start`
  performanceMark(decompressionStart)
  try {
    const stream = new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))
    const reader = stream.getReader()
    uncompressed = new Uint8Array(receipt.uncompressedBytes)
    let offset = 0
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (offset + result.value.byteLength > receipt.uncompressedBytes) {
        await reader.cancel().catch(() => undefined)
        throw new SnapshotDataError('corrupt', 'Embedded opening data exceeds its audited uncompressed size')
      }
      uncompressed.set(result.value, offset)
      offset += result.value.byteLength
    }
    if (offset !== receipt.uncompressedBytes) {
      throw new SnapshotDataError('corrupt', 'Embedded opening data has an unexpected uncompressed size')
    }
  } catch (cause) {
    if (cause instanceof SnapshotDataError) throw cause
    throw new SnapshotDataError('corrupt', 'Embedded opening data could not be decompressed', { cause })
  }
  performanceMeasure(`linerecall-${label}-decompression`, decompressionStart)
  let text: string
  const utf8Start = `linerecall-${label}-utf8-start`
  performanceMark(utf8Start)
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(uncompressed)
  } catch (cause) {
    throw new SnapshotDataError('corrupt', 'Embedded opening data is not valid UTF-8', { cause })
  }
  performanceMeasure(`linerecall-${label}-utf8`, utf8Start)
  const jsonStart = `linerecall-${label}-json-start`
  performanceMark(jsonStart)
  try {
    const result = parseVerifiedJson(text)
    performanceMeasure(`linerecall-${label}-json`, jsonStart)
    performanceMeasure(`linerecall-${label}-blob`, measureStart)
    return result
  } catch (cause) {
    throw new SnapshotDataError('corrupt', 'Embedded opening data is not valid JSON', { cause })
  }
}

function parseSnapshot<T>(parse: () => T, label: string): T {
  try {
    return parse()
  } catch (cause) {
    if (cause instanceof SnapshotDataError) throw cause
    const detail = cause instanceof z.ZodError ? ` (${cause.issues.length} schema issues)` : ''
    throw new SnapshotDataError('corrupt', `${label} failed runtime schema validation${detail}`, { cause })
  }
}

function buildCatalog(
  search: OpeningDataCore['search'],
  payload: EmbeddedSnapshotPayload,
): OpeningCatalogEntry[] {
  const drillableByEco = new Map<string, number>()
  for (const variant of search.x) {
    const line = search.l[variant[1]]
    if (!line) throw new SnapshotDataError('corrupt', `Variant ${variant[0]} has no source line`)
    drillableByEco.set(line[1], (drillableByEco.get(line[1]) ?? 0) + 1)
  }
  return search.c.map(([eco, start, lineCount]) => {
    const receipt = payload.partitions[eco]
    if (!receipt) throw new SnapshotDataError('missing', `Opening partition ${eco} is missing`)
    const lines = search.l.slice(start, start + lineCount)
    if (lines.length !== lineCount || lines.some((line) => line[1] !== eco)) {
      throw new SnapshotDataError('corrupt', `Opening catalog slice ${eco} is invalid`)
    }
    return {
      eco,
      volume: eco[0] as OpeningCatalogEntry['volume'],
      lineCount,
      names: lines.map((line) => line[2]),
      drillableVariantCount: drillableByEco.get(eco) ?? 0,
      partitionId: `eco_${eco}`,
      compressedBytes: receipt.compressedBytes,
      uncompressedBytes: receipt.uncompressedBytes,
      sha256: receipt.sha256,
    }
  })
}

function buildSearchEntries(search: OpeningDataCore['search']): OpeningSearchEntry[] {
  return search.l.map((line) => ({
      sourceLineId: line[0],
      eco: line[1],
      name: line[2],
      pgn: line[3],
      uci: line[4].split(' '),
      terminalEpd: line[5],
      terminalSampleSize: line[6],
      backtestEligible: line[6] >= 500,
      verifiedVariantIds: [],
    }))
}

function buildVariantSummaries(search: OpeningDataCore['search']): OpeningVariantSummary[] {
  return search.x.map(([id, sourceLineIndex, trainedSide, cardCount]) => {
    const source = search.l[sourceLineIndex]
    if (!source) throw new SnapshotDataError('corrupt', `Variant ${id} has no source line`)
    return {
      id,
      sourceLineId: source[0],
      eco: source[1],
      name: source[2],
      trainedSide: trainedSide === 0 ? 'white' : 'black',
      cardCount,
    }
  })
}

export class EmbeddedOpeningDataSource implements OpeningDataSource {
  readonly #suppliedPayload: EmbeddedSnapshotPayload | null
  #payloadCache: EmbeddedSnapshotPayload | null = null
  #corePromise: Promise<OpeningDataCore> | null = null
  #auditPromise: Promise<z.infer<typeof DataManifestSchema>> | null = null
  readonly #partitions = new Map<string, Promise<OpeningPartition>>()
  readonly #partitionWires = new Map<string, Promise<WirePartition>>()
  readonly #shardWires = new Map<string, Promise<WireEvidenceShard>>()

  constructor(payload?: EmbeddedSnapshotPayload) {
    this.#suppliedPayload = payload ?? null
  }

  #payload(): EmbeddedSnapshotPayload {
    if (this.#payloadCache) return this.#payloadCache
    let raw: unknown = this.#suppliedPayload
    if (raw === null) {
      if (typeof document === 'undefined') {
        throw new SnapshotDataError('missing', 'No embedded opening database was supplied')
      }
      const element = document.getElementById('linerecall-embedded-snapshot')
      const source = element?.textContent
      if (!source) throw new SnapshotDataError('missing', 'The embedded opening database is missing')
      try {
        raw = JSON.parse(source) as unknown
      } catch (cause) {
        throw new SnapshotDataError('corrupt', 'The embedded opening database manifest is not valid JSON', { cause })
      }
    }
    try {
      const payloadSchemaStart = 'linerecall-payload-schema-start'
      performanceMark(payloadSchemaStart)
      this.#payloadCache = EmbeddedSnapshotPayloadSchema.parse(raw)
      performanceMeasure('linerecall-payload-schema', payloadSchemaStart)
      return this.#payloadCache
    } catch (cause) {
      throw new SnapshotDataError('corrupt', 'The embedded opening database manifest failed runtime schema validation', { cause })
    }
  }

  async initialize(signal?: AbortSignal): Promise<OpeningDataCore> {
    abortIfRequested(signal)
    this.#corePromise ??= this.#initialize()
    try {
      const core = await this.#corePromise
      abortIfRequested(signal)
      return core
    } catch (error) {
      this.#corePromise = null
      throw error
    }
  }

  async #initialize(): Promise<OpeningDataCore> {
    const startupStart = 'linerecall-data-startup-start'
    performanceMark(startupStart)
    const payload = this.#payload()
    const initialReceipt = payload.partitions.A00
    if (initialReceipt) {
      // Verify the deterministic selected startup partition while the small
      // catalog/search blob is processed. Hydration waits for validated core.
      void this.#partitionWire('A00', initialReceipt).catch(() => undefined)
    }
    const searchValue = await verifiedJson(payload.blobs.search, 'search')
    const schemaStart = 'linerecall-core-schema-start'
    performanceMark(schemaStart)
    const search = parseSnapshot(
      () => validateVerifiedJson(searchValue, (value) => WireSearchSnapshotSchema.parse(value)),
      'Opening search index',
    )
    performanceMeasure('linerecall-search-schema', schemaStart)
    if (search.g !== payload.generatedAt) {
      throw new SnapshotDataError('corrupt', 'Opening database generation identifiers do not match')
    }
    const coreBuildersStart = 'linerecall-core-builders-start'
    performanceMark(coreBuildersStart)
    const core = {
      search,
      catalog: buildCatalog(search, payload),
      searchEntries: buildSearchEntries(search),
      variantSummaries: buildVariantSummaries(search),
    }
    performanceMeasure('linerecall-core-builders', coreBuildersStart)
    performanceMeasure('linerecall-data-startup', startupStart)
    return core
  }

  async loadAudit(signal?: AbortSignal): Promise<z.infer<typeof DataManifestSchema>> {
    abortIfRequested(signal)
    this.#auditPromise ??= this.#loadAudit()
    try {
      const audit = await this.#auditPromise
      abortIfRequested(signal)
      return audit
    } catch (error) {
      this.#auditPromise = null
      throw error
    }
  }

  async #loadAudit(): Promise<z.infer<typeof DataManifestSchema>> {
    const payload = this.#payload()
    const [core, auditValue] = await Promise.all([
      this.initialize(),
      verifiedJson(payload.blobs.audit, 'audit'),
    ])
    const schemaStart = 'linerecall-audit-schema-start'
    performanceMark(schemaStart)
    const audit = parseSnapshot(
      () => validateVerifiedJson(auditValue, (value) => DataManifestSchema.parse(value)),
      'Opening audit manifest',
    )
    performanceMeasure('linerecall-audit-schema', schemaStart)
    if (audit.generatedAt !== payload.generatedAt || audit.generatedAt !== core.search.g) {
      throw new SnapshotDataError('corrupt', 'Opening audit generation identifier does not match')
    }
    const catalogDrillable = audit.catalog.reduce((sum, entry) => sum + entry.drillableVariantCount, 0)
    if (
      audit.audit.browsableLines !== core.search.l.length ||
      audit.audit.drillableVariants !== core.search.x.length ||
      catalogDrillable !== core.search.x.length
    ) throw new SnapshotDataError('corrupt', 'Opening audit totals do not match the search catalog')
    return audit
  }

  async loadPartition(eco: string, signal?: AbortSignal): Promise<OpeningPartition> {
    abortIfRequested(signal)
    if (!ECO_PATTERN.test(eco)) throw new SnapshotDataError('missing', 'The requested ECO code is invalid')
    const receipt = this.#payload().partitions[eco]
    if (!receipt) throw new SnapshotDataError('missing', `Opening partition ${eco} is unavailable`)
    let pending = this.#partitions.get(eco)
    if (!pending) {
      pending = this.#loadPartition(eco, receipt)
      this.#partitions.set(eco, pending)
    }
    try {
      const partition = await pending
      abortIfRequested(signal)
      return partition
    } catch (error) {
      if (!(error instanceof SnapshotDataError && error.code === 'aborted')) {
        if (this.#partitions.get(eco) === pending) this.#partitions.delete(eco)
      }
      throw error
    }
  }

  async #loadPartition(eco: string, receipt: EmbeddedBlobReceipt): Promise<OpeningPartition> {
    const [core, wire] = await Promise.all([this.initialize(), this.#partitionWire(eco, receipt)])
    if (wire.e !== eco) throw new SnapshotDataError('corrupt', `Opening partition ${eco} is mislabeled`)
    const shards = await Promise.all(wire.s.map(async (shardId) => {
      const shardReceipt = this.#payload().shards[shardId]
      if (!shardReceipt) throw new SnapshotDataError('missing', `Evidence shard ${shardId} is unavailable`)
      const shard = await this.#shardWire(shardId, shardReceipt)
      if (shard.s !== shardId || shard.g !== wire.g || !shard.c.includes(eco)) {
        throw new SnapshotDataError('corrupt', `Evidence shard ${shardId} does not belong to ${eco}`)
      }
      return shard
    }))
    const positions = new Map<number, WireEvidenceShard['p'][number][1]>()
    const engines = new Map<number, WireEvidenceShard['a'][number][1]>()
    const positionEpds = new Set<string>()
    const engineFens = new Set<string>()
    for (const shard of shards) {
      for (const [index, position] of shard.p) {
        if (positions.has(index)) throw new SnapshotDataError('corrupt', `Duplicate position evidence ${index}`)
        if (positionEpds.has(position[0])) throw new SnapshotDataError('corrupt', `Duplicate position EPD ${position[0]}`)
        positions.set(index, position)
        positionEpds.add(position[0])
      }
      for (const [index, engine] of shard.a) {
        if (engines.has(index)) throw new SnapshotDataError('corrupt', `Duplicate engine evidence ${index}`)
        if (engineFens.has(engine[0])) throw new SnapshotDataError('corrupt', `Duplicate engine FEN ${engine[0]}`)
        engines.set(index, engine)
        engineFens.add(engine[0])
      }
    }
    const evidence: WirePartitionEvidence = { positions, engines }
    const hydrationStart = 'linerecall-partition-hydration-start'
    performanceMark(hydrationStart)
    const partition = parseSnapshot(() => hydrateParsedWirePartition({
      search: core.search,
      partition: wire,
      evidence,
    }), `Opening partition ${eco}`)
    performanceMeasure('linerecall-partition-hydration', hydrationStart)
    return partition
  }

  #partitionWire(eco: string, receipt: EmbeddedBlobReceipt): Promise<WirePartition> {
    let pending = this.#partitionWires.get(eco)
    if (!pending) {
      const created = verifiedJson(receipt, 'partition').then((value) => {
        const schemaStart = 'linerecall-partition-schema-start'
        performanceMark(schemaStart)
        const wire = parseSnapshot(
          () => validateVerifiedJson(value, (parsedValue) => WirePartitionSchema.parse(parsedValue)),
          `Opening partition ${eco}`,
        )
        performanceMeasure('linerecall-partition-schema', schemaStart)
        return wire
      })
      pending = created
      this.#partitionWires.set(eco, created)
      void created.catch(() => {
        if (this.#partitionWires.get(eco) === created) this.#partitionWires.delete(eco)
      })
    }
    return pending
  }

  #shardWire(shardId: string, receipt: EmbeddedBlobReceipt): Promise<WireEvidenceShard> {
    let pending = this.#shardWires.get(shardId)
    if (!pending) {
      const created = verifiedJson(receipt, 'shard').then((value) => parseSnapshot(
        () => validateVerifiedJson(value, (parsedValue) => WireEvidenceShardSchema.parse(parsedValue)),
        `Evidence shard ${shardId}`,
      ))
      pending = created
      this.#shardWires.set(shardId, created)
      void created.catch(() => {
        if (this.#shardWires.get(shardId) === created) this.#shardWires.delete(shardId)
      })
    }
    return pending
  }
}
