import { describe, expect, it, vi } from 'vitest'
import { createCard } from '../../src/domain/progress.ts'
import { CloudProgressRepository, ConnectedSyncClient } from '../src/sync-client.ts'

const SERVER_TIME = '2026-07-14T12:00:00.000Z'
const SETTINGS = {
  version: 0,
  value: { locale: 'en-US', theme: 'dark', manualPacing: false, reducedMotion: false, boardCoordinates: true },
}

function response(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    acceptedEventIds: [],
    rejectedEvents: [],
    cards: [],
    settings: SETTINGS,
    nextCursor: '0',
    hasMore: false,
    serverTime: SERVER_TIME,
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('connected append-only sync', () => {
  it('keeps the export anchor and object URL available for deferred browser download dispatch', () => {
    const createObjectURL = vi.fn(() => 'blob:linerecall-export')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const client = new ConnectedSyncClient({
      snapshotVersion: 'wire_test',
      origin: 'https://app.example.test',
      fetcher: async () => response(),
    })

    client.exportUnsynced()

    const anchor = document.body.querySelector<HTMLAnchorElement>('a[download]')
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(anchor?.download).toMatch(/^linerecall-unsynced-\d{4}-\d{2}-\d{2}\.json$/u)
    expect(revokeObjectURL).not.toHaveBeenCalled()
    anchor?.remove()
    click.mockRestore()
  })

  it('bootstraps strict server cards and queues a UUIDv7 review event', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/bootstrap')) {
        return response({
          cards: [{
            cardId: 'tax_aaaaaaaaaaaaaaaaaaaaaaaa:white::node_1',
            repetitions: 2,
            intervalDays: 6,
            easeFactor: 2.5,
            dueAt: '2026-07-20T12:00:00.000Z',
            lastReviewedAt: SERVER_TIME,
            mastery: 57,
            lastEventId: '018f22d8-6d4a-7abc-8def-0123456789ab',
            syncSequence: '4',
          }],
          nextCursor: '4',
        })
      }
      const body = JSON.parse(String(init?.body)) as { events: Array<{ eventId: string }> }
      return response({ acceptedEventIds: body.events.map((event) => event.eventId), nextCursor: '5' })
    })
    const client = new ConnectedSyncClient({ snapshotVersion: 'wire_test', origin: 'https://app.example.test', fetcher })
    const repository = new CloudProgressRepository(client)
    const progress = await repository.load()
    expect(progress?.cards['tax_aaaaaaaaaaaaaaaaaaaaaaaa:white::node_1']?.intervalDays).toBe(6)

    const card = createCard('tax_aaaaaaaaaaaaaaaaaaaaaaaa:white::node_1', 'tax_aaaaaaaaaaaaaaaaaaaaaaaa:white', 'node_1', new Date(SERVER_TIME))
    const id = client.queueReview({ kind: 'review', grade: 'good', lineId: card.lineId, nodeId: card.nodeId, occurredAt: SERVER_TIME, card })
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    await client.flush()
    expect(client.pendingCount).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('keeps rejected membership events out of retry loops and rejects invalid corrections', async () => {
    let eventId = ''
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('bootstrap')) return response()
      const body = JSON.parse(String(init?.body)) as { events: Array<{ eventId: string }> }
      eventId = body.events[0]?.eventId ?? ''
      return response({ rejectedEvents: [{ eventId, code: 'unknown_card_membership', message: 'Unknown card' }] })
    })
    const client = new ConnectedSyncClient({ snapshotVersion: 'wire_test', origin: 'https://app.example.test', fetcher })
    await client.bootstrap()
    const card = createCard('tax_aaaaaaaaaaaaaaaaaaaaaaaa:white::node_1', 'tax_aaaaaaaaaaaaaaaaaaaaaaaa:white', 'node_1', new Date(SERVER_TIME))
    expect(() => client.queueReview({ kind: 'correction', grade: 'hard', lineId: card.lineId, nodeId: card.nodeId, occurredAt: SERVER_TIME, card }))
      .toThrow(/must reference/)
    client.queueReview({ kind: 'review', grade: 'again', lineId: card.lineId, nodeId: card.nodeId, occurredAt: SERVER_TIME, card })
    await client.flush()
    expect(eventId).not.toBe('')
    expect(client.pendingCount).toBe(0)
  })

  it('fails closed on malformed card projections without replacing local state', async () => {
    const client = new ConnectedSyncClient({
      snapshotVersion: 'wire_test',
      origin: 'https://app.example.test',
      fetcher: async () => response({ cards: [{ cardId: '<script>' }] }),
    })
    await expect(client.bootstrap()).rejects.toThrow(/strict validation|invalid response/i)
  })

  it('queues puzzle history separately and removes an idempotently accepted attempt', async () => {
    const puzzleIds: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/puzzles/attempts') {
        const puzzleRequest = JSON.parse(String(init?.body)) as { attempts: Array<{ attemptId: string; puzzleId: string }> }
        puzzleIds.push(...puzzleRequest.attempts.map((attempt) => attempt.puzzleId))
        return new Response(JSON.stringify({
          acceptedAttemptIds: puzzleRequest?.attempts.map((attempt) => attempt.attemptId) ?? [],
          rejectedAttempts: [],
          progress: [{ puzzleId: 'puzzle-001', attempts: 1, solved: 1, lastAttemptAt: SERVER_TIME, syncSequence: '1' }],
          serverTime: SERVER_TIME,
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return response()
    })
    const client = new ConnectedSyncClient({ snapshotVersion: 'wire_test', origin: 'https://app.example.test', fetcher })
    const attemptId = client.queuePuzzleAttempt('puzzle-001', SERVER_TIME)
    expect(attemptId).toMatch(/-7[0-9a-f]{3}-/u)
    await client.flush()
    expect(puzzleIds).toEqual(['puzzle-001'])
    expect(client.pendingCount).toBe(0)
  })
})
