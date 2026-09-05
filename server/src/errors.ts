export class ApiError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly retryAfterSeconds: number | undefined
  readonly details: Array<{ path: string; message: string }> | undefined

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: {
      retryAfterSeconds?: number
      details?: Array<{ path: string; message: string }>
    } = {},
  ) {
    super(message)
    this.name = 'ApiError'
    this.statusCode = statusCode
    this.code = code
    this.retryAfterSeconds = options.retryAfterSeconds
    this.details = options.details
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError
}
