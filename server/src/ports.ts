import type {
  PuzzleAttemptSyncRequest,
  PuzzleAttemptSyncResponse,
  PuzzleProgressBootstrapResponse,
  SyncRequestV1,
  SyncResponseV1,
} from './contracts.js'

export interface AuthenticatedActor {
  userId: string
  sessionId: string
  authTime: Date
}

export interface Authenticator {
  authenticate(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<AuthenticatedActor | null>
  handleWebRequest?(request: Request): Promise<Response>
  deleteIdentity?(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<void>
}

export interface SyncStore {
  sync(userId: string, request: SyncRequestV1, now: Date): Promise<SyncResponseV1>
  bootstrap(userId: string, cursor: bigint, limit: number, now: Date): Promise<SyncResponseV1>
  bootstrapPuzzleProgress(
    userId: string,
    cursor: bigint,
    limit: number,
    now: Date,
  ): Promise<PuzzleProgressBootstrapResponse>
  syncPuzzleAttempts(userId: string, request: PuzzleAttemptSyncRequest, now: Date): Promise<PuzzleAttemptSyncResponse>
  exportAccount(userId: string, now: Date): Promise<unknown>
  deleteAccount(userId: string, now: Date): Promise<void>
}

export interface RateLimitDecision {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: Date
}

export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number, now: Date): Promise<RateLimitDecision>
}

export interface CatalogService {
  getManifest(ifNoneMatch?: string): Promise<{ etag: string; manifest: unknown } | null>
  listPuzzles(query: { packId?: string; cursor?: string; limit: number }): Promise<{
    items: unknown[]
    nextCursor: string | null
  }>
}

export interface RepertoireService {
  createImport(userId: string, input: { name: string; pgn: string; side: 'white' | 'black' }, now: Date): Promise<unknown>
  getImport(userId: string, jobId: string): Promise<unknown | null>
  update(userId: string, repertoireId: string, ifMatch: string, revision: unknown, now: Date): Promise<unknown>
  createShare(userId: string, repertoireId: string, request: unknown, now: Date): Promise<{ id: string; token: string; revisionId: string }>
  revokeShare(userId: string, shareId: string, now: Date): Promise<boolean>
  resolveShare(token: string, now: Date): Promise<unknown | null>
}

export interface ExternalConnectionService {
  beginLichess(userId: string, redirectUri: string, now: Date): Promise<{ authorizationUrl: string }>
  completeLichess(userId: string, input: { code: string; state: string; redirectUri: string }, now: Date): Promise<void>
  disconnectLichess(userId: string, now: Date): Promise<void>
  revokeForAccountDeletion(userId: string, now: Date): Promise<void>
}

export interface LichessSyncRequestResult {
  jobId: string
  status: 'queued' | 'running' | 'retry_wait'
  syncStartedAt: string
}

export interface LichessSyncStatus {
  available: boolean
  unavailableReason: 'not_configured' | 'worker_unavailable' | null
  connected: boolean
  consentedAt: string | null
  lastSyncedAt: string | null
  job: null | {
    id: string
    status: 'queued' | 'running' | 'retry_wait' | 'succeeded' | 'failed' | 'cancelled'
    requestedAt: string
    syncStartedAt: string
    retryAt: string | null
    retryAfterSeconds: number | null
    processedRecords: string
    acceptedGames: string
    rejectedRecords: string
    failureCode: string | null
  }
}

export interface LichessSyncService {
  request(userId: string, now: Date): Promise<LichessSyncRequestResult>
  status(userId: string, now: Date): Promise<LichessSyncStatus>
}

export interface Clock {
  now(): Date
}

export interface ReadinessProbe {
  check(): Promise<Readonly<Record<string, boolean>>>
}

export interface ServiceDependencies {
  auth: Authenticator
  sync: SyncStore
  rateLimiter: RateLimiter
  catalog: CatalogService
  repertoires: RepertoireService
  connections: ExternalConnectionService
  /** Optional only for backwards-compatible composition; the API fails closed when omitted. */
  lichessSync?: LichessSyncService
  readiness?: ReadinessProbe
  clock?: Clock
}
