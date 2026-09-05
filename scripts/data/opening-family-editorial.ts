import type { ReviewOpeningFamilyCatalogV1 } from '../../src/data/review-family-catalog.ts'
import {
  validateOpeningFamilyEditorialLedger,
  type OpeningFamilyEditorialLedgerV1,
} from '../../src/domain/opening-family-editorial.ts'

const TAXONOMY_SOURCE = 'https://github.com/lichess-org/chess-openings/tree/17ee660257de02870636f36248e919f2e01d8e85'

/**
 * Materialize the mechanical grouping as a review worksheet, never as an
 * editorial approval. Every candidate is pending and promotionEligible is
 * false until named chess/taxonomy editors replace it with a reviewed ledger.
 */
export function createPendingOpeningFamilyEditorialLedger(
  catalog: ReviewOpeningFamilyCatalogV1,
): OpeningFamilyEditorialLedgerV1 {
  return validateOpeningFamilyEditorialLedger({
    schemaVersion: 1,
    kind: 'linerecall-opening-family-editorial-ledger',
    releaseId: `editorial-proposal-${catalog.taxonomyCommit.slice(0, 12)}`,
    generatedAt: catalog.generatedAt,
    taxonomyCommit: catalog.taxonomyCommit,
    taxonomyLineCount: 3_790,
    proposedFamilyCount: 149,
    editorialStatus: 'pending',
    promotionEligible: false,
    automatedProposalMethod: 'lichess-name-prefix-plus-regression-overrides',
    decisions: catalog.families.map((family) => ({
      schemaVersion: 1,
      candidateFamilyId: family.id,
      candidateCanonicalName: family.canonicalName,
      candidateTaxonomyLineIds: family.taxonomyLineIds,
      reviewStatus: 'pending',
      decision: null,
      reviewer: null,
      reviewedAt: null,
      rationale: null,
      sourceReferences: [TAXONOMY_SOURCE],
    })),
    families: catalog.families.map((family) => ({
      schemaVersion: 1,
      id: family.id,
      canonicalName: family.canonicalName,
      aliases: family.aliases,
      ecoCodes: family.ecoCodes,
      parentFamilyId: null,
      primaryTaxonomyLineIds: family.taxonomyLineIds,
      secondaryFamilyLinks: [],
    })),
    sourceReferences: [TAXONOMY_SOURCE],
    note: 'Automated review worksheet only. Names before the first colon and three deterministic regression mappings produced these candidates; no human chess, taxonomy, trademark, or localization review is claimed.',
  })
}
