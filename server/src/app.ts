import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import helmet from '@fastify/helmet'
import fastifyRateLimit from '@fastify/rate-limit'
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  BootstrapQuerySchema,
  ImportRepertoireSchema,
  PuzzleAttemptSyncRequestSchema,
  PuzzleQuerySchema,
  RepertoireRevisionSchema,
  ShareRequestSchema,
  SyncRequestV1Schema,
  validateImportPgnBounds,
  validationDetails,
} from './contracts.js'
import {
  FamilyCoveragePageQuerySchema,
  FamilyCursorQuerySchema,
  FamilyCyclePageQuerySchema,
  FamilyTrainingSyncRequestV1Schema,
} from './family-training-contracts.js'
import { ApiError, isApiError } from './errors.js'
import type { AuthenticatedActor, ServiceDependencies } from './ports.js'

const tracer = trace.getTracer('@linerecall/server')
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const AUTH_UPSTREAM_RESPONSE_HEADERS_DENYLIST = new Set([
  'connection',
  'content-length',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'set-cookie',
  'transfer-encoding',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
])

export interface AppOptions {
  publicOrigin: string
  serviceOrigin?: string
  production?: boolean
  logger?: boolean
  trustProxy?: boolean
}

interface RateLimitPolicy {
  name: string
  limit: number
  windowMs: number
  subject: 'ip' | 'user'
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function retryAfterSeconds(reply: FastifyReply): number {
  const value = reply.getHeader('Retry-After')
  const first = Array.isArray(value) ? value[0] : value
  const numeric = typeof first === 'number' ? first : typeof first === 'string' ? Number(first) : Number.NaN
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 86_400
    ? Math.ceil(numeric)
    : 60
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: import('zod').ZodError } }, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new ApiError(422, 'validation_failed', 'Request validation failed', {
      details: validationDetails(result.error),
    })
  }
  return result.data
}

function safePublicOrigin(value: string): string {
  const parsed = new URL(value)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/') {
    throw new Error('publicOrigin must be an HTTP(S) origin without credentials or a path')
  }
  return parsed.origin
}

async function boundedAuthResponse(response: Response, maximumBytes = 256 * 1024): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/u.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    throw new ApiError(502, 'auth_response_too_large', 'The identity service returned an oversized response')
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) {
        await reader.cancel()
        throw new ApiError(502, 'auth_response_too_large', 'The identity service returned an oversized response')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}

function sanitizeAuthSession(bytes: Buffer, contentType: string | null): Buffer {
  if (bytes.length === 0 || !contentType?.toLowerCase().includes('application/json')) return bytes
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    return bytes
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bytes
  const record = value as Record<string, unknown>
  if (!record.session || typeof record.session !== 'object' || Array.isArray(record.session)) return bytes
  const { token: _token, ipAddress: _ipAddress, userAgent: _userAgent, ...safeSession } = record.session as Record<string, unknown>
  return Buffer.from(JSON.stringify({ ...record, session: safeSession }), 'utf8')
}

