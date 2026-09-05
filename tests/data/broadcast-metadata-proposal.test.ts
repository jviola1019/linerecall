import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { approvedCompactCorpusFromBytes } from '../../scripts/data/compact-v3-manifest.ts'
import { prepareBroadcastMetadataProposal } from '../../scripts/data/prepare-broadcast-metadata-proposal.ts'

const sourceSnapshotSha256 = 'c'.repeat(64)

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function nextMonth(month: string): string {
  const [yearText, monthText] = month.split('-')
  const year = Number(yearText)
  const number = Number(monthText)
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`
}

function fixture(): { manifestBytes: Buffer; observationBytes: Buffer } {
  const archives: Array<Record<string, unknown>> = []
  let month = '2020-01'
  for (let index = 0; index < 78; index += 1) {
    const filename = `lichess_db_broadcast_${month}.pgn.zst`
    archives.push({
      month,
      filename,
      url: `https://database.lichess.org/broadcast/${filename}`,
      sha256: index.toString(16).padStart(64, '0'),
    })
    month = nextMonth(month)
  }
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-07-11T04:31:17.000Z',
    startMonth: '2020-01',
    cutoffMonth: '2026-06',
    source: {
      listUrl: 'https://database.lichess.org/broadcast/list.txt',
      checksumsUrl: 'https://database.lichess.org/broadcast/sha256sums.txt',
      license: 'CC BY-SA 4.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    },
    approval: {
      status: 'approved',
      approvedOn: '2026-07-11',
      scope: 'Fixture source approval.',
      basis: 'Fixture source and license review.',
      reviewRequiredWhen: 'Fixture identity changes.',
    },
    archives,
  }))
  const observationBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: 'linerecall-broadcast-metadata-observation',
    reviewStatus: 'pending',
    releaseEligible: false,
    sourceId: 'lichess-broadcasts',
    sourceManifestSha256: sha256(manifestBytes),
    sourceSnapshotSha256,
    observedAt: '2026-08-06T14:15:16.000Z',
    policy: {
      method: 'HEAD',
      concurrency: 1,
      requestTimeoutMs: 30_000,
      maximumRedirects: 3,
      maximumResponseHeaderBytes: 16 * 1024,
      maximumArchiveBytes: 8 * 1024 * 1024 * 1024,
      redirectHostPolicy: 'same-approved-host-https-default-port',
      networkDateHeaderRetained: false,
    },
    archiveCount: 78,
    archives: archives.map((archive, index) => ({
      archiveId: `broadcast-${archive.month}`,
      month: archive.month,
      filename: archive.filename,
      approvedUrl: archive.url,
      approvedSha256: archive.sha256,
      observation: {
        method: 'HEAD',
        requestedUrl: archive.url,
        finalUrl: archive.url,
        redirectCount: 0,
        contentLength: 1_000_000 + index,
        etagObserved: `"broadcast-${index}"`,
        lastModifiedObserved: 'Thu, 06 Aug 2026 12:00:00 GMT',
        retrievedAt: '2026-08-06T14:15:16.000Z',
      },
      localVerification: {
        status: 'verified',
        filename: archive.filename,
        bytes: 1_000_000 + index,
        sha256: archive.sha256,
      },
    })),
    note: 'Pending metadata observation only. It does not amend the approved manifest or authorize ingestion.',
  }))
  return { manifestBytes, observationBytes }
}

test('proposal binds all observed metadata but remains pending and non-ingestible', () => {
  const input = fixture()
  const proposal = prepareBroadcastMetadataProposal({
    sourceManifestBytes: input.manifestBytes,
    observationBytes: input.observationBytes,
    sourceSnapshotSha256,
  })
  assert.equal(proposal.approval.status, 'pending')
  assert.equal(proposal.approval.approvedOn, null)
  assert.equal(proposal.metadataObservation?.receiptSha256, sha256(input.observationBytes))
  assert.equal(proposal.metadataObservation?.localArchivesVerified, true)
  assert.equal(proposal.archives.length, 78)
  assert.equal(proposal.archives[0]?.bytes, 1_000_000)
  assert.equal(proposal.archives.at(-1)?.etagObserved, '"broadcast-77"')
  assert.throws(
    () => approvedCompactCorpusFromBytes(Buffer.from(JSON.stringify(proposal)), 'lichess-broadcasts'),
    /not approved/iu,
  )
})

test('a separately approved proposal binds compact-v3 archive length and response identity', () => {
  const input = fixture()
  const proposal = prepareBroadcastMetadataProposal({
    sourceManifestBytes: input.manifestBytes,
    observationBytes: input.observationBytes,
    sourceSnapshotSha256,
  })
  proposal.approval.status = 'approved'
  proposal.approval.approvedOn = '2026-08-07'
  proposal.approval.scope = 'Fixture approval of the exact observed transport metadata.'
  proposal.approval.basis = 'Fixture reviewer compared the immutable observation and local hashes.'
  const corpus = approvedCompactCorpusFromBytes(Buffer.from(JSON.stringify(proposal)), 'lichess-broadcasts')
  assert.equal(corpus.archives[0]?.compressedBytes, 1_000_000)
  assert.equal(corpus.archives[0]?.etagObserved, '"broadcast-0"')
  assert.equal(corpus.archives[0]?.lastModifiedObserved, 'Thu, 06 Aug 2026 12:00:00 GMT')
})

test('proposal rejects a stale source binding, missing local verification, and repeat amendment', () => {
  const input = fixture()
  const wrongObservation = JSON.parse(input.observationBytes.toString('utf8')) as Record<string, any>
  wrongObservation.sourceManifestSha256 = 'd'.repeat(64)
  assert.throws(() => prepareBroadcastMetadataProposal({
    sourceManifestBytes: input.manifestBytes,
    observationBytes: Buffer.from(JSON.stringify(wrongObservation)),
    sourceSnapshotSha256,
  }), /different source manifest/iu)

  const unverified = JSON.parse(input.observationBytes.toString('utf8')) as Record<string, any>
  unverified.archives[77].localVerification = { status: 'not-requested' }
  assert.throws(() => prepareBroadcastMetadataProposal({
    sourceManifestBytes: input.manifestBytes,
    observationBytes: Buffer.from(JSON.stringify(unverified)),
    sourceSnapshotSha256,
  }), /all 78 locally verified/iu)

  const proposal = prepareBroadcastMetadataProposal({
    sourceManifestBytes: input.manifestBytes,
    observationBytes: input.observationBytes,
    sourceSnapshotSha256,
  })
  proposal.approval.status = 'approved'
  proposal.approval.approvedOn = '2026-08-07'
  assert.throws(() => prepareBroadcastMetadataProposal({
    sourceManifestBytes: Buffer.from(JSON.stringify(proposal)),
    observationBytes: input.observationBytes,
    sourceSnapshotSha256,
  }), /already contains transport metadata/iu)
})
