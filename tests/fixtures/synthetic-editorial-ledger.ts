export interface SyntheticEditorialFamily {
  id: string
  canonicalName: string
  aliases: string[]
  ecoCodes: string[]
  taxonomyLineIds: string[]
}

export interface SyntheticCandidateFamily {
  familyId: string
  canonicalName: string
  taxonomyLineIds: string[]
}

const SOURCE = 'https://github.com/lichess-org/chess-openings/tree/17ee660257de02870636f36248e919f2e01d8e85'

export async function loadPinnedTaxonomyInventoryFixture(): Promise<PinnedTaxonomyInventoryV1> {
  const url = new URL('../../data/manifests/taxonomy.inventory.v1.json', import.meta.url)
  return PinnedTaxonomyInventoryV1Schema.parse(JSON.parse(await readFile(url, 'utf8')) as unknown)
}

/** Synthetic contract evidence only; none of these reviewer fields are release evidence. */
export function createSyntheticApprovedEditorialLedger(options: {
  releaseId: string
  families: SyntheticEditorialFamily[]
  candidateFamilies?: SyntheticCandidateFamily[]
}) {
  const allTaxonomyLineIds = options.families.flatMap(({ taxonomyLineIds }) => taxonomyLineIds)
  if (allTaxonomyLineIds.length !== 3_790 || new Set(allTaxonomyLineIds).size !== 3_790) {
    throw new Error('Synthetic editorial ledger requires exactly 3,790 unique taxonomy rows')
  }
  const owner = new Map(options.families.flatMap((family) =>
    family.taxonomyLineIds.map((taxonomyLineId) => [taxonomyLineId, family.id] as const)))
  const candidateFamilies = options.candidateFamilies ?? Array.from({ length: 149 }, (_, index) => {
    const start = Math.floor(index * allTaxonomyLineIds.length / 149)
    const end = Math.floor((index + 1) * allTaxonomyLineIds.length / 149)
    return {
      familyId: `proposal-${String(index + 1).padStart(3, '0')}`,
      canonicalName: `Synthetic proposal ${index + 1}`,
      taxonomyLineIds: allTaxonomyLineIds.slice(start, end),
    }
  })
  if (candidateFamilies.length !== 149) throw new Error('Synthetic editorial ledger requires exactly 149 candidate families')
  const candidateIds = candidateFamilies.flatMap(({ taxonomyLineIds }) => taxonomyLineIds)
  if (
    candidateIds.length !== 3_790 || new Set(candidateIds).size !== 3_790
    || candidateIds.some((id) => !owner.has(id))
  ) throw new Error('Synthetic candidate families must own the exact final taxonomy row universe')
  const decisions = candidateFamilies.map((candidate) => {
    const candidateTaxonomyLineIds = candidate.taxonomyLineIds
    const resultingFamilyIds = [...new Set(candidateTaxonomyLineIds.map((id) => owner.get(id)!))].sort()
    return {
      schemaVersion: 1,
      candidateFamilyId: candidate.familyId,
      candidateCanonicalName: candidate.canonicalName,
      candidateTaxonomyLineIds,
      reviewStatus: 'approved',
      decision: {
        action: resultingFamilyIds.length > 1 ? 'split' : 'merge',
        resultingFamilyIds,
      },
      reviewer: { name: 'Synthetic fixture editor', role: 'chess-editor' },
      reviewedAt: '2026-07-28T12:00:00.000Z',
      rationale: 'Synthetic fixture decision for fail-closed contract coverage only.',
      sourceReferences: [SOURCE],
    }
  })
  return {
    schemaVersion: 1,
    kind: 'linerecall-opening-family-editorial-ledger',
    releaseId: options.releaseId,
    generatedAt: '2026-07-28T12:00:00.000Z',
    taxonomyCommit: '17ee660257de02870636f36248e919f2e01d8e85',
    taxonomyLineCount: 3_790,
    proposedFamilyCount: 149,
    editorialStatus: 'approved',
    promotionEligible: true,
    automatedProposalMethod: 'lichess-name-prefix-plus-regression-overrides',
    decisions,
    families: options.families.map((family) => ({
      schemaVersion: 1,
      id: family.id,
      canonicalName: family.canonicalName,
      aliases: family.aliases,
      ecoCodes: family.ecoCodes,
      parentFamilyId: null,
      primaryTaxonomyLineIds: family.taxonomyLineIds,
      secondaryFamilyLinks: [],
    })),
    sourceReferences: [SOURCE],
    note: 'Synthetic approved ledger used only to exercise promotion contracts; it is not human or production evidence.',
  }
}
import { readFile } from 'node:fs/promises'
import {
  PinnedTaxonomyInventoryV1Schema,
  type PinnedTaxonomyInventoryV1,
} from '../../scripts/data/taxonomy-inventory.ts'
