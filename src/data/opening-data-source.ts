import type { OpeningCatalogEntry, OpeningPartition, DataManifest } from '../domain/opening-data.ts'
import type { OpeningSearchEntry } from '../domain/input-validation.ts'
import type { WireSearchSnapshot } from './wire.ts'

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
}

export interface OpeningDataSource {
  initialize(signal?: AbortSignal): Promise<OpeningDataCore>
  loadPartition(eco: string, signal?: AbortSignal): Promise<OpeningPartition>
  loadAudit(signal?: AbortSignal): Promise<DataManifest>
}
