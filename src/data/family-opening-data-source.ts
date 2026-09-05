import { z } from 'zod'
import {
  ContentAddressedRefV1Schema,
  FamilyIdSchema,
  FamilyPackRefV1Schema,
  FamilyReleaseIdSchema,
  OpeningFamilyCatalogV1Schema,
  OpeningFamilyManifestV1Schema,
  TacticalPuzzlePromotionBindingV1Schema,
  TacticalPuzzleShardPayloadV1Schema,
  TacticalPuzzleShardV1Schema,
  type ContentAddressedRefV1,
  type FamilyPackRefV1,
  type OpeningFamilyCatalogV1,
  type OpeningFamilyManifestV1,
  type TacticalPuzzlePromotionBindingV1,
  type TacticalPuzzleShardV1,
} from '../domain/opening-family.ts'
import {
  validateRepertoireGraphDocument,
  type RepertoireGraphDocument,
} from '../domain/repertoire.ts'
import {
  parseVerifiedJson,
  validateVerifiedJson,
} from './verified-json.ts'
import type {
  FamilyOpeningDataSource,
  OpeningDataCore,
  OpeningDataSource,
} from './opening-data-source.ts'
import type {
  DataManifest,
  OpeningPartition,
} from '../domain/opening-data.ts'

export type FamilyResourceErrorCode = 'aborted' | 'unsupported' | 'corrupt' | 'missing'

export class FamilyResourceError extends Error {
  readonly code: FamilyResourceErrorCode

  constructor(code: FamilyResourceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'FamilyResourceError'
    this.code = code
  }
}

export interface BoundedFamilyResourceReadRequest {
  path: string
  maxBytes: number
  signal?: AbortSignal
}

/**
 * Transport adapter supplied by the host. Implementations must stop after
 * `maxBytes`; this layer independently checks the exact returned byte length.
 */
export interface BoundedFamilyResourceReader {
  read(request: BoundedFamilyResourceReadRequest): Promise<Uint8Array>
}

export interface FamilyOpeningDataSourceOptions {
  /**
   * This reference must come from a separately authenticated signed manifest.
   * The decorator verifies the referenced gzip bytes; it does not choose a
   * transport or establish the signature trust root itself.
   */
  trustedCatalogRef: ContentAddressedRefV1
  expectedReleaseId: string
  reader: BoundedFamilyResourceReader
  /**
   * Optional puzzle promotion statement from the separately authenticated
   * production app root. Supplying shard references alone is insufficient to
   * make a puzzle-bearing UI resource trusted.
   */
  trustedPuzzlePromotion?: unknown
}

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new FamilyResourceError('aborted', 'Opening-family data loading was cancelled')
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError')
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function sameReference(left: ContentAddressedRefV1, right: ContentAddressedRefV1): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.id === right.id
    && left.releaseId === right.releaseId
    && left.path === right.path
    && left.sha256 === right.sha256
    && left.compressedBytes === right.compressedBytes
    && left.uncompressedBytes === right.uncompressedBytes
    && left.contentType === right.contentType
    && left.contentEncoding === right.contentEncoding
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function freezeJsonGraph<T>(root: T): T {
  if (typeof root !== 'object' || root === null) return root
  type JsonContainer = object
  const pending: object[] = [root]
  const visited = new Set<JsonContainer>()
  while (pending.length > 0) {
    const current = pending.pop()!
    if (visited.has(current)) continue
    visited.add(current)
    for (const key of Reflect.ownKeys(current)) {
      const child = Reflect.get(current, key) as unknown
      if (typeof child === 'object' && child !== null) pending.push(child)
    }
    Object.freeze(current)
  }
  return root
}

