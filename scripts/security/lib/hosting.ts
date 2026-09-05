import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { readCspMeta, verifyCsp } from './csp.ts'

const HeaderNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u)
const HeaderValueSchema = z.string().min(1).refine(
  (value) => !/[\r\n\0]/u.test(value),
  'Header values cannot contain control delimiters',
)

export const HostingPolicySchema = z.object({
  schemaVersion: z.literal(1),
  aliasRoute: z.string().regex(/^\/[a-z0-9._/-]+$/u),
  immutableRoutePrefix: z.string().regex(/^\/[a-z0-9._/-]+$/u),
  httpsOnly: z.literal(true),
  prohibitHtmlMutation: z.literal(true),
  aliasCacheControl: z.literal('no-store, max-age=0, must-revalidate'),
  immutableCacheControl: z.literal('public, max-age=31536000, immutable'),
  requiredResponseHeaders: z.record(HeaderNameSchema, HeaderValueSchema),
}).strict()

export type HostingPolicy = z.infer<typeof HostingPolicySchema>

const RouteSchema = z.object({
  route: z.string().startsWith('/'),
  cacheClass: z.enum(['mutable-alias', 'content-addressed-immutable']),
  headers: z.record(HeaderNameSchema, HeaderValueSchema),
}).strict()

export const HostingManifestSchema = z.object({
  schemaVersion: z.literal(1),
  artifact: z.object({
    file: z.literal('linerecall.html'),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict(),
  deployment: z.object({
    httpsOnly: z.literal(true),
    prohibitHtmlMutation: z.literal(true),
    aliasRoute: z.string().startsWith('/'),
    immutableRoute: z.string().startsWith('/'),
  }).strict(),
  routes: z.tuple([RouteSchema, RouteSchema]),
}).strict()

export type HostingManifest = z.infer<typeof HostingManifestSchema>

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function assertRequiredHeaders(policy: HostingPolicy): void {
  const required = policy.requiredResponseHeaders
  const exact: Readonly<Record<string, string>> = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Origin-Agent-Cluster': '?1',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Permitted-Cross-Domain-Policies': 'none',
    'X-XSS-Protection': '0',
  }
  for (const [name, expected] of Object.entries(exact)) {
    if (required[name] !== expected) throw new Error(`${name} must be ${expected}`)
  }
  const permissions = required['Permissions-Policy']
  if (!permissions) throw new Error('Permissions-Policy is required')
  const features = permissions.split(',').map((entry) => entry.trim())
  if (features.length < 10 || features.some((entry) => !/^[a-z][a-z0-9-]*=\(\)$/u.test(entry))) {
    throw new Error('Permissions-Policy must contain only explicit empty feature allowlists')
  }
  if (new Set(features.map((entry) => entry.split('=', 1)[0])).size !== features.length) {
    throw new Error('Permissions-Policy contains a duplicate feature')
  }
}

export async function loadHostingPolicy(path = 'config/hosting-policy.json'): Promise<HostingPolicy> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'))
  const policy = HostingPolicySchema.parse(raw)
  assertRequiredHeaders(policy)
  return policy
}

export function buildHostingManifest(html: string, policy: HostingPolicy): HostingManifest {
  assertRequiredHeaders(policy)
  const cspVerification = verifyCsp(html)
  if (!cspVerification.valid) throw new Error('The hosted artifact CSP is missing or stale')
  const csp = readCspMeta(html)
  if (!csp) throw new Error('The hosted artifact has no CSP meta policy')
  if (/[\r\n\0]/u.test(csp)) throw new Error('The CSP contains an invalid header delimiter')
  const digest = sha256(html)
  const commonHeaders = {
    ...policy.requiredResponseHeaders,
    'Content-Security-Policy': csp,
  }
  const immutableRoute = `${policy.immutableRoutePrefix}/${digest}/linerecall.html`
  const manifest = {
    schemaVersion: 1 as const,
    artifact: { file: 'linerecall.html' as const, bytes: Buffer.byteLength(html, 'utf8'), sha256: digest },
    deployment: {
      httpsOnly: true as const,
      prohibitHtmlMutation: true as const,
      aliasRoute: policy.aliasRoute,
      immutableRoute,
    },
    routes: [
      {
        route: policy.aliasRoute,
        cacheClass: 'mutable-alias' as const,
        headers: { ...commonHeaders, 'Cache-Control': policy.aliasCacheControl },
      },
      {
        route: immutableRoute,
        cacheClass: 'content-addressed-immutable' as const,
        headers: { ...commonHeaders, 'Cache-Control': policy.immutableCacheControl },
      },
    ] as const,
  }
  return HostingManifestSchema.parse(manifest)
}

export function responseHeadersForAlias(html: string, policy: HostingPolicy): Readonly<Record<string, string>> {
  return buildHostingManifest(html, policy).routes[0].headers
}

export function cspDirectives(policy: string): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>()
  for (const segment of policy.split(';')) {
    const tokens = segment.trim().split(/\s+/u).filter(Boolean)
    const name = tokens.shift()
    if (!name) continue
    if (result.has(name)) throw new Error(`CSP contains duplicate ${name} directive`)
    result.set(name, tokens)
  }
  return result
}
