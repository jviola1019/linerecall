import { createHash, randomBytes } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { Redis } from 'ioredis'
import { ApiError } from '../errors.js'
import type { ExternalConnectionService } from '../ports.js'
import { RedisLichessProviderGate } from './lichess-provider-gate.js'

interface OAuthAttempt {
  userId: string
  verifier: string
  redirectUri: string
}

export interface TokenVault {
  seal(userId: string, plaintext: string): Promise<Uint8Array>
  open(userId: string, ciphertext: Uint8Array): Promise<string>
}

export interface OAuthStateStore {
  put(state: string, value: OAuthAttempt, ttlSeconds: number): Promise<void>
  consume(state: string): Promise<OAuthAttempt | null>
}

export class RedisOAuthStateStore implements OAuthStateStore {
  constructor(private readonly redis: Redis) {}
  async put(state: string, value: OAuthAttempt, ttlSeconds: number): Promise<void> {
    const key = `linerecall:oauth:lichess:${createHash('sha256').update(state).digest('hex')}`
    const result = await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds, 'NX')
    if (result !== 'OK') throw new ApiError(503, 'oauth_state_unavailable', 'Could not initialize the provider connection')
  }
  async consume(state: string): Promise<OAuthAttempt | null> {
    const key = `linerecall:oauth:lichess:${createHash('sha256').update(state).digest('hex')}`
    const value = await this.redis.getdel(key)
    if (!value) return null
    const parsed = JSON.parse(value) as Partial<OAuthAttempt>
    if (typeof parsed.userId !== 'string' || typeof parsed.verifier !== 'string' || typeof parsed.redirectUri !== 'string') return null
    return parsed as OAuthAttempt
  }
}

async function boundedText(response: Response, maximumBytes = 65_536): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maximumBytes) throw new ApiError(502, 'provider_response_too_large', 'Lichess returned an unexpectedly large response')
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks).toString('utf8')
}

export class LichessConnectionService implements ExternalConnectionService {
  readonly #gate: RedisLichessProviderGate
  constructor(
    private readonly pool: Pool,
    private readonly redis: Redis,
    private readonly states: OAuthStateStore,
    private readonly vault: TokenVault,
    private readonly clientId: string,
    private readonly userAgent: string,
  ) {
    this.#gate = new RedisLichessProviderGate(redis)
    if (!/^[A-Za-z0-9._-]{3,128}$/.test(clientId)) throw new Error('Invalid Lichess OAuth client ID')
    if (userAgent.length < 10 || userAgent.length > 256 || !userAgent.includes('@')) throw new Error('Provider User-Agent must include a monitored contact address')
  }

  async beginLichess(userId: string, redirectUri: string): Promise<{ authorizationUrl: string }> {
    const redirect = new URL(redirectUri)
    if (redirect.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(redirect.hostname)) {
      throw new ApiError(500, 'invalid_provider_configuration', 'OAuth redirect must use HTTPS')
    }
    const verifier = randomBytes(64).toString('base64url')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const state = randomBytes(32).toString('base64url')
    await this.states.put(state, { userId, verifier, redirectUri: redirect.toString() }, 600)
    const url = new URL('https://lichess.org/oauth')
    url.search = new URLSearchParams({
      response_type: 'code', client_id: this.clientId, redirect_uri: redirect.toString(),
      code_challenge_method: 'S256', code_challenge: challenge, state,
    }).toString()
    return { authorizationUrl: url.toString() }
  }

