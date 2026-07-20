import type { OpeningSearchEntry } from './input-validation.ts'
import { masteryPercent, type CardProgress } from './progress.ts'

export interface ProgressVariantCatalogEntry {
  id: string
  sourceLineId: string
  eco: string
  name: string
  trainedSide: 'white' | 'black'
  cardCount: number
}

export interface VariationProgressSummary {
  id: string
  sourceLineId: string | null
  eco: string | null
  name: string
  trainedSide: 'white' | 'black' | null
  availableInCurrentSnapshot: boolean
  mastery: number
  reviewedCards: number
  dueCards: number
  totalCards: number
  excludedCards: number
  lastReviewedAt: string | null
  streak: number
}

export interface OpeningProgressSummary {
  id: string
  sourceLineId: string | null
  eco: string | null
  name: string
  mastery: number
  reviewedCards: number
  dueCards: number
  totalCards: number
  excludedCards: number
  lastReviewedAt: string | null
  streak: number
  variations: VariationProgressSummary[]
}

export interface ProgressSummaries {
  openings: OpeningProgressSummary[]
  variations: VariationProgressSummary[]
  mastery: number
  reviewedCards: number
  dueCards: number
  totalCards: number
  excludedCards: number
}

interface VariationMetrics extends VariationProgressSummary {
  masteryPoints: number
}

const KNOWN_VARIANT_ID = /^(tax_[a-f0-9]{24}):(white|black)$/u

function parseVariantId(lineId: string): { sourceLineId: string; trainedSide: 'white' | 'black' } | null {
  const match = KNOWN_VARIANT_ID.exec(lineId)
  if (!match?.[1] || (match[2] !== 'white' && match[2] !== 'black')) return null
  return { sourceLineId: match[1], trainedSide: match[2] }
}

function newestIso(cards: readonly CardProgress[]): string | null {
  let newest = Number.NEGATIVE_INFINITY
  for (const card of cards) {
    if (card.lastReviewedAt === null) continue
    newest = Math.max(newest, Date.parse(card.lastReviewedAt))
  }
  return Number.isFinite(newest) ? new Date(newest).toISOString() : null
}

function newestOf(values: readonly (string | null)[]): string | null {
  let newest = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (value === null) continue
    newest = Math.max(newest, Date.parse(value))
  }
  return Number.isFinite(newest) ? new Date(newest).toISOString() : null
}

function distinctNodeCards(cards: readonly CardProgress[]): CardProgress[] {
  const cardsByNode = new Map<string, CardProgress>()
  for (const card of cards) {
    const previous = cardsByNode.get(card.nodeId)
    if (!previous) {
      cardsByNode.set(card.nodeId, card)
      continue
    }
    const previousReview = previous.lastReviewedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.lastReviewedAt)
    const candidateReview = card.lastReviewedAt === null ? Number.NEGATIVE_INFINITY : Date.parse(card.lastReviewedAt)
    if (candidateReview > previousReview || (candidateReview === previousReview && card.reviewCount > previous.reviewCount)) {
      cardsByNode.set(card.nodeId, card)
    }
  }
  return [...cardsByNode.values()]
}

function validVariantNodeId(
  nodeId: string,
  variantId: string,
  trainedSide: 'white' | 'black',
  cardCount: number,
): boolean {
  const prefix = `${variantId}:ply-`
  if (!nodeId.startsWith(prefix)) return false
  const rawPly = nodeId.slice(prefix.length)
  if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(rawPly)) return false
  const ply = Number(rawPly)
  const firstPly = trainedSide === 'white' ? 0 : 1
  return ply >= firstPly && ply < firstPly + cardCount * 2 && (ply - firstPly) % 2 === 0
}

function metricsForVariation(
  definition: Omit<VariationProgressSummary, 'mastery' | 'reviewedCards' | 'dueCards' | 'totalCards' | 'excludedCards' | 'lastReviewedAt' | 'streak'>,
  cards: readonly CardProgress[],
  catalogCardCount: number | null,
  nowMs: number,
  streak: number,
): VariationMetrics {
  const eligibleCards = catalogCardCount === null || definition.trainedSide === null
    ? cards
    : cards.filter((card) => validVariantNodeId(
      card.nodeId,
      definition.id,
      definition.trainedSide!,
      catalogCardCount,
    ))
  const distinctCards = distinctNodeCards(eligibleCards)
  const totalCards = catalogCardCount ?? distinctCards.length
  const reviewedCards = Math.min(totalCards, distinctCards.filter((card) => card.reviewCount > 0).length)
  const trackedDue = distinctCards.filter((card) => Date.parse(card.dueAt) <= nowMs).length
  const untrackedDue = Math.max(0, totalCards - distinctCards.length)
  const dueCards = Math.min(totalCards, trackedDue + untrackedDue)
  const masteryPoints = Math.min(
    totalCards * 100,
    distinctCards.reduce((sum, card) => sum + masteryPercent(card), 0),
  )
  return {
    ...definition,
    mastery: totalCards === 0 ? 0 : Math.round(masteryPoints / totalCards),
    masteryPoints,
    reviewedCards,
    dueCards,
    totalCards,
    excludedCards: cards.length - distinctCards.length,
    lastReviewedAt: newestIso(distinctCards),
    streak,
  }
}

