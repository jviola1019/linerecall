import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser'
import { z } from 'zod'
import {
  AuthenticationOptionsSchema,
  AuthSessionSchema,
  PasskeyRecordSchema,
  RegistrationOptionsSchema,
  type AuthSession,
} from './contracts.ts'
import { expectJson, sameOriginRequest, type FetchLike } from './http.ts'

const MagicLinkResponseSchema = z.object({ status: z.boolean() }).strict()
const SignOutResponseSchema = z.object({ success: z.boolean() }).strict()
const EmailSchema = z.string().trim().email().max(254)
const LichessStartSchema = z.object({ authorizationUrl: z.string().url().max(2048) }).strict()

type Authenticate = (input: { optionsJSON: PublicKeyCredentialRequestOptionsJSON }) => Promise<AuthenticationResponseJSON>
type Register = (input: { optionsJSON: PublicKeyCredentialCreationOptionsJSON }) => Promise<RegistrationResponseJSON>

export class AuthService {
  readonly #fetcher: FetchLike
  readonly #origin: string
  readonly #authenticate: Authenticate
  readonly #register: Register

  constructor(options: {
    fetcher?: FetchLike
    origin?: string
    authenticate?: Authenticate
    register?: Register
  } = {}) {
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis)
    this.#origin = new URL(options.origin ?? globalThis.location.origin).origin
    this.#authenticate = options.authenticate ?? startAuthentication
    this.#register = options.register ?? startRegistration
  }

  async session(): Promise<AuthSession | null> {
    const response = await sameOriginRequest(this.#fetcher, this.#origin, '/api/auth/get-session?disableCookieCache=true')
    return expectJson(response, (value) => value === null ? null : AuthSessionSchema.parse(value), 64 * 1024)
  }

  async sendMagicLink(emailInput: string): Promise<void> {
    const email = EmailSchema.parse(emailInput)
    const response = await sameOriginRequest(this.#fetcher, this.#origin, '/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, callbackURL: `${this.#origin}/` }),
    })
    await expectJson(response, (value) => MagicLinkResponseSchema.parse(value), 32 * 1024)
  }

  async signInWithPasskey(): Promise<AuthSession> {
    const optionsResponse = await sameOriginRequest(this.#fetcher, this.#origin, '/api/auth/passkey/generate-authenticate-options')
    const options = await expectJson(
      optionsResponse,
      (value) => AuthenticationOptionsSchema.parse(value) as PublicKeyCredentialRequestOptionsJSON,
      128 * 1024,
    )
    const credential = await this.#authenticate({ optionsJSON: options })
    const { clientExtensionResults: _clientExtensionResults, ...responseBody } = credential
    const verifyResponse = await sameOriginRequest(this.#fetcher, this.#origin, '/api/auth/passkey/verify-authentication', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: responseBody }),
    })
    return expectJson(verifyResponse, (value) => AuthSessionSchema.parse(value), 128 * 1024)
  }

  async addPasskey(nameInput: string): Promise<void> {
    const name = z.string().trim().min(1).max(64).parse(nameInput)
    const query = new URLSearchParams({ name })
    const optionsResponse = await sameOriginRequest(
      this.#fetcher,
      this.#origin,
      `/api/auth/passkey/generate-register-options?${query.toString()}`,
    )
    const options = await expectJson(
      optionsResponse,
      (value) => RegistrationOptionsSchema.parse(value) as PublicKeyCredentialCreationOptionsJSON,
      128 * 1024,
    )
    const credential = await this.#register({ optionsJSON: options })
    const { clientExtensionResults: _clientExtensionResults, ...responseBody } = credential
    const verifyResponse = await sameOriginRequest(this.#fetcher, this.#origin, '/api/auth/passkey/verify-registration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ response: responseBody, name }),
    })
    await expectJson(verifyResponse, (value) => PasskeyRecordSchema.parse(value), 128 * 1024)
  }

  async signOut(): Promise<void> {
    const response = await sameOriginRequest(this.#fetcher, this.#origin, '/api/auth/sign-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    await expectJson(response, (value) => SignOutResponseSchema.parse(value), 32 * 1024)
  }

  async deleteAccount(): Promise<void> {
    const response = await sameOriginRequest(this.#fetcher, this.#origin, '/v1/account', { method: 'DELETE' })
    await expectJson(response, (value) => {
      if (value !== null) throw new Error('Account deletion returned an unexpected body')
      return undefined
    }, 32 * 1024)
  }

  async startLichessConnection(): Promise<string> {
    const response = await sameOriginRequest(this.#fetcher, this.#origin, '/v1/connections/lichess/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const result = await expectJson(response, (value) => LichessStartSchema.parse(value), 32 * 1024)
    const url = new URL(result.authorizationUrl)
    if (url.protocol !== 'https:' || url.hostname !== 'lichess.org' || url.username || url.password) {
      throw new Error('The service returned an unsafe provider authorization URL')
    }
    return url.toString()
  }

  async completeLichessConnection(code: string, state: string): Promise<void> {
    const body = z.object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(256) }).strict().parse({ code, state })
    const response = await sameOriginRequest(this.#fetcher, this.#origin, '/v1/connections/lichess/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    await expectJson(response, (value) => {
      if (value !== null) throw new Error('Provider connection returned an unexpected body')
      return undefined
    }, 32 * 1024)
  }

  async disconnectLichess(): Promise<void> {
    const response = await sameOriginRequest(this.#fetcher, this.#origin, '/v1/connections/lichess', { method: 'DELETE' })
    await expectJson(response, (value) => {
      if (value !== null) throw new Error('Provider disconnect returned an unexpected body')
      return undefined
    }, 32 * 1024)
  }
}
