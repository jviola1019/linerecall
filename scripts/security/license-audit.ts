import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { fileExists, option, workspaceRoot } from './lib/files.ts'
import { finishReport, makeReport, type CheckResult } from './lib/report.ts'

const PolicySchema = z.object({
  schemaVersion: z.literal(1),
  approvedDependencyLicenses: z.array(z.string().min(1)),
  approvedDataLicenses: z.array(z.string().min(1)),
  approvedAssetLicenses: z.array(z.string().min(1)),
  offlineAuditOnlyLicenses: z.array(z.string().min(1)),
  requiredDerivedDataNotice: z.string().min(1),
  policy: z.string().min(1),
}).strict()

const LockSchema = z.object({
  packages: z.record(z.string(), z.object({
    name: z.string().optional(),
    version: z.string().optional(),
    dev: z.boolean().optional(),
    optional: z.boolean().optional(),
    license: z.string().optional(),
  }).passthrough()),
}).passthrough()

const InfrastructureToolchainSchema = z.object({
  schemaVersion: z.literal(1),
  dependencies: z.array(z.object({
    name: z.string().min(1),
    identifier: z.string().min(1),
    versionConstraint: z.string().min(1),
    license: z.string().min(1),
    scope: z.literal('build-tool'),
    declarationPath: z.string().min(1).optional(),
    providerLockPath: z.string().min(1).optional(),
    providerLockStatus: z.enum([
      'generate-and-review-before-apply',
      'generated-and-reviewed-no-apply',
    ]).optional(),
  }).strict()).min(1),
  providerLockPath: z.string().min(1),
  providerLockStatus: z.literal('generate-and-review-before-apply'),
}).strict()

function normalizeLicense(value: unknown): string[] {
  if (typeof value !== 'string') return []
  const normalized = value.trim().replace(/^\(|\)$/gu, '')
  return normalized.split(/\s+(?:OR|AND)\s+/u).map((part) => part.replace(/^\(|\)$/gu, '').trim()).filter(Boolean)
}

