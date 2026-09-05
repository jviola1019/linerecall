import { describe, expect, it, vi } from 'vitest'
import type { FamilyCoverageEventV1, FamilyTrainingCursorV1 } from '../../src/domain/opening-family.ts'
import { CloudFamilyTrainingJournalRepository } from '../src/family-training-client.ts'

const DEVICE_ID = '0198a5c0-1000-7000-8000-000000000001'
const RELEASE = 'release-2026q2'
const FAMILY = 'caro-kann'
const PACK = 'caro_kann_black'
const SERVER_TIME = '2026-07-14T12:00:00.000Z'

function pathId(index: number): string {
  return `path_${index.toString(16).padStart(20, '0')}`
}

function cardId(index: number): string {
  return `${PACK}::pos_${index.toString(16).padStart(16, '0')}`
}

function coverageEvent(): FamilyCoverageEventV1 {
  return {
    schemaVersion: 1,
    eventId: '0198a5c0-1000-7000-8000-000000000101',
    releaseId: RELEASE,
    familyId: FAMILY,
    packId: PACK,
    pathId: pathId(0),
    coverageCycleId: `${PACK}::coverage:0`,
    completedAt: '2026-07-14T11:59:00.000Z',
  }
}

function syncResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    acceptedCoverageEventIds: [],
    acceptedCycleEventIds: [],
    rejectedRecords: [],
    cursor: null,
    cursorStatus: null,
    serverTime: SERVER_TIME,
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('hosted unified-family journal', () => {
  it('keeps a failed coverage write in memory and retries the same immutable event', async () => {
    const event = coverageEvent()
    let available = false
    const sentIds: string[] = []
    const errors: string[] = []
    const pending: number[] = []
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { coverageEvents: FamilyCoverageEventV1[] }
      sentIds.push(request.coverageEvents[0]!.eventId)
      if (!available) throw new TypeError('network unavailable')
      return syncResponse({ acceptedCoverageEventIds: [event.eventId] })
    })
    const repository = new CloudFamilyTrainingJournalRepository({
      deviceId: DEVICE_ID,
      origin: 'https://app.example.test',
      fetcher,
      onError: (error) => errors.push(error.message),
      onPendingChange: (count) => pending.push(count),
    })

    await expect(repository.appendCoverageEvent(event)).resolves.toBe('appended')
    expect(repository.pendingCount).toBe(1)
    expect(repository.exportPendingRecords().pendingFamilyCoverageEvents).toEqual([event])
    expect(await repository.listCoverageEvents({ releaseId: RELEASE, familyId: FAMILY })).toEqual([event])
    available = true
    await repository.flush()
    expect(repository.pendingCount).toBe(0)
    expect(sentIds).toEqual([event.eventId, event.eventId])
    expect(errors).toContain('network unavailable')
    expect(pending).toEqual([1, 0])
  })

  it('uploads and restores a cursor containing more than 1,000 paths without truncation', async () => {
    const paths = Array.from({ length: 1_005 }, (_, index) => pathId(index))
    const cards = Array.from({ length: 1_005 }, (_, index) => cardId(index))
    const cursor: FamilyTrainingCursorV1 = {
      schemaVersion: 1,
      releaseId: RELEASE,
      familyId: FAMILY,
      side: 'black',
      coverageCycleId: `${PACK}::coverage:0`,
      authoritativeDueCardIds: cards,
      reviewedCardIds: [],
      completedPathIds: [],
      pendingPathIds: paths,
      batchIndex: 0,
    }
    let acceptedCursor: { mutationId: string; value: FamilyTrainingCursorV1 } | null = null
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cursor')) {
        return new Response(JSON.stringify({ cursor: null, serverTime: SERVER_TIME }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      const request = JSON.parse(String(init?.body)) as {
        cursorMutation: { mutationId: string; value: FamilyTrainingCursorV1 }
      }
      acceptedCursor = request.cursorMutation
      return syncResponse({
        cursorStatus: 'appended',
        cursor: {
          version: 1,
          mutationId: request.cursorMutation.mutationId,
          value: request.cursorMutation.value,
          syncSequence: '9',
        },
      })
    })
    const repository = new CloudFamilyTrainingJournalRepository({
      deviceId: DEVICE_ID, origin: 'https://app.example.test', fetcher,
    })

    await expect(repository.appendCursor(cursor)).resolves.toBe('appended')
    expect(acceptedCursor).not.toBeNull()
    expect((acceptedCursor as unknown as { value: FamilyTrainingCursorV1 }).value.pendingPathIds).toHaveLength(1_005)
    const restored = await repository.loadLatestCursor({
      releaseId: RELEASE, familyId: FAMILY, side: 'black', packId: PACK,
    })
    expect(restored?.pendingPathIds).toHaveLength(1_005)
    expect(restored?.pendingPathIds.at(-1)).toBe(paths.at(-1))
  })

  it('retains one mutation identity across a network retry', async () => {
    const cursor: FamilyTrainingCursorV1 = {
      schemaVersion: 1,
      releaseId: RELEASE,
      familyId: FAMILY,
      side: 'black',
      coverageCycleId: `${PACK}::coverage:0`,
      authoritativeDueCardIds: [], reviewedCardIds: [], completedPathIds: [], pendingPathIds: [pathId(0)], batchIndex: 0,
    }
    let postCount = 0
    const mutationIds: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cursor')) return new Response(JSON.stringify({ cursor: null, serverTime: SERVER_TIME }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
      const request = JSON.parse(String(init?.body)) as { cursorMutation: { mutationId: string; value: FamilyTrainingCursorV1 } }
      mutationIds.push(request.cursorMutation.mutationId)
      postCount += 1
      if (postCount === 1) throw new TypeError('connection reset')
      return syncResponse({
        cursorStatus: 'appended',
        cursor: { version: 1, mutationId: request.cursorMutation.mutationId, value: request.cursorMutation.value, syncSequence: '3' },
      })
    })
    const repository = new CloudFamilyTrainingJournalRepository({
      deviceId: DEVICE_ID, origin: 'https://app.example.test', fetcher,
    })
    await repository.appendCursor(cursor)
    expect(repository.pendingCount).toBe(1)
    await repository.flush()
    expect(repository.pendingCount).toBe(0)
    expect(mutationIds).toHaveLength(2)
    expect(new Set(mutationIds).size).toBe(1)
  })

  it('queues cumulative cursor snapshots in order after an uncertain response', async () => {
    const first: FamilyTrainingCursorV1 = {
      schemaVersion: 1, releaseId: RELEASE, familyId: FAMILY, side: 'black',
      coverageCycleId: `${PACK}::coverage:0`, authoritativeDueCardIds: [], reviewedCardIds: [],
      completedPathIds: [], pendingPathIds: [pathId(0), pathId(1)], batchIndex: 0,
    }
    const second: FamilyTrainingCursorV1 = {
      ...first, completedPathIds: [pathId(0)], pendingPathIds: [pathId(1)], batchIndex: 1,
    }
    let available = false
    let version = 0
    const posted: Array<{ mutationId: string; baseVersion: number; value: FamilyTrainingCursorV1 }> = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cursor')) return new Response(JSON.stringify({ cursor: null, serverTime: SERVER_TIME }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
      const request = JSON.parse(String(init?.body)) as { cursorMutation: { mutationId: string; baseVersion: number; value: FamilyTrainingCursorV1 } }
      posted.push(request.cursorMutation)
      if (!available) throw new TypeError('response lost')
      version += 1
      return syncResponse({
        cursorStatus: 'appended',
        cursor: { version, mutationId: request.cursorMutation.mutationId, value: request.cursorMutation.value, syncSequence: String(version) },
      })
    })
    const repository = new CloudFamilyTrainingJournalRepository({
      deviceId: DEVICE_ID, origin: 'https://app.example.test', fetcher,
    })
    await repository.appendCursor(first)
    await repository.appendCursor(second)
    expect(repository.pendingCount).toBe(2)
    available = true
    await repository.flush()
    expect(repository.pendingCount).toBe(0)
    const successful = posted.slice(-2)
    expect(successful.map(({ baseVersion }) => baseVersion)).toEqual([0, 1])
    expect(successful.map(({ value }) => value.batchIndex)).toEqual([0, 1])
    expect(successful[0]?.mutationId).toBe(posted[0]?.mutationId)
  })

  it('caches a completed family history page within the session', async () => {
    const event = coverageEvent()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      records: [{ event, syncSequence: '1' }],
      nextCursor: '1',
      hasMore: false,
      serverTime: SERVER_TIME,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const repository = new CloudFamilyTrainingJournalRepository({
      deviceId: DEVICE_ID, origin: 'https://app.example.test', fetcher,
    })
    const scope = { releaseId: RELEASE, familyId: FAMILY }
    expect(await repository.listCoverageEvents(scope)).toEqual([event])
    expect(await repository.listCoverageEvents(scope)).toEqual([event])
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
