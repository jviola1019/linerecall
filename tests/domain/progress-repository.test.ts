import assert from 'node:assert/strict'
import test from 'node:test'
import { createCard, createEmptyProgress, type ProgressRepository } from '../../src/domain/progress.ts'
import {
  DebouncedProgressWriter,
  MemoryProgressRepository,
  exportProgressJson,
  importProgressJson,
  migrateProgress,
  selectProgressRepository,
  withProgressStorageTimeout,
} from '../../src/infrastructure/progress-repository.ts'

test('memory repository clones values and progress JSON round-trips', async () => {
  const progress = createEmptyProgress(new Date('2026-07-11T00:00:00.000Z'))
  const card = createCard('line::node', 'line', 'node', new Date('2026-07-11T00:00:00.000Z'))
  progress.cards[card.cardId] = card
  const repository = new MemoryProgressRepository()
  await repository.save(progress)
  progress.cards['line::node']!.intervalDays = 99
  const loaded = await repository.load()
  assert.ok(loaded)
  assert.equal(loaded.cards['line::node']?.intervalDays, 0)
  assert.deepEqual(importProgressJson(exportProgressJson(loaded)), loaded)
})

test('legacy version zero records migrate with safe defaults', () => {
  const card = createCard('line::node', 'line', 'node', new Date('2026-07-11T00:00:00.000Z'))
  const { reviewCount: _reviewCount, lapseCount: _lapseCount, ...legacyCard } = card
  const migrated = migrateProgress({
    version: 0,
    updatedAt: '2026-07-11T00:00:00.000Z',
    cards: { 'line::node': legacyCard },
  })
  assert.equal(migrated.version, 1)
  assert.equal(migrated.cards['line::node']?.reviewCount, 0)
  assert.equal(migrated.settings.theme, 'dark')
  assert.deepEqual(migrated.openingStreaks, {})
  assert.deepEqual(migrated.variationStreaks, {})

  const completeLegacy = migrateProgress({
    version: 0,
    updatedAt: '2026-07-11T00:00:00.000Z',
    cards: { 'line::node': { ...legacyCard, reviewCount: 4, lapseCount: 2 } },
    streak: { current: 3, lastLocalDate: '2026-07-11' },
    settings: { theme: 'light', boardOrientation: 'black' },
  })
  assert.equal(completeLegacy.cards['line::node']?.reviewCount, 4)
  assert.deepEqual(completeLegacy.streak, { current: 3, lastLocalDate: '2026-07-11' })
  assert.equal(completeLegacy.settings.theme, 'light')
  assert.deepEqual(migrateProgress(completeLegacy), completeLegacy)
})

test('progress import rejects oversized, NUL, malformed, and unknown versions', () => {
  assert.throws(() => importProgressJson('x'.repeat(1024 * 1024 + 1)), /1 MB/u)
  assert.throws(() => importProgressJson('{"x":"\u0000"}'), /NUL/u)
  assert.throws(() => importProgressJson('{'), /valid JSON/u)
  assert.throws(() => importProgressJson('{"version":99}'), /unsupported version/u)
  assert.throws(() => importProgressJson(`{"value":"${String.fromCharCode(0xd800)}"}`), /malformed Unicode/u)
  assert.throws(() => importProgressJson(`{"value":"${String.fromCharCode(0xdc00)}"}`), /malformed Unicode/u)

  const card = { ...createCard('line::node', 'line', 'node', new Date('2026-07-11T00:00:00.000Z')), cardId: '__proto__' }
  const reservedKey = exportProgressJson(createEmptyProgress(new Date('2026-07-11T00:00:00.000Z')))
    .replace('"cards": {}', `"cards": {"__proto__":${JSON.stringify(card)}}`)
  assert.throws(() => importProgressJson(reservedKey), /invalid fields/u)
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined)
})

test('debounced writer surfaces save failures without throwing from the timer', async () => {
  const failures: Error[] = []
  const repository: ProgressRepository = {
    kind: 'memory',
    load: async () => null,
    save: async () => { throw new Error('quota rejected') },
    clear: async () => undefined,
  }
  const writer = new DebouncedProgressWriter(repository, (error) => failures.push(error), 1)
  writer.schedule(createEmptyProgress(new Date('2026-07-11T00:00:00.000Z')))
  await writer.flush()
  assert.match(failures[0]?.message ?? '', /quota rejected/u)
})