function packageNameFromLockPath(path: string): string {
  const marker = '/node_modules/'
  const index = path.lastIndexOf(marker)
  return index >= 0 ? path.slice(index + marker.length) : path.replace(/^node_modules\//u, '')
}

async function installedLicense(baseDirectory: string, lockPath: string, lockLicense?: string): Promise<{ raw: unknown; parts: string[] }> {
  const packageJsonPath = join(baseDirectory, lockPath, 'package.json')
  if (!(await fileExists(packageJsonPath))) return { raw: lockLicense ?? null, parts: normalizeLicense(lockLicense) }
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { license?: unknown; licenses?: unknown }
  const raw = packageJson.license ?? packageJson.licenses ?? null
  if (Array.isArray(raw)) {
    return {
      raw,
      parts: raw.flatMap((entry) => normalizeLicense(
        typeof entry === 'object' && entry !== null && 'type' in entry
          ? (entry as { type?: unknown }).type
          : entry,
      )),
    }
  }
  return { raw, parts: normalizeLicense(raw) }
}

function manifestLicense(value: unknown): { spdx: string | null; distributionPolicy: string | null; status: string | null } {
  if (typeof value !== 'object' || value === null) return { spdx: null, distributionPolicy: null, status: null }
  const record = value as Record<string, unknown>
  const license = record.license
  const source = record.source
  const licenseRecord = typeof license === 'object' && license !== null ? license as Record<string, unknown> : null
  const sourceRecord = typeof source === 'object' && source !== null ? source as Record<string, unknown> : null
  const approval = typeof record.approval === 'object' && record.approval !== null ? record.approval as Record<string, unknown> : null
  const raw = licenseRecord?.spdx ?? licenseRecord?.spdxId ?? sourceRecord?.license ?? null
  const mapped = raw === 'CC BY-SA 4.0' ? 'CC-BY-SA-4.0' : raw
  return {
    spdx: typeof mapped === 'string' ? mapped : null,
    distributionPolicy: typeof licenseRecord?.distributionPolicy === 'string' ? licenseRecord.distributionPolicy : null,
    status: typeof approval?.status === 'string' ? approval.status : null,
  }
}

export async function auditLicenses(): Promise<readonly CheckResult[]> {
  const policy = PolicySchema.parse(JSON.parse(await readFile(resolve(workspaceRoot, 'config/license-policy.json'), 'utf8')))
  const approvedDependencies = new Set(policy.approvedDependencyLicenses)
  const dependencyFindings: Array<Record<string, unknown>> = []
  const dependencies: Array<Record<string, unknown>> = []

  const lockfiles = [
    { path: 'package-lock.json', installRoot: workspaceRoot, application: 'client' },
    { path: 'hosted/package-lock.json', installRoot: resolve(workspaceRoot, 'hosted'), application: 'hosted-client' },
    { path: 'server/package-lock.json', installRoot: resolve(workspaceRoot, 'server'), application: 'connected-server' },
  ] as const
  for (const lockfile of lockfiles) {
    const lock = LockSchema.parse(JSON.parse(await readFile(resolve(workspaceRoot, lockfile.path), 'utf8')))
    for (const [lockPath, entry] of Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right))) {
      if (!lockPath.startsWith('node_modules/')) continue
      const licensed = await installedLicense(lockfile.installRoot, lockPath, entry.license)
      const approved = licensed.parts.length > 0 && licensed.parts.every((license) => approvedDependencies.has(license))
      const item = {
        application: lockfile.application,
        name: entry.name ?? packageNameFromLockPath(lockPath),
        version: entry.version ?? 'unknown',
        scope: entry.dev ? 'development' : 'runtime',
        optional: entry.optional ?? false,
        licenses: licensed.parts,
        approved,
      }
      dependencies.push(item)
      if (!approved) dependencyFindings.push({ ...item, rawLicense: licensed.raw })
    }
  }

  const manifestFiles = [
    { path: 'data/manifests/taxonomy.source.json', class: 'data' },
    { path: 'data/manifests/broadcasts.source.json', class: 'data' },
    { path: 'data/manifests/lichess-standard-q2-2026.source.json', class: 'data' },
    { path: 'data/manifests/lichess-puzzles.source.json', class: 'data' },
    { path: 'data/manifests/stockfish-18.source.json', class: 'offline-tool' },
    { path: 'data/manifests/scid.source.json', class: 'offline-tool' },
    { path: 'data/manifests/chessnut-pieces.source.json', class: 'asset' },
  ] as const
  const approvedData = new Set(policy.approvedDataLicenses)
  const approvedAssets = new Set(policy.approvedAssetLicenses)
  const offlineOnly = new Set(policy.offlineAuditOnlyLicenses)
  const sourceFindings: Array<Record<string, unknown>> = []
  const sources: Array<Record<string, unknown>> = []
  for (const manifest of manifestFiles) {
    const parsed = JSON.parse(await readFile(resolve(workspaceRoot, manifest.path), 'utf8')) as unknown
    const details = manifestLicense(parsed)
    const auditOnly = manifest.class === 'offline-tool' && offlineOnly.has(details.spdx ?? '')
    const distributionRestricted = auditOnly && /(?:only|do not|not (?:included|copied|redistributed|bundle))/iu.test(details.distributionPolicy ?? '')
    const approved = details.status === 'approved'
      && (manifest.class === 'asset'
        ? approvedAssets.has(details.spdx ?? '')
        : approvedData.has(details.spdx ?? '') || distributionRestricted)
    const item = { manifestPath: manifest.path, sourceClass: manifest.class, ...details, auditOnly, approved }
    sources.push(item)
    if (!approved) sourceFindings.push(item)
  }

  const noticePath = resolve(workspaceRoot, policy.requiredDerivedDataNotice)
  const notice = await fileExists(noticePath) ? await readFile(noticePath, 'utf8') : ''
  const noticeFindings: Array<Record<string, unknown>> = []
  for (const required of ['CC BY-SA 4.0', 'database.lichess.org', 'Attribution-ShareAlike']) {
    if (!notice.includes(required)) noticeFindings.push({ missingText: required })
  }

  const toolchain = InfrastructureToolchainSchema.parse(JSON.parse(
    await readFile(resolve(workspaceRoot, 'infra/toolchain-dependencies.json'), 'utf8'),
  ))
  const infrastructureFindings: Array<Record<string, unknown>> = []
  for (const dependency of toolchain.dependencies) {
    const declarationPath = dependency.declarationPath ?? 'infra/versions.tf'
    const declarationFile = resolve(workspaceRoot, declarationPath)
    if (!(await fileExists(declarationFile))) {
      infrastructureFindings.push({ ...dependency, declarationPath, rule: 'infrastructure-declaration-missing' })
      continue
    }
    const versions = await readFile(declarationFile, 'utf8')
    if (!approvedDependencies.has(dependency.license)) {
      infrastructureFindings.push({ ...dependency, declarationPath, rule: 'unapproved-infrastructure-license' })
    }
    const expectedSource = dependency.identifier === 'opentofu' ? null : dependency.identifier.replace('registry.opentofu.org/', '')
    if (expectedSource && !versions.includes(expectedSource)) {
      infrastructureFindings.push({ ...dependency, declarationPath, rule: 'infrastructure-source-not-declared' })
    }
    if (!versions.includes(dependency.versionConstraint.replace(' ', ''))) {
      const normalizedVersions = versions.replaceAll(/\s+/gu, '')
      if (!normalizedVersions.includes(dependency.versionConstraint.replaceAll(/\s+/gu, ''))) {
        infrastructureFindings.push({ ...dependency, declarationPath, rule: 'infrastructure-version-constraint-mismatch' })
      }
    }

    if (dependency.providerLockStatus === 'generated-and-reviewed-no-apply') {
      const lockPath = dependency.providerLockPath
      if (!lockPath || !(await fileExists(resolve(workspaceRoot, lockPath)))) {
        infrastructureFindings.push({ ...dependency, declarationPath, rule: 'reviewed-provider-lock-missing' })
      } else {
        const lock = await readFile(resolve(workspaceRoot, lockPath), 'utf8')
        const pinnedVersion = dependency.versionConstraint.replace(/^[=~><\s]+/u, '')
        if (!lock.includes(`provider "${dependency.identifier}"`)) {
          infrastructureFindings.push({ ...dependency, declarationPath, rule: 'reviewed-provider-lock-source-mismatch' })
        }
        if (!lock.includes(`version     = "${pinnedVersion}"`)) {
          infrastructureFindings.push({ ...dependency, declarationPath, rule: 'reviewed-provider-lock-version-mismatch' })
        }
      }
    }
  }

  const applicationLicenseFindings: Array<Record<string, unknown>> = []
  for (const packagePath of ['package.json', 'hosted/package.json', 'server/package.json']) {
    const packageValue = JSON.parse(await readFile(resolve(workspaceRoot, packagePath), 'utf8')) as { license?: unknown }
    if (packageValue.license !== 'Apache-2.0') {
      applicationLicenseFindings.push({
        rule: 'application-package-license-mismatch',
        path: packagePath,
        expected: 'Apache-2.0',
        actual: packageValue.license ?? null,
      })
    }
  }
  for (const licensePath of ['LICENSE', 'licenses/Apache-2.0.txt', 'docs/LICENSE_BOUNDARIES.md']) {
    if (!(await fileExists(resolve(workspaceRoot, licensePath)))) {
      applicationLicenseFindings.push({ rule: 'application-license-notice-missing', path: licensePath })
    }
  }
  const boundaryNotice = await fileExists(resolve(workspaceRoot, 'docs/LICENSE_BOUNDARIES.md'))
    ? await readFile(resolve(workspaceRoot, 'docs/LICENSE_BOUNDARIES.md'), 'utf8')
    : ''
  for (const requiredBoundary of ['Apache-2.0', 'CC BY-SA 4.0', 'CC0', 'GPL']) {
    if (!boundaryNotice.includes(requiredBoundary)) {
      applicationLicenseFindings.push({ rule: 'application-license-boundary-omitted', missingText: requiredBoundary })
    }
  }

  return [
    {
      id: 'application-code-license-boundary',
      status: applicationLicenseFindings.length === 0 ? 'pass' : 'fail',
      summary: applicationLicenseFindings.length === 0
        ? 'Application packages and original interface work declare Apache-2.0 without relicensing data, assets, or audit tools'
        : `${applicationLicenseFindings.length} application-code license boundary finding(s)`,
      findings: applicationLicenseFindings,
    },
    {
      id: 'dependency-license-allowlist',
      status: dependencyFindings.length === 0 ? 'pass' : 'fail',
      summary: dependencyFindings.length === 0 ? `${dependencies.length} installed dependency packages are allowlisted` : `${dependencyFindings.length} dependency license(s) require review`,
      findings: dependencyFindings,
      metrics: { packages: dependencies.length },
    },
    {
      id: 'source-license-boundaries',
      status: sourceFindings.length === 0 ? 'pass' : 'fail',
      summary: sourceFindings.length === 0 ? 'Data, interface-asset, and offline audit sources have approved, separated use boundaries' : `${sourceFindings.length} source license boundary finding(s)`,
      findings: sourceFindings,
      metrics: { sources: sources.length },
    },
    {
      id: 'derived-data-notice',
      status: noticeFindings.length === 0 ? 'pass' : 'fail',
      summary: noticeFindings.length === 0 ? 'CC BY-SA 4.0 attribution/share-alike notice is present' : 'Derived-data notice is missing required attribution terms',
      findings: noticeFindings,
    },
    {
      id: 'infrastructure-tool-license-boundary',
      status: infrastructureFindings.length === 0 ? 'pass' : 'fail',
      summary: infrastructureFindings.length === 0
        ? `${toolchain.dependencies.length} declared infrastructure build dependencies have approved licenses and matching constraints`
        : `${infrastructureFindings.length} infrastructure dependency license/declaration finding(s)`,
      findings: infrastructureFindings,
      metrics: {
        dependencies: toolchain.dependencies.length,
        providerLockPath: toolchain.providerLockPath,
        providerLockStatus: toolchain.providerLockStatus,
      },
    },
  ]
}

const output = option('--output', 'audit/generated/license-audit.json')
await finishReport(output, makeReport('license-audit', await auditLicenses()))
