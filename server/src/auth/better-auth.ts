import { passkey } from '@better-auth/passkey'
import { betterAuth } from 'better-auth'
import { magicLink } from 'better-auth/plugins'
import type { Pool } from 'pg'
import type { AuthenticatedActor, Authenticator } from '../ports.js'

export interface MagicLinkSender {
  send(input: { email: string; url: string; expiresInSeconds: number }): Promise<void>
}

export interface BetterAuthGatewayOptions {
  pool: Pool
  baseURL: string
  publicOrigin: string
  secret: string
  rpID: string
  rpName: string
  sender: MagicLinkSender
  production: boolean
  deleteUserData: (userId: string) => Promise<void>
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('BETTER_AUTH_SECRET must contain at least 32 UTF-8 bytes')
  }
}

function webHeaders(headers: Readonly<Record<string, string | string[] | undefined>>): Headers {
  const result = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const item of value) result.append(name, item)
    else if (value !== undefined) result.set(name, value)
  }
  return result
}

interface BetterAuthRuntime {
  api: {
    getSession(input: { headers: Headers }): Promise<{
      user: { id: string }
      session: { id: string; createdAt: Date | string }
    } | null>
    deleteUser(input: { headers: Headers; body: Record<string, never> }): Promise<unknown>
  }
  handler(request: Request): Promise<Response>
}

/**
 * Keeps the HTTP/authentication adapter independently testable from Better
 * Auth's database bootstrap. The narrow runtime contract also prevents
 * application code from depending on provider-specific session internals.
 */
export function createAuthenticatorAdapter(auth: BetterAuthRuntime): Authenticator {
  return {
    async authenticate(headers): Promise<AuthenticatedActor | null> {
      const result = await auth.api.getSession({ headers: webHeaders(headers) })
      if (!result) return null
      return {
        userId: result.user.id,
        sessionId: result.session.id,
        authTime: new Date(result.session.createdAt),
      }
    },
    async handleWebRequest(request: Request): Promise<Response> {
      return auth.handler(request)
    },
    async deleteIdentity(headers): Promise<void> {
      await auth.api.deleteUser({ headers: webHeaders(headers), body: {} })
    },
  }
}

/**
 * Configures the production identity boundary. Better Auth owns its auth
 * schema; application tables use only the resulting opaque user ID.
 * Database migrations for Better Auth must be generated with its pinned CLI
 * and reviewed independently from `migrations/001_application.sql`.
 */
export function createBetterAuthGateway(options: BetterAuthGatewayOptions): Authenticator {
  assertSecret(options.secret)
  const baseURL = new URL(options.baseURL).origin
  const publicOrigin = new URL(options.publicOrigin).origin
  const auth = betterAuth({
    appName: 'LineRecall',
    baseURL,
    basePath: '/api/auth',
    secret: options.secret,
    database: options.pool,
    trustedOrigins: [publicOrigin, baseURL],
    emailAndPassword: { enabled: false },
    user: {
      deleteUser: {
        enabled: true,
        // Delete private application data before removing the identity. A
        // retry can safely repeat this idempotent operation.
        beforeDelete: async (user) => options.deleteUserData(user.id),
      },
    },
    advanced: {
      useSecureCookies: options.production,
      cookiePrefix: options.production ? '__Host-linerecall' : 'linerecall-dev',
      defaultCookieAttributes: {
        httpOnly: true,
        secure: options.production,
        sameSite: 'lax',
        path: '/',
      },
      disableCSRFCheck: false,
      disableOriginCheck: false,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 30,
      storage: 'database',
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    plugins: [
      magicLink({
        expiresIn: 300,
        storeToken: 'hashed',
        rateLimit: { window: 3600, max: 5 },
        sendMagicLink: async ({ email, url }) => options.sender.send({ email, url, expiresInSeconds: 300 }),
      }),
      passkey({
        rpID: options.rpID,
        rpName: options.rpName,
        origin: publicOrigin,
        registration: { requireSession: true },
      }),
    ],
  })

  return createAuthenticatorAdapter(auth)
}

export class RejectingMagicLinkSender implements MagicLinkSender {
  async send(): Promise<void> {
    throw new Error('Magic-link email provider is not configured')
  }
}