function progressOrder(
  left: Pick<VariationProgressSummary, 'lastReviewedAt' | 'name'>,
  right: Pick<VariationProgressSummary, 'lastReviewedAt' | 'name'>,
): number {
  const leftTime = left.lastReviewedAt === null ? 0 : Date.parse(left.lastReviewedAt)
  const rightTime = right.lastReviewedAt === null ? 0 : Date.parse(right.lastReviewedAt)
  return rightTime - leftTime
    || left.name.localeCompare(right.name, 'en')
}

/**
 * Builds progress rows without loading ECO partitions. A started opening includes
 * every currently drillable learner-side card in that opening, so unreviewed
 * positions contribute 0 mastery and are counted as due.
 */
export function summarizeProgress(
  cards: readonly CardProgress[],
  variants: readonly ProgressVariantCatalogEntry[],
  searchEntries: readonly OpeningSearchEntry[],
  now = new Date(),
  openingStreaks: Readonly<Record<string, { current: number }>> = {},
  variationStreaks: Readonly<Record<string, { current: number }>> = {},
): ProgressSummaries {
  if (Number.isNaN(now.getTime())) throw new Error('Progress summary time is invalid')
  const cardsByVariant = new Map<string, CardProgress[]>()
  for (const card of cards) {
    const grouped = cardsByVariant.get(card.lineId) ?? []
    grouped.push(card)
    cardsByVariant.set(card.lineId, grouped)
  }

  const searchBySource = new Map(searchEntries.map((entry) => [entry.sourceLineId, entry] as const))
  const variantById = new Map(variants.map((variant) => [variant.id, variant] as const))
  const startedSources = new Set<string>()
  for (const lineId of cardsByVariant.keys()) {
    const known = variantById.get(lineId)
    if (known) {
      startedSources.add(known.sourceLineId)
      continue
    }
    const parsed = parseVariantId(lineId)
    if (parsed && searchBySource.has(parsed.sourceLineId)) startedSources.add(parsed.sourceLineId)
  }

  const metrics: VariationMetrics[] = []
  for (const variant of variants) {
    if (!startedSources.has(variant.sourceLineId)) continue
    metrics.push(metricsForVariation({
      id: variant.id,
      sourceLineId: variant.sourceLineId,
      eco: variant.eco,
      name: variant.name,
      trainedSide: variant.trainedSide,
      availableInCurrentSnapshot: true,
    }, cardsByVariant.get(variant.id) ?? [], variant.cardCount, now.getTime(), variationStreaks[variant.id]?.current ?? 0))
  }

  for (const [lineId, variantCards] of cardsByVariant) {
    if (variantById.has(lineId)) continue
    const parsed = parseVariantId(lineId)
    const source = parsed ? searchBySource.get(parsed.sourceLineId) : undefined
    metrics.push(metricsForVariation({
      id: lineId,
      sourceLineId: source?.sourceLineId ?? null,
      eco: source?.eco ?? null,
      name: source?.name ?? 'Unknown imported opening',
      trainedSide: parsed?.trainedSide ?? null,
      availableInCurrentSnapshot: false,
    }, variantCards, null, now.getTime(), variationStreaks[lineId]?.current ?? 0))
  }

  metrics.sort(progressOrder)
  const metricsByOpening = new Map<string, VariationMetrics[]>()
  for (const variation of metrics) {
    const key = variation.sourceLineId ?? `unknown:${variation.id}`
    const grouped = metricsByOpening.get(key) ?? []
    grouped.push(variation)
    metricsByOpening.set(key, grouped)
  }

  const openings: OpeningProgressSummary[] = [...metricsByOpening.entries()].map(([id, grouped]) => {
    const first = grouped[0]!
    const totalCards = grouped.reduce((sum, variation) => sum + variation.totalCards, 0)
    const masteryPoints = grouped.reduce((sum, variation) => sum + variation.masteryPoints, 0)
    return {
      id,
      sourceLineId: first.sourceLineId,
      eco: first.eco,
      name: first.name,
      mastery: totalCards === 0 ? 0 : Math.round(masteryPoints / totalCards),
      reviewedCards: grouped.reduce((sum, variation) => sum + variation.reviewedCards, 0),
      dueCards: grouped.reduce((sum, variation) => sum + variation.dueCards, 0),
      totalCards,
      excludedCards: grouped.reduce((sum, variation) => sum + variation.excludedCards, 0),
      lastReviewedAt: newestOf(grouped.map((variation) => variation.lastReviewedAt)),
      streak: openingStreaks[id]?.current ?? 0,
      variations: grouped.map(({ masteryPoints: _masteryPoints, ...variation }) => variation),
    }
  })
  openings.sort(progressOrder)

  const totalCards = metrics.reduce((sum, variation) => sum + variation.totalCards, 0)
  const masteryPoints = metrics.reduce((sum, variation) => sum + variation.masteryPoints, 0)
  return {
    openings,
    variations: metrics.map(({ masteryPoints: _masteryPoints, ...variation }) => variation),
    mastery: totalCards === 0 ? 0 : Math.round(masteryPoints / totalCards),
    reviewedCards: metrics.reduce((sum, variation) => sum + variation.reviewedCards, 0),
    dueCards: metrics.reduce((sum, variation) => sum + variation.dueCards, 0),
    totalCards,
    excludedCards: metrics.reduce((sum, variation) => sum + variation.excludedCards, 0),
  }
}
