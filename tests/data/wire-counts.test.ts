import assert from 'node:assert/strict'
import test from 'node:test'
import fc from 'fast-check'
import { z } from 'zod'
import { WireCountsSchema } from '../../src/data/wire.ts'

const ReferenceCountsSchema = z.array(z.number().int().nonnegative()).length(15)

test('optimized wire counts preserve the reference Zod contract for JSON-compatible values', () => {
  fc.assert(fc.property(fc.anything({ maxDepth: 3 }), (value) => {
    assert.equal(
      WireCountsSchema.safeParse(value).success,
      ReferenceCountsSchema.safeParse(value).success,
    )
  }), { numRuns: 2_000 })
})

test('optimized wire counts reject every numeric boundary rejected by the reference schema', () => {
  const valid = Array.from({ length: 15 }, (_, index) => index)
  const replacing = (replacement: unknown): unknown[] => {
    const copy: unknown[] = [...valid]
    copy[0] = replacement
    return copy
  }
  const invalidValues = [
    [...valid.slice(0, 14)],
    [...valid, 15],
    replacing(-1),
    replacing(0.5),
    replacing(Number.NaN),
    replacing(Number.POSITIVE_INFINITY),
    replacing(Number.MAX_SAFE_INTEGER + 1),
    replacing('0'),
  ]
  assert.equal(WireCountsSchema.safeParse(valid).success, true)
  for (const value of invalidValues) {
    assert.equal(WireCountsSchema.safeParse(value).success, false)
    assert.equal(ReferenceCountsSchema.safeParse(value).success, false)
  }
})

test('optimized wire counts reject sparse, array-like, accessor, and inherited hostile shapes', () => {
  const sparse = new Array<number>(15)
  const arrayLike = Object.assign(Object.create(Array.prototype) as Record<string, unknown>, {
    length: 15,
    0: 0,
  })
  const accessor = Array.from({ length: 15 }, (_, index) => index)
  Object.defineProperty(accessor, 0, { enumerable: true, get: () => 0 })
  const inherited = Array.from({ length: 15 }, (_, index) => index)
  delete inherited[0]
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: 0 }))
  const hostilePrototype = Array.from({ length: 15 }, (_, index) => index)
  Object.setPrototypeOf(hostilePrototype, Object.assign(Object.create(Array.prototype), { polluted: true }))

  for (const value of [sparse, arrayLike, accessor, inherited, hostilePrototype]) {
    assert.equal(WireCountsSchema.safeParse(value).success, false)
  }
})

test('optimized wire counts retain the dense parsed array shape consumed read-only by hydration', () => {
  const input = Array.from({ length: 15 }, (_, index) => index)
  const parsed = WireCountsSchema.parse(input)
  assert.equal(parsed, input)
  assert.deepEqual(parsed, ReferenceCountsSchema.parse(input))
  assert.equal(Object.getPrototypeOf(parsed), Array.prototype)
  assert.equal(Object.keys(parsed).length, 15)
})