export async function createApp(dependencies: ServiceDependencies, options: AppOptions): Promise<FastifyInstance> {
  const publicOrigin = safePublicOrigin(options.publicOrigin)
  const serviceOrigin = safePublicOrigin(options.serviceOrigin ?? options.publicOrigin)
  const isMagicLinkRequest = (request: Pick<FastifyRequest, 'method' | 'url'>): boolean =>
    request.method === 'POST'
      && new URL(request.url, serviceOrigin).pathname === '/api/auth/sign-in/magic-link'
  class OperationalOnlyLogController extends LogController {
    constructor() { super({ disableRequestLogging: true }) }
  }
  const app = Fastify({
    logger: options.logger ? {
      level: 'info',
      redact: {
        paths: [
          'req.headers.authorization', 'req.headers.cookie', 'req.body', 'res.headers.set-cookie',
          '*.email', '*.token', '*.pgn', '*.reviewEvents',
        ],
        censor: '[REDACTED]',
      },
    } : false,
    trustProxy: options.trustProxy ?? false,
    bodyLimit: 1_050_000,
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    logController: new OperationalOnlyLogController(),
  })

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: options.production ? { maxAge: 31_536_000, includeSubDomains: false, preload: false } : false,
    referrerPolicy: { policy: 'no-referrer' },
  })

  // This bounded in-process limiter is a defense-in-depth backstop for the
  // identity gateway. The distributed RateLimiter below remains authoritative
  // across API tasks and supplies the stricter magic-link/passkey policies.
  // Magic-link requests are exempt here so every distributed-limit failure can
  // retain the same generic success response and avoid account enumeration.
  await app.register(fastifyRateLimit, {
    global: false,
    hook: 'onRequest',
    max: 120,
    timeWindow: 300_000,
    cache: 10_000,
    enableDraftSpec: true,
    ipv6Subnet: 64,
    allowList: (request) => isMagicLinkRequest(request),
  })

  app.addHook('onRequest', async (request) => {
    if (MUTATING_METHODS.has(request.method)) {
      const origin = firstHeader(request.headers.origin)
      if (origin !== publicOrigin) {
        throw new ApiError(403, 'origin_rejected', 'The request Origin is not allowed')
      }
    }
  })

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('Cache-Control', request.url.startsWith('/v1/catalog/')
      ? 'public, max-age=0, must-revalidate'
      : 'no-store')
    reply.header('Vary', 'Accept-Encoding')
    return payload
  })

  app.setNotFoundHandler((request, reply) => {
    sendError(reply, request, new ApiError(404, 'not_found', 'Route not found'))
  })

  app.setErrorHandler((error, request, reply) => {
    const span = trace.getSpan(context.active())
    span?.recordException({
      name: isApiError(error) ? 'ApiError' : error instanceof Error ? error.name.slice(0, 64) : 'UnknownError',
      message: isApiError(error) ? error.code : 'request failed',
    })
    span?.setStatus({ code: SpanStatusCode.ERROR })
    if (!isApiError(error) && options.logger) {
      // Unknown adapter/provider errors can embed credentials, SQL values, PGN,
      // or upstream response bodies in their message and stack. Keep the
      // operational correlation signal without serializing attacker- or
      // provider-controlled exception content.
      request.log.error({
        requestId: request.id,
        errorClass: error instanceof Error ? error.name.slice(0, 64) : typeof error,
      }, 'request failed')
    }
    const frameworkStatus = typeof error === 'object' && error !== null && 'statusCode' in error
      ? error.statusCode
      : null
    const safe = isApiError(error)
      ? error
      : frameworkStatus === 413
        ? new ApiError(413, 'payload_too_large', 'Request payload exceeds the allowed size')
        : frameworkStatus === 429
          ? new ApiError(429, 'rate_limit_exceeded', 'Too many requests; retry after the indicated interval', {
            retryAfterSeconds: retryAfterSeconds(reply),
          })
        : new ApiError(500, 'internal_error', 'The service could not complete the request')
    sendError(reply, request, safe)
  })

  async function actorFor(request: FastifyRequest): Promise<AuthenticatedActor> {
    const actor = await dependencies.auth.authenticate(request.headers)
    if (!actor) throw new ApiError(401, 'authentication_required', 'Sign in is required')
    return actor
  }

  async function rateLimit(
    request: FastifyRequest,
    reply: FastifyReply,
    policy: RateLimitPolicy,
    actor?: AuthenticatedActor,
    failOpenForCachedRead = false,
  ): Promise<void> {
    const subject = policy.subject === 'user' ? actor?.userId : request.ip
    if (!subject) throw new ApiError(401, 'authentication_required', 'Sign in is required')
    let decision
    try {
      decision = await dependencies.rateLimiter.consume(`${policy.name}:${subject}`, policy.limit, policy.windowMs, now())
    } catch {
      if (failOpenForCachedRead) {
        reply.header('RateLimit-Policy', 'degraded; limiter unavailable')
        return
      }
      throw new ApiError(503, 'rate_limiter_unavailable', 'This operation is temporarily unavailable because safety limits cannot be verified', {
        retryAfterSeconds: 60,
      })
    }
    const resetSeconds = Math.max(1, Math.ceil((decision.resetAt.getTime() - now().getTime()) / 1000))
    reply.header('RateLimit-Limit', String(decision.limit))
    reply.header('RateLimit-Remaining', String(decision.remaining))
    reply.header('RateLimit-Reset', String(resetSeconds))
    if (!decision.allowed) {
      throw new ApiError(429, 'rate_limit_exceeded', 'Too many requests; retry after the indicated interval', {
        retryAfterSeconds: resetSeconds,
      })
    }
  }

  const now = (): Date => dependencies.clock?.now() ?? new Date()

  app.get('/health/live', async () => ({ status: 'ok' }))
  app.get('/health/ready', async (_request, reply) => {
    const checks = dependencies.readiness ? await dependencies.readiness.check() : { process: true }
    const ready = Object.values(checks).every(Boolean)
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready', checks })
  })

  app.get('/v1/catalog/manifest', async (request, reply) => tracer.startActiveSpan('catalog.manifest', async (span) => {
    try {
      await rateLimit(request, reply, { name: 'catalog', limit: 300, windowMs: 60_000, subject: 'ip' }, undefined, true)
      const result = await dependencies.catalog.getManifest(firstHeader(request.headers['if-none-match']))
      if (!result) return reply.code(304).send()
      reply.header('ETag', result.etag)
      return result.manifest
    } finally {
      span.end()
    }
  }))

  if (dependencies.auth.handleWebRequest) {
    app.all('/api/auth/*', {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: 300_000,
          groupId: 'auth-baseline',
        },
      },
    }, async (request, reply) => {
      const authUrl = new URL(request.url, serviceOrigin)
      const magicLinkRequest = isMagicLinkRequest(request)
      try {
        await rateLimit(request, reply, { name: 'auth-ip', limit: 120, windowMs: 300_000, subject: 'ip' })
      } catch (error) {
        if (magicLinkRequest && isApiError(error) && ['rate_limit_exceeded', 'rate_limiter_unavailable'].includes(error.code)) {
          return reply.code(200).send({ status: true })
        }
        throw error
      }

      if (magicLinkRequest) {
        try {
          await rateLimit(request, reply, { name: 'magic-link-ip', limit: 20, windowMs: 3_600_000, subject: 'ip' })
        } catch (error) {
          if (isApiError(error) && ['rate_limit_exceeded', 'rate_limiter_unavailable'].includes(error.code)) {
            return reply.code(200).send({ status: true })
          }
          throw error
        }
        const emailResult = z.string().trim().max(254).email().safeParse((request.body as { email?: unknown } | null)?.email)
        if (emailResult.success) {
          const emailKey = createHash('sha256').update(emailResult.data.normalize('NFKC').toLowerCase()).digest('hex')
          try {
            const decision = await dependencies.rateLimiter.consume(`magic-link-email:${emailKey}`, 5, 3_600_000, now())
            if (!decision.allowed) return reply.code(200).send({ status: true })
          } catch {
            // Fail closed without revealing whether the address has an account.
            return reply.code(200).send({ status: true })
          }
        }
      } else if (authUrl.pathname.startsWith('/api/auth/passkey/')) {
        await rateLimit(request, reply, { name: 'passkey-ip', limit: 30, windowMs: 300_000, subject: 'ip' })
      }
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item)
        else if (value !== undefined) headers.set(name, String(value))
      }
      headers.delete('content-length')
      headers.delete('host')
      const body = ['GET', 'HEAD'].includes(request.method) || request.body === undefined
        ? undefined
        : JSON.stringify(request.body)
      const response = await dependencies.auth.handleWebRequest!(new Request(
        authUrl,
        { method: request.method, headers, ...(body === undefined ? {} : { body }) },
      ))
      reply.code(response.status)
      for (const [name, value] of response.headers) {
        if (!AUTH_UPSTREAM_RESPONSE_HEADERS_DENYLIST.has(name.toLowerCase())) reply.header(name, value)
      }
      const cookies = response.headers.getSetCookie()
      if (cookies.length > 0) reply.header('Set-Cookie', cookies)
      const bytes = await boundedAuthResponse(response)
      const sanitized = sanitizeAuthSession(bytes, response.headers.get('content-type'))
      return sanitized.length > 0 ? reply.send(sanitized) : reply.send()
    })
  }

  app.get('/v1/puzzles', async (request, reply) => {
    await rateLimit(request, reply, { name: 'puzzles-read', limit: 300, windowMs: 60_000, subject: 'ip' }, undefined, true)
    const query = parseBody(PuzzleQuerySchema, request.query)
    return dependencies.catalog.listPuzzles({
      limit: query.limit,
      ...(query.packId ? { packId: query.packId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    })
  })

  app.get('/v1/puzzles/progress', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'puzzle-progress', limit: 60, windowMs: 60_000, subject: 'user' }, actor)
    const query = parseBody(BootstrapQuerySchema, request.query)
    return dependencies.sync.bootstrapPuzzleProgress(actor.userId, BigInt(query.cursor), query.limit, now())
  })

  app.post('/v1/puzzles/attempts', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'puzzle-attempts', limit: 120, windowMs: 60_000, subject: 'user' }, actor)
    const input = parseBody(PuzzleAttemptSyncRequestSchema, request.body)
    return dependencies.sync.syncPuzzleAttempts(actor.userId, input, now())
  })

  app.post('/v1/sync', async (request, reply) => tracer.startActiveSpan('sync.push', async (span) => {
    try {
      const actor = await actorFor(request)
      await rateLimit(request, reply, { name: 'sync-burst', limit: 20, windowMs: 1_000, subject: 'user' }, actor)
      await rateLimit(request, reply, { name: 'sync', limit: 60, windowMs: 60_000, subject: 'user' }, actor)
      if (Buffer.byteLength(JSON.stringify(request.body), 'utf8') > 262_144) {
        throw new ApiError(413, 'sync_payload_too_large', 'Sync requests are limited to 256 KiB')
      }
      const input = parseBody(SyncRequestV1Schema, request.body)
      return await dependencies.sync.sync(actor.userId, input, now())
    } finally {
      span.end()
    }
  }))

  app.get('/v1/sync/bootstrap', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'sync-bootstrap', limit: 60, windowMs: 60_000, subject: 'user' }, actor)
    const query = parseBody(BootstrapQuerySchema, request.query)
    return dependencies.sync.bootstrap(actor.userId, BigInt(query.cursor), query.limit, now())
  })

  app.post('/v1/family-training/sync', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'family-sync-burst', limit: 20, windowMs: 1_000, subject: 'user' }, actor)
    await rateLimit(request, reply, { name: 'family-sync', limit: 60, windowMs: 60_000, subject: 'user' }, actor)
    if (Buffer.byteLength(JSON.stringify(request.body), 'utf8') > 262_144) {
      throw new ApiError(413, 'sync_payload_too_large', 'Family sync requests are limited to 256 KiB')
    }
    const input = parseBody(FamilyTrainingSyncRequestV1Schema, request.body)
    return dependencies.sync.syncFamilyTraining(actor.userId, input, now())
  })

  app.get('/v1/family-training/coverage', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'family-bootstrap', limit: 60, windowMs: 60_000, subject: 'user' }, actor)
    const query = parseBody(FamilyCoveragePageQuerySchema, request.query)
    return dependencies.sync.pageFamilyCoverage(actor.userId, {
      releaseId: query.releaseId,
      familyId: query.familyId,
      cursor: BigInt(query.cursor),
      limit: query.limit,
    }, now())
  })

  app.get('/v1/family-training/cycles', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'family-bootstrap', limit: 60, windowMs: 60_000, subject: 'user' }, actor)
    const query = parseBody(FamilyCyclePageQuerySchema, request.query)
    return dependencies.sync.pageFamilyCycles(actor.userId, {
      releaseId: query.releaseId,
      familyId: query.familyId,
      side: query.side,
      cursor: BigInt(query.cursor),
      limit: query.limit,
    }, now())
  })

  app.get('/v1/family-training/cursor', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'family-bootstrap', limit: 60, windowMs: 60_000, subject: 'user' }, actor)
    const query = parseBody(FamilyCursorQuerySchema, request.query)
    return dependencies.sync.loadFamilyCursor(actor.userId, query, now())
  })

  app.post('/v1/repertoires/imports', { bodyLimit: 1_050_000 }, async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'repertoire-import', limit: 10, windowMs: 86_400_000, subject: 'user' }, actor)
    const input = parseBody(ImportRepertoireSchema, request.body)
    try {
      validateImportPgnBounds(input.pgn)
    } catch (error) {
      throw new ApiError(422, 'invalid_pgn_envelope', error instanceof Error ? error.message : 'PGN failed structural validation')
    }
    const job = await dependencies.repertoires.createImport(actor.userId, input, now())
    return reply.code(202).send(job)
  })

  app.get('/v1/repertoires/imports/:jobId', async (request, reply) => {
    const actor = await actorFor(request)
    const parameters = parseBody(z.object({ jobId: z.string().uuid() }).strict(), request.params)
    const job = await dependencies.repertoires.getImport(actor.userId, parameters.jobId)
    if (!job) throw new ApiError(404, 'not_found', 'Import job not found')
    return reply.send(job)
  })

  app.put('/v1/repertoires/:repertoireId', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'repertoire-mutation', limit: 30, windowMs: 60_000, subject: 'user' }, actor)
    const parameters = request.params as { repertoireId?: string }
    if (!parameters.repertoireId || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(parameters.repertoireId)) {
      throw new ApiError(422, 'validation_failed', 'Invalid repertoire ID')
    }
    const ifMatch = firstHeader(request.headers['if-match'])
    if (!ifMatch) throw new ApiError(428, 'precondition_required', 'If-Match is required')
    const revision = parseBody(RepertoireRevisionSchema, request.body)
    const result = await dependencies.repertoires.update(actor.userId, parameters.repertoireId, ifMatch, revision, now())
    return reply.send(result)
  })

  app.post('/v1/repertoires/:repertoireId/shares', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'repertoire-mutation', limit: 30, windowMs: 60_000, subject: 'user' }, actor)
    const repertoireId = (request.params as { repertoireId?: string }).repertoireId
    if (!repertoireId || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(repertoireId)) {
      throw new ApiError(422, 'validation_failed', 'Invalid repertoire ID')
    }
    const input = parseBody(ShareRequestSchema, request.body)
    const share = await dependencies.repertoires.createShare(actor.userId, repertoireId, input, now())
    return reply.code(201).send(share)
  })

  app.delete('/v1/shares/:shareId', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'repertoire-mutation', limit: 30, windowMs: 60_000, subject: 'user' }, actor)
    const { shareId } = parseBody(z.object({ shareId: z.string().uuid() }).strict(), request.params)
    const removed = await dependencies.repertoires.revokeShare(actor.userId, shareId, now())
    if (!removed) throw new ApiError(404, 'not_found', 'Share not found')
    return reply.code(204).send()
  })

  app.get('/v1/shares/:token', async (request, reply) => {
    await rateLimit(request, reply, { name: 'share-read', limit: 60, windowMs: 60_000, subject: 'ip' })
    const token = (request.params as { token?: string }).token ?? ''
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new ApiError(404, 'not_found', 'Share not found')
    const share = await dependencies.repertoires.resolveShare(token, now())
    if (!share) throw new ApiError(404, 'not_found', 'Share not found')
    return reply.send(share)
  })

  app.get('/v1/account/export', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'account-export', limit: 2, windowMs: 86_400_000, subject: 'user' }, actor)
    reply.header('Content-Disposition', 'attachment; filename="linerecall-account-export.json"')
    return dependencies.sync.exportAccount(actor.userId, now())
  })

  app.delete('/v1/account', async (request, reply) => {
    const actor = await actorFor(request)
    if (now().getTime() - actor.authTime.getTime() > 10 * 60_000) {
      throw new ApiError(403, 'recent_authentication_required', 'Reauthenticate before deleting the account')
    }
    await dependencies.connections.revokeForAccountDeletion(actor.userId, now())
    if (dependencies.auth.deleteIdentity) await dependencies.auth.deleteIdentity(request.headers)
    else await dependencies.sync.deleteAccount(actor.userId, now())
    return reply.code(204).send()
  })

  app.post('/v1/connections/lichess/start', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'connection-mutation', limit: 10, windowMs: 60_000, subject: 'user' }, actor)
    return dependencies.connections.beginLichess(actor.userId, `${publicOrigin}/connections/lichess/callback`, now())
  })

  app.post('/v1/connections/lichess/complete', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'connection-mutation', limit: 10, windowMs: 60_000, subject: 'user' }, actor)
    const body = request.body as { code?: unknown; state?: unknown }
    if (typeof body?.code !== 'string' || body.code.length > 2048 || typeof body.state !== 'string' || body.state.length > 256) {
      throw new ApiError(422, 'validation_failed', 'Invalid OAuth callback parameters')
    }
    await dependencies.connections.completeLichess(actor.userId, {
      code: body.code,
      state: body.state,
      redirectUri: `${publicOrigin}/connections/lichess/callback`,
    }, now())
    return reply.code(204).send()
  })

  app.delete('/v1/connections/lichess', async (request, reply) => {
    const actor = await actorFor(request)
    await dependencies.connections.disconnectLichess(actor.userId, now())
    return reply.code(204).send()
  })

  app.get('/v1/connections/lichess/sync', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'connection-sync-status', limit: 60, windowMs: 60_000, subject: 'user' }, actor)
    if (!dependencies.lichessSync) {
      return {
        available: false,
        unavailableReason: 'not_configured',
        connected: false,
        consentedAt: null,
        lastSyncedAt: null,
        job: null,
      }
    }
    return dependencies.lichessSync.status(actor.userId, now())
  })

  app.post('/v1/connections/lichess/sync', async (request, reply) => {
    const actor = await actorFor(request)
    await rateLimit(request, reply, { name: 'connection-sync', limit: 10, windowMs: 86_400_000, subject: 'user' }, actor)
    if (!dependencies.lichessSync) {
      throw new ApiError(503, 'lichess_sync_not_configured', 'Lichess game sync is not configured for this deployment')
    }
    const result = await dependencies.lichessSync.request(actor.userId, now())
    return reply.code(202).send(result)
  })

  return app
}

function sendError(reply: FastifyReply, request: FastifyRequest, error: ApiError): void {
  if (error.retryAfterSeconds) reply.header('Retry-After', String(error.retryAfterSeconds))
  reply.code(error.statusCode).send({
    error: {
      code: error.code,
      message: error.message,
      requestId: request.id,
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(error.details ? { details: error.details } : {}),
    },
  })
}
