import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeImmutableJsonCandidate } from '../../scripts/release/lib/immutable-json-receipt.ts'

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'linerecall-immutable-handoff-'))
}

test('immutable handoff refuses an existing output without changing its bytes', async () => {
  const root = await temporaryRoot()
  const existing = Buffer.from('{"release":"existing"}\n', 'utf8')
  await writeFile(join(root, 'handoff.json'), existing)

  await assert.rejects(
    writeImmutableJsonCandidate({ root, outputPath: 'handoff.json', value: { release: 'replacement' } }),
    /already exists/u,
  )
  assert.deepEqual(await readFile(join(root, 'handoff.json')), existing)
})

test('concurrent immutable promotions cannot replace the winning output', async () => {
  const root = await temporaryRoot()
  const first = await writeImmutableJsonCandidate({ root, outputPath: 'handoff.json', value: { candidate: 'first' } })
  const second = await writeImmutableJsonCandidate({ root, outputPath: 'handoff.json', value: { candidate: 'second' } })

  const outcomes = await Promise.allSettled([first.promote(), second.promote()])
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1)
  const stored = JSON.parse(await readFile(join(root, 'handoff.json'), 'utf8')) as { candidate: string }
  assert.ok(stored.candidate === 'first' || stored.candidate === 'second')
  await first.discard()
  await second.discard()
  assert.equal(
    JSON.parse(await readFile(join(root, 'handoff.json'), 'utf8')).candidate,
    stored.candidate,
  )
})
