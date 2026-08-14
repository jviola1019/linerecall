import type { OpeningDataSource } from './opening-data-source.ts'
import {
  EmbeddedProductionSnapshotPayloadV3Schema,
  EmbeddedSnapshotPayloadSchema,
  type EmbeddedProductionSnapshotPayloadV3,
} from './embedded-contract.ts'
import {
  ContentAddressedFamilyOpeningDataSource,
  type BoundedFamilyResourceReadRequest,
  type BoundedFamilyResourceReader,
} from './family-opening-data-source.ts'
import { EmbeddedOpeningDataSource, SnapshotDataError } from './embedded-opening-data-source.ts'

function abortIfRequested(signal?: AbortSignal): void {
  if (signal?.aborted) throw new SnapshotDataError('aborted', 'Opening-family data loading was cancelled')
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  } catch (cause) {
    throw new SnapshotDataError('corrupt', 'Embedded opening-family data is not valid base64', { cause })
  }
}

class EmbeddedFamilyResourceReader implements BoundedFamilyResourceReader {
  readonly #resources: ReadonlyMap<string, EmbeddedProductionSnapshotPayloadV3['familyResources'][string]>

  constructor(payload: EmbeddedProductionSnapshotPayloadV3) {
    const resources = new Map<string, EmbeddedProductionSnapshotPayloadV3['familyResources'][string]>()
    for (const resource of Object.values(payload.familyResources)) {
      if (resources.has(resource.reference.path)) {
        throw new SnapshotDataError('corrupt', 'Embedded opening-family resource paths are duplicated')
      }
      resources.set(resource.reference.path, resource)
    }
    this.#resources = resources
  }

  async read(request: BoundedFamilyResourceReadRequest): Promise<Uint8Array> {
    abortIfRequested(request.signal)
    if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
      throw new SnapshotDataError('corrupt', 'Opening-family read limit is invalid')
    }
    const resource = this.#resources.get(request.path)
    if (!resource) throw new SnapshotDataError('missing', 'The requested embedded family resource is unavailable')
    if (resource.blob.compressedBytes > request.maxBytes) {
      throw new SnapshotDataError('corrupt', 'The requested embedded family resource exceeds its read limit')
    }
    const bytes = decodeBase64(resource.blob.base64)
    if (bytes.byteLength !== resource.blob.compressedBytes) {
      throw new SnapshotDataError('corrupt', 'Embedded opening-family data has an unexpected compressed size')
    }
    abortIfRequested(request.signal)
    return bytes
  }
}

function embeddedInputFromDocument(): unknown {
  if (typeof document === 'undefined') {
    throw new SnapshotDataError('missing', 'No embedded opening database was supplied')
  }
  const source = document.getElementById('linerecall-embedded-snapshot')?.textContent
  if (!source) throw new SnapshotDataError('missing', 'The embedded opening database is missing')
  try {
    return JSON.parse(source) as unknown
  } catch (cause) {
    throw new SnapshotDataError('corrupt', 'The embedded opening database manifest is not valid JSON', { cause })
  }
}

/**
 * Construct the one runtime source that matches the embedded envelope. Review
 * snapshots remain v2-only. A production v3 envelope decorates that audited
 * browse source with checksum-validated family graphs and tactical shards.
 */
export function createEmbeddedOpeningDataSource(input?: unknown): OpeningDataSource {
  const raw = input ?? embeddedInputFromDocument()
  const review = EmbeddedSnapshotPayloadSchema.safeParse(raw)
  if (review.success) return new EmbeddedOpeningDataSource(review.data)
  const production = EmbeddedProductionSnapshotPayloadV3Schema.safeParse(raw)
  if (!production.success) {
    throw new SnapshotDataError(
      'corrupt',
      `The embedded opening database failed runtime validation (${production.error.issues.length} schema issues)`,
      { cause: production.error },
    )
  }
  const payload = production.data
  const base = new EmbeddedOpeningDataSource(payload.base)
  return new ContentAddressedFamilyOpeningDataSource(base, {
    trustedCatalogRef: payload.familyCatalogRef,
    expectedReleaseId: payload.releaseId,
    reader: new EmbeddedFamilyResourceReader(payload),
  })
}
