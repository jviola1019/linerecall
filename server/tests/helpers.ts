import type { ReviewEventV1 } from '../src/contracts.js'

export const NOW = new Date('2026-07-14T12:00:00.000Z')
export const DEVICE_ID = '0198a5c0-1000-7000-8000-000000000001'
export const AUDITED_MEMORY_OPTIONS = {
  supportedSnapshots: ['release-2026q2'],
  snapshotMembership: {
    'release-2026q2': [
      { packId: 'pack-e4', nodeId: 'pos_0123456789abcdef', cardId: 'pack-e4::pos_0123456789abcdef' },
      { packId: 'pack-e4', nodeId: 'pos_fedcba9876543210', cardId: 'pack-e4::pos_fedcba9876543210' },
    ],
  },
  puzzleMembership: { 'release-2026q2': ['puzzle-001'] },
} as const

export function reviewEvent(overrides: Partial<ReviewEventV1> = {}): ReviewEventV1 {
  return {
    eventId: '0198a5c0-1000-7000-8000-000000000002',
    deviceId: DEVICE_ID,
    cardId: 'pack-e4::pos_0123456789abcdef',
    packId: 'pack-e4',
    nodeId: 'pos_0123456789abcdef',
    grade: 'good',
    occurredAt: '2026-07-14T11:55:00.000Z',
    localDate: '2026-07-14',
    timeZone: 'America/New_York',
    snapshotVersion: 'release-2026q2',
    ...overrides,
  }
}
