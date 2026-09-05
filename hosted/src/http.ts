import { ErrorResponseSchema } from './contracts.ts'

export const MAX_JSON_RESPONSE_BYTES = 512 * 1024

export class HttpProblem extends Error {
  readonly status: number
  readonly code: string
  readonly retryAfterSeconds: number | null

  constructor(status: number, code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message)
    this.name = 'HttpProblem'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }
}
function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export async function readBoundedJson(response: Response, maxBytes = MAX_JSON_RESPONSE_BYTES): Promise<unknown> {
  const length = response.headers.get('content-length')
  if (length && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) {
    throw new HttpProblem(502, 'response_too_large', 'The service returned more data than this client accepts')
  }
  const text = await response.text()
  if (byteLength(text) > maxBytes) {
    throw new HttpProblem(502, 'response_too_large', 'The service returned more data than this client accepts')
  }
  if (!text) return null
  if (text.includes('\0')) throw new HttpProblem(502, 'invalid_response', 'The service returned an invalid response')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpProblem(502, 'invalid_json', 'The service returned malformed JSON')
  }
}

export async function expectJson<T>(
  response: Response,
  parse: (value: unknown) => T,
  maxBytes = MAX_JSON_RESPONSE_BYTES,
): Promise<T> {
  const value = await readBoundedJson(response, maxBytes)
  if (!response.ok) {
    const parsed = ErrorResponseSchema.safeParse(value)
    if (parsed.success) {
      throw new HttpProblem(
        response.status,
        parsed.data.error.code,
        parsed.data.error.message,
        parsed.data.error.retryAfterSeconds ?? retryAfterHeader(response),
      )
    }
    throw new HttpProblem(response.status, 'request_failed', `The service returned HTTP ${response.status}`, retryAfterHeader(response))
  }
  try {
    return parse(value)
  } catch {
    throw new HttpProblem(502, 'invalid_response', 'The service response failed strict validation')
  }
}

function retryAfterHeader(response: Response): number | null {
  const raw = response.headers.get('retry-after')
  if (!raw || !/^\d+$/u.test(raw)) return null
  const seconds = Number(raw)
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 86_400 ? seconds : null
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export function sameOriginUrl(path: string, origin: string): URL {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('API paths must be root-relative')
  const url = new URL(path, origin)
  if (url.origin !== new URL(origin).origin) throw new Error('Cross-origin API calls are prohibited')
  return url
}

export function sameOriginRequest(
  fetcher: FetchLike,
  origin: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  return fetcher(sameOriginUrl(path, origin), {
    ...init,
    headers,
    credentials: 'same-origin',
    redirect: 'error',
  })
}
