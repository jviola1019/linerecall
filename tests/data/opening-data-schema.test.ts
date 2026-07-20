import assert from 'node:assert/strict'
import test from 'node:test'
import { BandStatsSchema } from '../../src/domain/opening-data.ts'

test('band statistics require exact raw and perspective W/D/L arithmetic', () => {
  const valid = {
    band: '2000-2199',
    n: 10,
    whiteWins: 4,
    draws: 3,
    blackWins: 3,
    wins: 4,
    losses: 3,
    winRate: 40,
    drawRate: 30,
    lossRate: 30,
    lowSample: true,
  }
  assert.equal(BandStatsSchema.parse(valid).n, 10)
  assert.equal(BandStatsSchema.safeParse({ ...valid, n: 11 }).success, false)
  assert.equal(BandStatsSchema.safeParse({ ...valid, losses: 4 }).success, false)
  assert.equal(BandStatsSchema.safeParse({ ...valid, winRate: 41 }).success, false)
})

test('empty rating bands expose no fabricated percentages', () => {
  const empty = {
    band: '<1800',
    n: 0,
    whiteWins: 0,
    draws: 0,
    blackWins: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    drawRate: null,
    lossRate: null,
    lowSample: false,
  }
  assert.equal(BandStatsSchema.parse(empty).winRate, null)
  assert.equal(BandStatsSchema.safeParse({ ...empty, winRate: 0 }).success, false)
})
