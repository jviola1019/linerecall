import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CompactRemoteArchiveError,
  assertPublicCompactRemoteAddress,
  createApprovedHttpsArchiveInput,
  type CompactRemoteTransport,
  type CompactRemoteTransportResponse,
} from '../../scripts/data/compact-v3-remote.ts'

const URL = 'https://database.lichess.org/standard/fixture.pgn.zst'
const PUBLIC_ADDRESS = '93.184.216.34'
const ETAG = '"fixture-etag"'
const LAST_MODIFIED = 'Sun, 19 Jul 2026 12:00:00 GMT'

function body(chunks: readonly Uint8Array[], failure?: Error): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield chunk
    if (failure) throw failure
  })()
}

function response(
  chunks: readonly Uint8Array[],
  options: {
    statusCode?: number
    headers?: Record<string, string>
    failure?: Error
    remoteAddress?: string
  } = {},
): CompactRemoteTransportResponse {
  return {
    statusCode: options.statusCode ?? 200,
    headers: options.headers ?? {
      'content-length': String(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)),
      etag: ETAG,
      'last-modified': LAST_MODIFIED,
    },
    body: body(chunks, options.failure),
    remoteAddress: options.remoteAddress ?? PUBLIC_ADDRESS,
    abort() {},
  }
}

function fixtureSeams(transport: CompactRemoteTransport) {
  return {
    resolver: async () => [{ address: PUBLIC_ADDRESS, family: 4 as const }],
    transport,
    now: () => new Date('2026-07-19T12:30:00.000Z'),
  }
}

async function consume(input: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

test('approved HTTPS input captures retrieval metadata only after complete bounded consumption', async () => {
  const bytes = Buffer.from('fixture archive bytes')
  const opened = createApprovedHttpsArchiveInput({
    approvedUrl: URL,
    expectedBytes: bytes.byteLength,
    approvedEtag: ETAG,
    approvedLastModified: LAST_MODIFIED,
    testSeams: fixtureSeams(async () => response([bytes.subarray(0, 7), bytes.subarray(7)])),
  })
  assert.throws(() => opened.receipt(), /until the stream completes/iu)
  assert.deepEqual(await consume(opened.input), bytes)
  assert.deepEqual(opened.receipt(), {
    transport: 'approved-https',
    requestedUrl: URL,
    finalUrl: URL,
    redirectCount: 0,
    retrievedAt: '2026-07-19T12:30:00.000Z',
    etagObserved: ETAG,
    lastModifiedObserved: LAST_MODIFIED,
  })
})

test('remote policy rejects noncanonical URLs, private/reserved DNS, rebinding, and non-allowlisted redirects', async () => {
  assert.throws(() => createApprovedHttpsArchiveInput({
    approvedUrl: 'http://database.lichess.org/fixture',
    expectedBytes: 1,
    approvedEtag: null,
    approvedLastModified: null,
  }), /canonical HTTPS/iu)
  for (const address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '192.0.2.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', 'ff02::1']) {
    assert.throws(() => assertPublicCompactRemoteAddress(address), /non-public/iu)
  }

  const privateDns = createApprovedHttpsArchiveInput({
    approvedUrl: URL,
    expectedBytes: 1,
    approvedEtag: null,
    approvedLastModified: null,
    testSeams: {
      resolver: async () => [{ address: '127.0.0.1', family: 4 }],
      transport: async () => { throw new Error('transport must not run') },
    },
  })
  await assert.rejects(consume(privateDns.input), /non-public/iu)

  const rebound = createApprovedHttpsArchiveInput({
    approvedUrl: URL,
    expectedBytes: 1,
    approvedEtag: null,
    approvedLastModified: null,
    testSeams: fixtureSeams(async () => response([Buffer.from('x')], { remoteAddress: '1.1.1.1' })),
  })
  await assert.rejects(consume(rebound.input), /outside the vetted DNS/iu)

  const redirected = createApprovedHttpsArchiveInput({
    approvedUrl: URL,
    expectedBytes: 1,
    approvedEtag: null,
    approvedLastModified: null,
    testSeams: fixtureSeams(async () => response([], {
      statusCode: 302,
      headers: { location: 'https://example.com/fixture.pgn.zst' },
    })),
  })
  await assert.rejects(consume(redirected.input), /not the exact approved/iu)
})

