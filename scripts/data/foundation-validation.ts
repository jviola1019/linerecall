export interface ExpectedArchiveIdentity {
  archiveId: string
  sourceId: 'lichess-broadcasts' | 'lichess-standard-rated-q2-2026'
  month: string
  sha256: string
}

export interface ArchiveRunEvidence extends ExpectedArchiveIdentity {
  status: 'processing' | 'complete'
  recordsSeen: number
  accepted: number
  deduplicated: number
  rejectedJson: string
  completedAt: string | null
}

export interface ValidatedArchiveGroup {
  sourceId: ExpectedArchiveIdentity['sourceId']
  expected: number
  completed: number
  recordsSeen: number
  accepted: number
  deduplicated: number
  rejected: number
}

const SHA256 = /^[a-f0-9]{64}$/u
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u
const REJECTION = /^[a-z][a-z0-9_]{0,63}$/u

function nonnegativeInteger(value: number, field: string, archiveId: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${archiveId} has invalid ${field}`)
}

function rejectedTotal(row: ArchiveRunEvidence): number {
  let parsed: unknown
  try { parsed = JSON.parse(row.rejectedJson) as unknown } catch { throw new Error(`${row.archiveId} has malformed rejection totals`) }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${row.archiveId} has malformed rejection totals`)
  let total = 0
  for (const [reason, count] of Object.entries(parsed)) {
    if (!REJECTION.test(reason) || !Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(`${row.archiveId} has invalid rejection evidence`)
    }
    total += count as number
    if (!Number.isSafeInteger(total)) throw new Error(`${row.archiveId} rejection total exceeds the safe range`)
  }
  return total
}

export function validateGraphFoundation(input: {
  schemaVersion: string | undefined
  maximumPly: string | undefined
  expected: readonly ExpectedArchiveIdentity[]
  runs: readonly ArchiveRunEvidence[]
}): { complete: boolean; groups: ValidatedArchiveGroup[]; missing: string[] } {
  if (input.schemaVersion !== '2') throw new Error('Evidence graph schemaVersion must be 2')
  if (input.maximumPly !== '30') throw new Error('Evidence graph maximumPly must be 30')
  const expected = new Map<string, ExpectedArchiveIdentity>()
  for (const archive of input.expected) {
    if (!archive.archiveId || !MONTH.test(archive.month) || !SHA256.test(archive.sha256) || expected.has(archive.archiveId)) {
      throw new Error('Approved graph archive identities are invalid or duplicated')
    }
    expected.set(archive.archiveId, archive)
  }
  const groups = new Map<ExpectedArchiveIdentity['sourceId'], ValidatedArchiveGroup>([
    ['lichess-broadcasts', { sourceId: 'lichess-broadcasts', expected: 0, completed: 0, recordsSeen: 0, accepted: 0, deduplicated: 0, rejected: 0 }],
    ['lichess-standard-rated-q2-2026', { sourceId: 'lichess-standard-rated-q2-2026', expected: 0, completed: 0, recordsSeen: 0, accepted: 0, deduplicated: 0, rejected: 0 }],
  ])
  for (const archive of input.expected) groups.get(archive.sourceId)!.expected += 1
  const seen = new Set<string>()
  for (const row of input.runs) {
    if (seen.has(row.archiveId)) throw new Error(`Evidence graph repeats archive ${row.archiveId}`)
    seen.add(row.archiveId)
    const approved = expected.get(row.archiveId)
    if (!approved) throw new Error(`Evidence graph contains unapproved archive ${row.archiveId}`)
    if (row.sourceId !== approved.sourceId || row.month !== approved.month || row.sha256 !== approved.sha256) {
      throw new Error(`Evidence graph archive identity changed for ${row.archiveId}`)
    }
    nonnegativeInteger(row.recordsSeen, 'recordsSeen', row.archiveId)
    nonnegativeInteger(row.accepted, 'accepted', row.archiveId)
    nonnegativeInteger(row.deduplicated, 'deduplicated', row.archiveId)
    const rejected = rejectedTotal(row)
    if (row.recordsSeen !== row.accepted + row.deduplicated + rejected) {
      throw new Error(`${row.archiveId} record accounting is inconsistent`)
    }
    if (row.status === 'complete' && (!row.completedAt || !Number.isFinite(Date.parse(row.completedAt)))) {
      throw new Error(`${row.archiveId} is complete without a valid completion time`)
    }
    if (row.status === 'complete') {
      const group = groups.get(row.sourceId)!
      group.completed += 1
      group.recordsSeen += row.recordsSeen
      group.accepted += row.accepted
      group.deduplicated += row.deduplicated
      group.rejected += rejected
    }
  }
  const missing = [...expected.keys()].filter((archiveId) => {
    const run = input.runs.find((candidate) => candidate.archiveId === archiveId)
    return run?.status !== 'complete'
  })
  return { complete: missing.length === 0, groups: [...groups.values()], missing }
}
