import { describe, expect, it, vi } from 'vitest'
import { HttpProblem, expectJson, readBoundedJson, sameOriginRequest, sameOriginUrl } from '../src/http.ts'

describe('hosted HTTP boundary', () => {
  it('allows only root-relative same-origin API paths and pins credentials', async () => {
    expect(sameOriginUrl('/v1/sync', 'https://app.example.test').toString()).toBe('https://app.example.test/v1/sync')
    expect(() => sameOriginUrl('//evil.example/x', 'https://app.example.test')).toThrow(/root-relative/)
    expect(() => sameOriginUrl('https://evil.example/x', 'https://app.example.test')).toThrow(/root-relative/)
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe('same-origin')
      expect(init?.redirect).toBe('error')
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    })
    const response = await sameOriginRequest(fetcher, 'https://app.example.test', '/v1/test')
    expect(await response.json()).toEqual({ ok: true })
  })

  it('rejects oversized, malformed, and unvalidated error responses', async () => {
    await expect(readBoundedJson(new Response('x', { headers: { 'content-length': '999' } }), 10)).rejects.toBeInstanceOf(HttpProblem)
    await expect(readBoundedJson(new Response('{bad'))).rejects.toMatchObject({ code: 'invalid_json' })
    await expect(expectJson(new Response(JSON.stringify({ error: { code: 'limited', message: 'Wait', requestId: 'r', retryAfterSeconds: 60 } }), { status: 429 }), () => null))
      .rejects.toMatchObject({ status: 429, code: 'limited', retryAfterSeconds: 60 })
    await expect(expectJson(new Response('{"unexpected":true}', { status: 500 }), () => null))
      .rejects.toMatchObject({ status: 500, code: 'request_failed' })
  })
})