test('short, overlong, interrupted, metadata-mismatched, and rate-limited responses fail explicitly', async () => {
  const cases: Array<{
    name: string
    expectedBytes: number
    transport: CompactRemoteTransport
    pattern: RegExp
  }> = [
    {
      name: 'short',
      expectedBytes: 2,
      transport: async () => response([Buffer.from('x')], { headers: { etag: ETAG, 'last-modified': LAST_MODIFIED } }),
      pattern: /ended at 1 of 2/iu,
    },
    {
      name: 'overlong',
      expectedBytes: 1,
      transport: async () => response([Buffer.from('xx')], { headers: { etag: ETAG, 'last-modified': LAST_MODIFIED } }),
      pattern: /exceeded the approved/iu,
    },
    {
      name: 'interrupted',
      expectedBytes: 1,
      transport: async () => response([], {
        headers: { etag: ETAG, 'last-modified': LAST_MODIFIED },
        failure: new Error('fixture socket reset'),
      }),
      pattern: /fixture socket reset/iu,
    },
    {
      name: 'etag',
      expectedBytes: 1,
      transport: async () => response([Buffer.from('x')], {
        headers: { etag: 'changed', 'last-modified': LAST_MODIFIED },
      }),
      pattern: /ETag differs/iu,
    },
    {
      name: 'rate limit',
      expectedBytes: 1,
      transport: async () => response([], { statusCode: 429, headers: { 'retry-after': '60' } }),
      pattern: /HTTP 429/iu,
    },
  ]
  for (const fixture of cases) {
    const opened = createApprovedHttpsArchiveInput({
      approvedUrl: URL,
      expectedBytes: fixture.expectedBytes,
      approvedEtag: ETAG,
      approvedLastModified: LAST_MODIFIED,
      testSeams: fixtureSeams(fixture.transport),
    })
    await assert.rejects(consume(opened.input), fixture.pattern, fixture.name)
  }

  const limited = createApprovedHttpsArchiveInput({
    approvedUrl: URL,
    expectedBytes: 1,
    approvedEtag: null,
    approvedLastModified: null,
    testSeams: fixtureSeams(async () => response([], { statusCode: 429, headers: { 'retry-after': '60' } })),
  })
  await assert.rejects(consume(limited.input), (error: unknown) => {
    assert.ok(error instanceof CompactRemoteArchiveError)
    assert.equal(error.retryable, true)
    assert.equal(error.retryAfterSeconds, 60)
    return true
  })
})

test('overall timeout aborts unresolved DNS and no automatic retry occurs', async () => {
  let resolutions = 0
  const opened = createApprovedHttpsArchiveInput({
    approvedUrl: URL,
    expectedBytes: 1,
    approvedEtag: null,
    approvedLastModified: null,
    testSeams: {
      resolver: async () => {
        resolutions += 1
        return new Promise<never>(() => {})
      },
      transport: async () => { throw new Error('transport must not run') },
      timeouts: { overallMs: 5 },
    },
  })
  await assert.rejects(consume(opened.input), /overall timeout/iu)
  assert.equal(resolutions, 1)
})

test('host process concurrency is one and a competing stream never reaches DNS or transport', async () => {
  let signalStarted!: () => void
  const started = new Promise<void>((resolve) => { signalStarted = resolve })
  const first = createApprovedHttpsArchiveInput({
    approvedUrl: URL,
    expectedBytes: 1,
    approvedEtag: null,
    approvedLastModified: null,
    testSeams: {
      resolver: async () => {
        signalStarted()
        return new Promise<never>(() => {})
      },
      transport: async () => { throw new Error('transport must not run') },
      timeouts: { overallMs: 25 },
    },
  })
  const firstConsumption = consume(first.input)
  await started
  let secondResolution = false
  const second = createApprovedHttpsArchiveInput({
    approvedUrl: URL,
    expectedBytes: 1,
    approvedEtag: null,
    approvedLastModified: null,
    testSeams: {
      resolver: async () => {
        secondResolution = true
        return [{ address: PUBLIC_ADDRESS, family: 4 }]
      },
      transport: async () => response([Buffer.from('x')]),
    },
  })
  await assert.rejects(consume(second.input), /Only one remote archive stream/iu)
  assert.equal(secondResolution, false)
  await assert.rejects(firstConsumption, /overall timeout/iu)
})