  async completeLichess(userId: string, input: { code: string; state: string; redirectUri: string }, now: Date): Promise<void> {
    const attempt = await this.states.consume(input.state)
    if (!attempt || attempt.userId !== userId || attempt.redirectUri !== input.redirectUri) {
      throw new ApiError(400, 'invalid_oauth_state', 'The provider connection expired or does not match this session')
    }
    const token = await this.#requestToken(input.code, attempt.verifier, input.redirectUri, now)
    try {
      const account = await this.#requestAccount(token.accessToken)
      const [sealedId, sealedToken] = await Promise.all([
        this.vault.seal(userId, account.id), this.vault.seal(userId, token.accessToken),
      ])
      await this.#transaction(userId, async (client) => {
        // A credential rotation must not let an already queued job continue
        // against a different provider identity or sync boundary.
        await client.query(
          `UPDATE lichess_sync_jobs SET status='cancelled',completed_at=$2,retry_at=NULL,
             failure_code='connection_reauthorized'
           WHERE user_id=$1 AND status IN ('queued','running','retry_wait')`,
          [userId, now],
        )
        await client.query(
          `INSERT INTO external_connections
            (user_id,provider,provider_user_id_ciphertext,access_token_ciphertext,token_expires_at,consented_at,disconnected_at)
           VALUES ($1,'lichess',$2,$3,$4,$5,NULL)
           ON CONFLICT (user_id,provider) DO UPDATE SET
            provider_user_id_ciphertext=EXCLUDED.provider_user_id_ciphertext,
            access_token_ciphertext=EXCLUDED.access_token_ciphertext,
            token_expires_at=EXCLUDED.token_expires_at,
            consented_at=EXCLUDED.consented_at,disconnected_at=NULL`,
          [userId, Buffer.from(sealedId), Buffer.from(sealedToken), token.expiresAt, now],
        )
      })
    } catch (error) {
      await this.#revoke(token.accessToken).catch(() => undefined)
      throw error
    }
  }

  async disconnectLichess(userId: string, now: Date): Promise<void> {
    const encrypted = await this.#transaction(userId, async (client) => {
      const result = await client.query<{ access_token_ciphertext: Buffer }>(
        `SELECT access_token_ciphertext FROM external_connections
         WHERE user_id=$1 AND provider='lichess' AND disconnected_at IS NULL`, [userId],
      )
      return result.rows[0]?.access_token_ciphertext
    })
    if (encrypted) {
      const token = await this.vault.open(userId, encrypted)
      // Retain ciphertext and the connection row unless the provider confirms
      // revocation or reports that the token is already invalid.
      await this.#revoke(token)
    }
    await this.#transaction(userId, async (client) => {
      await client.query(
        `UPDATE lichess_sync_jobs SET status='cancelled',completed_at=$2,retry_at=NULL,
           failure_code='connection_disconnected'
         WHERE user_id=$1 AND status IN ('queued','running','retry_wait')`,
        [userId, now],
      )
      // Token ciphertext is destroyed immediately, not retained in a tombstone.
      await client.query(`DELETE FROM external_connections WHERE user_id=$1 AND provider='lichess'`, [userId])
    })
  }

  async revokeForAccountDeletion(userId: string, now: Date): Promise<void> {
    await this.disconnectLichess(userId, now)
  }

  async #requestToken(code: string, verifier: string, redirectUri: string, now: Date): Promise<{ accessToken: string; expiresAt: Date | null }> {
    return this.#gate.run(async (leaseSignal) => {
      const response = await fetch('https://lichess.org/api/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([leaseSignal, AbortSignal.timeout(15_000)]),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': this.userAgent },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: this.clientId }),
      })
      if (response.status === 429) {
        const retryAfterSeconds = await this.#gate.applyRateLimit(response)
        throw new ApiError(429, 'provider_rate_limited', 'Lichess requested a cooldown', { retryAfterSeconds })
      }
      const body = await boundedText(response)
      if (!response.ok) throw new ApiError(502, 'provider_token_exchange_failed', 'Lichess did not accept the connection request')
      let parsed: { access_token?: unknown; expires_in?: unknown }
      try {
        parsed = JSON.parse(body) as { access_token?: unknown; expires_in?: unknown }
      } catch {
        throw new ApiError(502, 'invalid_provider_response', 'Lichess returned an invalid token response')
      }
      if (typeof parsed.access_token !== 'string' || parsed.access_token.length < 20 || parsed.access_token.length > 2048) {
        throw new ApiError(502, 'invalid_provider_response', 'Lichess returned an invalid token response')
      }
      return {
        accessToken: parsed.access_token,
        expiresAt: typeof parsed.expires_in === 'number' && parsed.expires_in > 0
          ? new Date(now.getTime() + parsed.expires_in * 1000) : null,
      }
    })
  }

  async #requestAccount(token: string): Promise<{ id: string }> {
    return this.#gate.run(async (leaseSignal) => {
      const response = await fetch('https://lichess.org/api/account', {
        redirect: 'error', signal: AbortSignal.any([leaseSignal, AbortSignal.timeout(15_000)]),
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': this.userAgent },
      })
      if (response.status === 429) {
        const retryAfterSeconds = await this.#gate.applyRateLimit(response)
        throw new ApiError(429, 'provider_rate_limited', 'Lichess requested a cooldown', { retryAfterSeconds })
      }
      const body = await boundedText(response)
      if (!response.ok) throw new ApiError(502, 'provider_account_failed', 'Could not read the connected Lichess account')
      let parsed: { id?: unknown }
      try {
        parsed = JSON.parse(body) as { id?: unknown }
      } catch {
        throw new ApiError(502, 'invalid_provider_response', 'Lichess returned an invalid account response')
      }
      if (typeof parsed.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(parsed.id)) {
        throw new ApiError(502, 'invalid_provider_response', 'Lichess returned an invalid account response')
      }
      return { id: parsed.id }
    })
  }

  async #revoke(token: string): Promise<void> {
    await this.#gate.run(async (leaseSignal) => {
      const response = await fetch('https://lichess.org/api/token', {
        method: 'DELETE', redirect: 'error', signal: AbortSignal.any([leaseSignal, AbortSignal.timeout(15_000)]),
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': this.userAgent },
      })
      if (response.status === 429) {
        const retryAfterSeconds = await this.#gate.applyRateLimit(response)
        throw new ApiError(429, 'provider_rate_limited', 'Lichess requested a cooldown', { retryAfterSeconds })
      }
      if (!response.ok && response.status !== 401) throw new Error('Provider token revocation failed')
    })
  }

  async #transaction<T>(userId: string, callback: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.user_id',$1,true)`, [userId])
      const result = await callback(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
