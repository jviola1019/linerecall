import type { OpeningCatalogEntry, OpeningPartition, DataManifest } from '../domain/opening-data.ts'
import type {
  ContentAddressedRefV1,
  FamilyPackRefV1,
  OpeningFamilyCatalogV1,
  OpeningFamilyManifestV1,
  TacticalPuzzleShardV1,
} from '../domain/opening-family.ts'
import type { RepertoireGraphDocument } from '../domain/repertoire.ts'
import type { OpeningSearchEntry } from '../domain/input-validation.ts'
import type { WireSearchSnapshot } from './wire.ts'
import type { ReviewOpeningFamilyCatalogV1 } from './review-family-catalog.ts'

export interface OpeningVariantSummary {
  id: string
  sourceLineId: string
  eco: string
  name: string
  trainedSide: 'white' | 'black'
  cardCount: number
}

export interface OpeningDataCore {
  search: WireSearchSnapshot
  catalog: OpeningCatalogEntry[]
  searchEntries: OpeningSearchEntry[]
  variantSummaries: readonly OpeningVariantSummary[]
  reviewFamilyCatalog: ReviewOpeningFamilyCatalogV1
}

export interface OpeningDataSource {
  readonly familySchemaVersion?: 1
  initialize(signal?: AbortSignal): Promise<OpeningDataCore>
  loadPartition(eco: string, signal?: AbortSignal): Promise<OpeningPartition>
  loadAudit(signal?: AbortSignal): Promise<DataManifest>
  loadFamilyCatalog?(signal?: AbortSignal): Promise<OpeningFamilyCatalogV1>
  loadFamilyManifest?(familyId: string, signal?: AbortSignal): Promise<OpeningFamilyManifestV1>
  loadRepertoirePack?(packRef: FamilyPackRefV1, signal?: AbortSignal): Promise<RepertoireGraphDocument>
  loadPuzzleShard?(shardRef: ContentAddressedRefV1, signal?: AbortSignal): Promise<TacticalPuzzleShardV1>
}

export interface FamilyOpeningDataSource extends OpeningDataSource {
  readonly familySchemaVersion: 1
  loadFamilyCatalog(signal?: AbortSignal): Promise<OpeningFamilyCatalogV1>
  loadFamilyManifest(familyId: string, signal?: AbortSignal): Promise<OpeningFamilyManifestV1>
  loadRepertoirePack(packRef: FamilyPackRefV1, signal?: AbortSignal): Promise<RepertoireGraphDocument>
  loadPuzzleShard(shardRef: ContentAddressedRefV1, signal?: AbortSignal): Promise<TacticalPuzzleShardV1>
}

export function supportsOpeningFamilies(source: OpeningDataSource): source is FamilyOpeningDataSource {
  return source.familySchemaVersion === 1
    && typeof source.loadFamilyCatalog === 'function'
    && typeof source.loadFamilyManifest === 'function'
    && typeof source.loadRepertoirePack === 'function'
    && typeof source.loadPuzzleShard === 'function'
}
