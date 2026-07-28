import assert from 'node:assert/strict'
import test from 'node:test'
import { appHashForRoute, navViewForRoute, parseAppHash } from '../../src/app/hash-route.ts'

test('parses every public static route and defaults invalid input to Today', () => {
  for (const view of ['today', 'repertoire', 'puzzles', 'explore', 'progress', 'data'] as const) {
    assert.deepEqual(parseAppHash(`#/${view}`), { view })
  }
  assert.deepEqual(parseAppHash(''), { view: 'today' })
  assert.deepEqual(parseAppHash('#/unknown'), { view: 'today' })
  assert.deepEqual(parseAppHash('#/repertoire/%E0%A4%A'), { view: 'today' })
  assert.deepEqual(parseAppHash('#/repertoire/<script>'), { view: 'today' })
})

test('round-trips canonical family detail and training routes', () => {
  const family = { view: 'family', familyId: 'caro-kann' } as const
  const training = { view: 'train', familyId: 'sicilian-defence', side: 'black' } as const
  assert.deepEqual(parseAppHash(appHashForRoute(family)), family)
  assert.deepEqual(parseAppHash(appHashForRoute(training)), training)
  assert.equal(navViewForRoute(family), 'repertoire')
  assert.equal(navViewForRoute(training), 'repertoire')
})
