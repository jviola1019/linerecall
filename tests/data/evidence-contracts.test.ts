import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  LichessPuzzleManifestSchema,
  LichessStandardManifestSchema,
  canonicalRatingBandFor,
  lichessBeginnerDetailBandFor,
  stableCardId,
  stablePositionId,
} from '../../scripts/data/evidence-contracts.ts'

test('connected-source manifests pin approved licenses and exact published Q2 totals', async () => {
  const standard = LichessStandardManifestSchema.parse(
    JSON.parse(await readFile('data/manifests/lichess-standard-q2-2026.source.json', 'utf8')),
  )
  const puzzles = LichessPuzzleManifestSchema.parse(
    JSON.parse(await readFile('data/manifests/lichess-puzzles.source.json', 'utf8')),
  )
  assert.equal(standard.archives.reduce((sum, archive) => sum + archive.games, 0), 267_333_507)
  assert.equal(standard.archives.reduce((sum, archive) => sum + archive.bytes, 0), 87_256_474_116)
  assert.equal(standard.license.spdxId, 'CC0-1.0')
  assert.equal(puzzles.source.publishedPuzzleTotal, 6_057_356)
  assert.equal(puzzles.artifact.bytes, 302_111_223)
  assert.equal(puzzles.artifact.sha256, null)
  assert.equal(puzzles.artifact.integrityStatus, 'pending-local-digest')
})

test('evidence bands keep the canonical rating cohort separate from Lichess beginner detail', () => {
  assert.equal(canonicalRatingBandFor(1199, 1200), '<1800')
  assert.equal(lichessBeginnerDetailBandFor(1199, 1200), '<1200')
  assert.equal(lichessBeginnerDetailBandFor(1200, 1200), '1200-1499')
  assert.equal(lichessBeginnerDetailBandFor(1500, 1500), '1500-1799')
  assert.equal(lichessBeginnerDetailBandFor(1800, 1800), null)
  assert.equal(canonicalRatingBandFor(2400, 2400), '2400+')
})

test('position and card identities are stable and pack-scoped', () => {
  const epd = '8/8/8/8/8/8/4K3/7k w - -'
  assert.match(stablePositionId(epd), /^pos_[a-f0-9]{16}$/u)
  assert.equal(stablePositionId(epd), stablePositionId(epd))
  assert.equal(stableCardId('white_core', epd), `white_core::${stablePositionId(epd)}`)
  assert.notEqual(stableCardId('white_core', epd), stableCardId('black_core', epd))
})