test('memory repository supports initial values, clearing, and strict validation', async () => {
  const progress = createEmptyProgress(new Date('2026-07-11T00:00:00.000Z'))
  const repository = new MemoryProgressRepository(progress)
  assert.deepEqual(await repository.load(), progress)
  await repository.clear()
  assert.equal(await repository.load(), null)
  const invalid = { ...progress, cards: { mismatch: createCard('line::node', 'line', 'node', new Date()) } }
  await assert.rejects(repository.save(invalid))
  assert.throws(() => new MemoryProgressRepository(invalid))
})

test('progress rejects cross-field card identity corruption and bounds hung storage operations', async () => {
  const progress = createEmptyProgress(new Date('2026-07-11T00:00:00.000Z'))
  const valid = createCard('line::node', 'line', 'node', new Date('2026-07-11T00:00:00.000Z'))
  const corrupt = JSON.stringify({
    ...progress,
    cards: { 'line::node': { ...valid, nodeId: 'other-node' } },
  })
  assert.throws(() => importProgressJson(corrupt), /invalid fields/u)

  await assert.rejects(
    withProgressStorageTimeout(new Promise<never>(() => undefined), 'Test progress read', 5),
    /Test progress read timed out after 5 ms/u,
  )
  assert.throws(
    () => withProgressStorageTimeout(Promise.resolve('unused'), 'Invalid timeout', 0),
    /positive duration/u,
  )

  assert.equal(await withProgressStorageTimeout(Promise.resolve('stored'), 'Resolved storage', 50), 'stored')
  await assert.rejects(
    withProgressStorageTimeout(Promise.reject(new Error('storage rejected')), 'Rejected storage', 50),
    /storage rejected/u,
  )
})

test('repository selection honors the no-browser-storage boundary', async () => {
  const selected = await selectProgressRepository()
  assert.equal(selected.repository.kind, 'memory')
  assert.match(selected.warning ?? '', /session-only/iu)
  assert.equal('indexedDB' in selected.repository, false)
})

test('debounced writes keep the newest pending state, serialize saves, and normalize thrown values', async () => {
  const saved: string[] = []
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  let calls = 0
  const repository: ProgressRepository = {
    kind: 'memory',
    load: async () => null,
    clear: async () => undefined,
    save: async (progress) => {
      calls += 1
      if (calls === 1) await firstGate
      saved.push(progress.updatedAt)
      if (calls === 2) throw 'non-error rejection'
    },
  }
  const errors: Error[] = []
  const writer = new DebouncedProgressWriter(repository, (error) => errors.push(error), 60_000)
  const first = createEmptyProgress(new Date('2026-07-11T00:00:00.000Z'))
  const replaced = createEmptyProgress(new Date('2026-07-11T01:00:00.000Z'))
  writer.schedule(first)
  writer.schedule(replaced)
  const firstFlush = writer.flush()
  const second = createEmptyProgress(new Date('2026-07-11T02:00:00.000Z'))
  writer.schedule(second)
  const secondFlush = writer.flush()
  releaseFirst?.()
  await Promise.all([firstFlush, secondFlush])
  await writer.flush()
  assert.deepEqual(saved, [replaced.updatedAt, second.updatedAt])
  assert.match(errors[0]?.message ?? '', /non-error rejection/u)
})

test('debounced writer executes its scheduled timer without an explicit flush', async () => {
  const saved: string[] = []
  const repository: ProgressRepository = {
    kind: 'memory',
    load: async () => null,
    clear: async () => undefined,
    save: async (progress) => { saved.push(progress.updatedAt) },
  }
  const progress = createEmptyProgress(new Date('2026-07-11T03:00:00.000Z'))
  const writer = new DebouncedProgressWriter(repository, () => undefined, 1)
  writer.schedule(progress)
  await new Promise((resolve) => setTimeout(resolve, 20))
  await writer.flush()
  assert.deepEqual(saved, [progress.updatedAt])
})