async function awaitWithAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  abortIfRequested(signal)
  if (!signal) return pending
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new FamilyResourceError('aborted', 'Opening-family data loading was cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
    void pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Adds the audited family-resource contract to an existing taxonomy source.
 * All ordinary taxonomy/audit operations are delegated unchanged.
 */
export class ContentAddressedFamilyOpeningDataSource implements FamilyOpeningDataSource {
  readonly familySchemaVersion = 1 as const
  readonly #base: OpeningDataSource
  readonly #reader: BoundedFamilyResourceReader
  readonly #catalogRef: ContentAddressedRefV1
  readonly #releaseId: string
  readonly #puzzlePromotion: TacticalPuzzlePromotionBindingV1 | null
  #catalog: Promise<OpeningFamilyCatalogV1> | null = null
  readonly #manifests = new Map<string, Promise<OpeningFamilyManifestV1>>()
  readonly #graphs = new Map<string, Promise<RepertoireGraphDocument>>()
  readonly #puzzleShards = new Map<string, Promise<TacticalPuzzleShardV1>>()
  readonly #approvedPackRefs = new Map<string, FamilyPackRefV1>()
  readonly #packFamilyIds = new Map<string, string>()
  readonly #approvedPuzzleRefs = new Map<string, {
    ref: ContentAddressedRefV1
    familyIds: Set<string>
  }>()
  readonly #loadedPuzzleIds = new Map<string, string>()

  constructor(base: OpeningDataSource, options: FamilyOpeningDataSourceOptions) {
    this.#base = base
    this.#reader = options.reader
    try {
      this.#releaseId = FamilyReleaseIdSchema.parse(options.expectedReleaseId)
      this.#catalogRef = ContentAddressedRefV1Schema.parse(options.trustedCatalogRef)
    } catch (cause) {
      throw new FamilyResourceError('corrupt', 'Opening-family catalog configuration is invalid', { cause })
    }
    if (this.#catalogRef.releaseId !== this.#releaseId) {
      throw new FamilyResourceError('corrupt', 'Opening-family catalog reference uses another release')
    }
    if (options.trustedPuzzlePromotion === undefined) {
      this.#puzzlePromotion = null
    } else {
      try {
        this.#puzzlePromotion = freezeJsonGraph(
          TacticalPuzzlePromotionBindingV1Schema.parse(options.trustedPuzzlePromotion),
        )
      } catch (cause) {
        throw new FamilyResourceError('corrupt', 'Tactical puzzle promotion binding is invalid', { cause })
      }
      if (this.#puzzlePromotion.releaseId !== this.#releaseId) {
        throw new FamilyResourceError('corrupt', 'Tactical puzzle promotion binding uses another release')
      }
    }
  }

  initialize(signal?: AbortSignal): Promise<OpeningDataCore> {
    return this.#base.initialize(signal)
  }

  loadPartition(eco: string, signal?: AbortSignal): Promise<OpeningPartition> {
    return this.#base.loadPartition(eco, signal)
  }

  loadAudit(signal?: AbortSignal): Promise<DataManifest> {
    return this.#base.loadAudit(signal)
  }

  loadPuzzlePromotionBinding(): TacticalPuzzlePromotionBindingV1 {
    if (!this.#puzzlePromotion) {
      throw new FamilyResourceError(
        'unsupported',
        'No authenticated tactical puzzle promotion binding is available',
      )
    }
    return this.#puzzlePromotion
  }

  async loadFamilyCatalog(signal?: AbortSignal): Promise<OpeningFamilyCatalogV1> {
    abortIfRequested(signal)
    if (!this.#catalog) {
      const pending = this.#readJson(
        this.#catalogRef,
        'Opening-family catalog',
        (value) => OpeningFamilyCatalogV1Schema.parse(value),
        signal,
      ).then((catalog) => {
        if (catalog.releaseId !== this.#releaseId) {
          throw new FamilyResourceError('corrupt', 'Opening-family catalog uses another release')
        }
        return freezeJsonGraph(catalog)
      })
      this.#catalog = pending
      void pending.catch(() => {
        if (this.#catalog === pending) this.#catalog = null
      })
    }
    return awaitWithAbort(this.#catalog, signal)
  }

  async loadFamilyManifest(familyIdInput: string, signal?: AbortSignal): Promise<OpeningFamilyManifestV1> {
    abortIfRequested(signal)
    const familyIdResult = FamilyIdSchema.safeParse(familyIdInput)
    if (!familyIdResult.success) {
      throw new FamilyResourceError('missing', 'The requested opening-family identifier is invalid')
    }
    const familyId = familyIdResult.data
    let pending = this.#manifests.get(familyId)
    if (!pending) {
      pending = this.#loadFamilyManifest(familyId, signal)
      this.#manifests.set(familyId, pending)
      void pending.catch(() => {
        if (this.#manifests.get(familyId) === pending) this.#manifests.delete(familyId)
      })
    }
    return awaitWithAbort(pending, signal)
  }

  async #loadFamilyManifest(
    familyId: string,
    signal?: AbortSignal,
  ): Promise<OpeningFamilyManifestV1> {
    const catalog = await this.loadFamilyCatalog(signal)
    const entry = catalog.families.find((candidate) => candidate.id === familyId)
    if (!entry) throw new FamilyResourceError('missing', `Opening family ${familyId} is unavailable`)
    const manifest = await this.#readJson(
      entry.manifestRef,
      `Opening-family manifest ${familyId}`,
      (value) => OpeningFamilyManifestV1Schema.parse(value),
      signal,
    )
    if (
      manifest.releaseId !== catalog.releaseId
      || manifest.id !== familyId
      || manifest.canonicalName !== entry.canonicalName
      || !sameStrings(manifest.aliases, entry.aliases)
      || !sameStrings(manifest.ecoCodes, entry.ecoCodes)
      || manifest.taxonomyLineIds.length !== entry.taxonomyLineCount
      || manifest.packRefs.length !== entry.packCount
      || !sameStrings(
        [...new Set(manifest.packRefs.map(({ side }) => side))].sort(),
        [...entry.availableSides].sort(),
      )
    ) {
      throw new FamilyResourceError('corrupt', `Opening-family manifest ${familyId} does not match its catalog entry`)
    }

    for (const packRef of manifest.packRefs) {
      const existing = this.#approvedPackRefs.get(packRef.packId)
      if (
        existing
        && (
          existing.side !== packRef.side
          || existing.rootNodeId !== packRef.rootNodeId
          || !sameReference(existing.graphShardRef, packRef.graphShardRef)
        )
      ) {
        throw new FamilyResourceError('corrupt', `Pack ${packRef.packId} has conflicting family references`)
      }
      const owner = this.#packFamilyIds.get(packRef.packId)
      if (owner && owner !== familyId) {
        throw new FamilyResourceError('corrupt', `Pack ${packRef.packId} belongs to multiple families`)
      }
    }
    for (const puzzleRef of manifest.puzzleShardRefs) {
      const existing = this.#approvedPuzzleRefs.get(puzzleRef.id)
      if (existing && !sameReference(existing.ref, puzzleRef)) {
        throw new FamilyResourceError('corrupt', `Puzzle shard ${puzzleRef.id} has conflicting references`)
      }
    }

    for (const packRef of manifest.packRefs) {
      this.#approvedPackRefs.set(packRef.packId, packRef)
      this.#packFamilyIds.set(packRef.packId, familyId)
    }
    for (const puzzleRef of manifest.puzzleShardRefs) {
      const approved = this.#approvedPuzzleRefs.get(puzzleRef.id) ?? {
        ref: puzzleRef,
        familyIds: new Set<string>(),
      }
      approved.familyIds.add(familyId)
      this.#approvedPuzzleRefs.set(puzzleRef.id, approved)
    }
    return freezeJsonGraph(manifest)
  }

  async loadRepertoirePack(
    packRefInput: FamilyPackRefV1,
    signal?: AbortSignal,
  ): Promise<RepertoireGraphDocument> {
    abortIfRequested(signal)
    let packRef: FamilyPackRefV1
    try {
      packRef = FamilyPackRefV1Schema.parse(packRefInput)
    } catch (cause) {
      throw new FamilyResourceError('corrupt', 'Repertoire pack reference is invalid', { cause })
    }
    const approved = this.#approvedPackRefs.get(packRef.packId)
    if (
      !approved
      || approved.side !== packRef.side
      || approved.rootNodeId !== packRef.rootNodeId
      || !sameReference(approved.graphShardRef, packRef.graphShardRef)
    ) {
      throw new FamilyResourceError(
        'missing',
        'Repertoire pack must be loaded through its validated opening-family manifest',
      )
    }
    let pending = this.#graphs.get(approved.graphShardRef.id)
    if (!pending) {
      pending = this.#loadRepertoirePack(approved, signal)
      this.#graphs.set(approved.graphShardRef.id, pending)
      void pending.catch(() => {
        if (this.#graphs.get(approved.graphShardRef.id) === pending) {
          this.#graphs.delete(approved.graphShardRef.id)
        }
      })
    }
    return awaitWithAbort(pending, signal)
  }

  async #loadRepertoirePack(
    packRef: FamilyPackRefV1,
    signal?: AbortSignal,
  ): Promise<RepertoireGraphDocument> {
    const graph = await this.#readJson(
      packRef.graphShardRef,
      `Repertoire graph ${packRef.packId}`,
      validateRepertoireGraphDocument,
      signal,
    )
    const familyId = this.#packFamilyIds.get(packRef.packId)
    const manifest = familyId ? await this.loadFamilyManifest(familyId, signal) : null
    const memberships = manifest?.pathMemberships
      .filter((membership) => membership.packId === packRef.packId)
      .map(({ pathId }) => pathId)
      .sort()
    if (
      graph.releaseId !== this.#releaseId
      || graph.pack.id !== packRef.packId
      || graph.pack.side !== packRef.side
      || graph.pack.rootNodeId !== packRef.rootNodeId
      || !manifest
      || !memberships
      || !sameStrings(memberships, [...graph.pack.pathIds].sort())
      || graph.pack.ecoCodes.some((eco) => !manifest.ecoCodes.includes(eco))
    ) {
      throw new FamilyResourceError('corrupt', `Repertoire graph ${packRef.packId} does not match its family manifest`)
    }
    return freezeJsonGraph(graph)
  }

  async loadPuzzleShard(
    shardRefInput: ContentAddressedRefV1,
    signal?: AbortSignal,
  ): Promise<TacticalPuzzleShardV1> {
    abortIfRequested(signal)
    let shardRef: ContentAddressedRefV1
    try {
      shardRef = ContentAddressedRefV1Schema.parse(shardRefInput)
    } catch (cause) {
      throw new FamilyResourceError('corrupt', 'Tactical puzzle shard reference is invalid', { cause })
    }
    const approved = this.#approvedPuzzleRefs.get(shardRef.id)
    if (!approved || !sameReference(approved.ref, shardRef)) {
      throw new FamilyResourceError(
        'missing',
        'Tactical puzzle shard must be loaded through a validated opening-family manifest',
      )
    }
    let pending = this.#puzzleShards.get(shardRef.id)
    if (!pending) {
      pending = this.#loadPuzzleShard(approved.ref, signal)
      this.#puzzleShards.set(shardRef.id, pending)
      void pending.catch(() => {
        if (this.#puzzleShards.get(shardRef.id) === pending) this.#puzzleShards.delete(shardRef.id)
      })
    }
    return awaitWithAbort(pending, signal)
  }

  async #loadPuzzleShard(
    shardRef: ContentAddressedRefV1,
    signal?: AbortSignal,
  ): Promise<TacticalPuzzleShardV1> {
    const payload = await this.#readJson(
      shardRef,
      `Tactical puzzle shard ${shardRef.id}`,
      (value) => TacticalPuzzleShardPayloadV1Schema.parse(value),
      signal,
    )
    const shard = TacticalPuzzleShardV1Schema.parse({ id: shardRef.id, ...payload })
    if (shard.releaseId !== this.#releaseId) {
      throw new FamilyResourceError('corrupt', `Tactical puzzle shard ${shardRef.id} uses another release`)
    }
    const catalog = await this.loadFamilyCatalog(signal)
    for (const familyId of shard.familyIds) {
      if (!catalog.families.some(({ id }) => id === familyId)) {
        throw new FamilyResourceError('corrupt', `Tactical puzzle shard references unknown family ${familyId}`)
      }
      const manifest = await this.loadFamilyManifest(familyId, signal)
      if (!manifest.puzzleShardRefs.some((reference) => sameReference(reference, shardRef))) {
        throw new FamilyResourceError('corrupt', `Family ${familyId} does not approve tactical puzzle shard ${shardRef.id}`)
      }
    }
    const approved = this.#approvedPuzzleRefs.get(shardRef.id)
    if (
      !approved
      || approved.familyIds.size !== shard.familyIds.length
      || shard.familyIds.some((familyId) => !approved.familyIds.has(familyId))
    ) {
      throw new FamilyResourceError('corrupt', `Tactical puzzle shard ${shardRef.id} family ownership is inconsistent`)
    }
    for (const puzzle of shard.puzzles) {
      const existingShardId = this.#loadedPuzzleIds.get(puzzle.puzzleId)
      if (existingShardId && existingShardId !== shardRef.id) {
        throw new FamilyResourceError('corrupt', `Puzzle ${puzzle.puzzleId} appears in multiple loaded shards`)
      }
    }
    for (const puzzle of shard.puzzles) this.#loadedPuzzleIds.set(puzzle.puzzleId, shardRef.id)
    return freezeJsonGraph(shard)
  }

  async #readJson<T>(
    referenceInput: ContentAddressedRefV1,
    label: string,
    validate: (value: unknown) => T | Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    abortIfRequested(signal)
    let reference: ContentAddressedRefV1
    try {
      reference = ContentAddressedRefV1Schema.parse(referenceInput)
    } catch (cause) {
      throw new FamilyResourceError('corrupt', `${label} has invalid integrity metadata`, { cause })
    }
    if (reference.releaseId !== this.#releaseId) {
      throw new FamilyResourceError('corrupt', `${label} uses another release`)
    }
    let compressed: Uint8Array
    try {
      compressed = await this.#reader.read({
        path: reference.path,
        maxBytes: reference.compressedBytes,
        ...(signal ? { signal } : {}),
      })
    } catch (cause) {
      if (isAbort(cause, signal)) {
        throw new FamilyResourceError('aborted', `${label} loading was cancelled`, { cause })
      }
      throw new FamilyResourceError('missing', `${label} could not be read`, { cause })
    }
    abortIfRequested(signal)
    if (!(compressed instanceof Uint8Array) || compressed.byteLength !== reference.compressedBytes) {
      throw new FamilyResourceError('corrupt', `${label} has an unexpected compressed size`)
    }
    if (!globalThis.crypto?.subtle) {
      throw new FamilyResourceError('unsupported', `${label} cannot be checksum-verified in this environment`)
    }
    const compressedBuffer = exactArrayBuffer(compressed)
    const digest = await globalThis.crypto.subtle.digest('SHA-256', compressedBuffer)
    abortIfRequested(signal)
    if (hex(digest) !== reference.sha256) {
      throw new FamilyResourceError('corrupt', `${label} failed its SHA-256 integrity check`)
    }
    if (typeof DecompressionStream === 'undefined') {
      throw new FamilyResourceError('unsupported', `${label} cannot be decompressed in this environment`)
    }

    let uncompressed: Uint8Array
    try {
      const stream = new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))
      const streamReader = stream.getReader()
      uncompressed = new Uint8Array(reference.uncompressedBytes)
      let offset = 0
      while (true) {
        abortIfRequested(signal)
        const chunk = await streamReader.read()
        if (chunk.done) break
        if (offset + chunk.value.byteLength > reference.uncompressedBytes) {
          await streamReader.cancel().catch(() => undefined)
          throw new FamilyResourceError('corrupt', `${label} exceeds its audited uncompressed size`)
        }
        uncompressed.set(chunk.value, offset)
        offset += chunk.value.byteLength
      }
      if (offset !== reference.uncompressedBytes) {
        throw new FamilyResourceError('corrupt', `${label} has an unexpected uncompressed size`)
      }
    } catch (cause) {
      if (cause instanceof FamilyResourceError) throw cause
      if (isAbort(cause, signal)) {
        throw new FamilyResourceError('aborted', `${label} decompression was cancelled`, { cause })
      }
      throw new FamilyResourceError('corrupt', `${label} is not valid gzip data`, { cause })
    }
    abortIfRequested(signal)

    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(uncompressed)
    } catch (cause) {
      throw new FamilyResourceError('corrupt', `${label} is not valid UTF-8`, { cause })
    }
    let parsed
    try {
      parsed = parseVerifiedJson(text)
    } catch (cause) {
      throw new FamilyResourceError('corrupt', `${label} is not valid JSON`, { cause })
    }
    try {
      return await validateVerifiedJson(parsed, validate)
    } catch (cause) {
      if (cause instanceof FamilyResourceError) throw cause
      const detail = cause instanceof z.ZodError ? ` (${cause.issues.length} schema issues)` : ''
      throw new FamilyResourceError('corrupt', `${label} failed runtime validation${detail}`, { cause })
    }
  }
}
