import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { collectFiles, fileExists, option, sha256File, workspaceRelative, workspaceRoot, writeJsonAtomic } from './lib/files.ts'

interface LockPackage {
  name?: string
  version?: string
  resolved?: string
  integrity?: string
  dev?: boolean
  optional?: boolean
  license?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function integrityHash(value: string | undefined): Array<{ alg: string; content: string }> | undefined {
  if (!value) return undefined
  const [algorithm, encoded] = value.split('-', 2)
  if (!algorithm || !encoded || algorithm.toLowerCase() !== 'sha512') return undefined
  return [{ alg: 'SHA-512', content: Buffer.from(encoded, 'base64').toString('hex') }]
}

function purl(name: string, version: string): string {
  const encoded = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name)
  return `pkg:npm/${encoded}@${encodeURIComponent(version)}`
}

function packageNameFromLockPath(path: string): string {
  const marker = '/node_modules/'
  const index = path.lastIndexOf(marker)
  return index >= 0 ? path.slice(index + marker.length) : path.replace(/^node_modules\//u, '')
}

const lock = JSON.parse(await readFile(resolve(workspaceRoot, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, LockPackage>
}
const serverLock = JSON.parse(await readFile(resolve(workspaceRoot, 'server/package-lock.json'), 'utf8')) as {
  packages: Record<string, LockPackage>
}
const hostedLock = JSON.parse(await readFile(resolve(workspaceRoot, 'hosted/package-lock.json'), 'utf8')) as {
  packages: Record<string, LockPackage>
}
const packageJson = JSON.parse(await readFile(resolve(workspaceRoot, 'package.json'), 'utf8')) as {
  name: string
  version: string
}
const serverPackageJson = JSON.parse(await readFile(resolve(workspaceRoot, 'server/package.json'), 'utf8')) as {
  name: string
  version: string
}
const hostedPackageJson = JSON.parse(await readFile(resolve(workspaceRoot, 'hosted/package.json'), 'utf8')) as {
  name: string
  version: string
}
const infrastructureToolchain = JSON.parse(await readFile(
  resolve(workspaceRoot, 'infra/toolchain-dependencies.json'), 'utf8',
)) as {
  schemaVersion: number
  providerLockPath: string
  providerLockStatus: string
  dependencies: Array<{
    name: string
    identifier: string
    versionConstraint: string
    license: string
    scope: string
    declarationPath?: string
    providerLockPath?: string
    providerLockStatus?: string
  }>
}
const components: Array<Record<string, unknown>> = []
const refsByLockPath = new Map<string, string>()
for (const [path, entry] of Object.entries(lock.packages).sort(([left], [right]) => left.localeCompare(right))) {
  if (!path.startsWith('node_modules/') || !entry.version) continue
  const name = entry.name ?? packageNameFromLockPath(path)
  const reference = `linerecall:npm:${createHash('sha256').update(`${path}:${name}@${entry.version}`).digest('hex').slice(0, 24)}`
  refsByLockPath.set(path, reference)
  components.push({
    type: 'library',
    'bom-ref': reference,
    name,
    version: entry.version,
    scope: entry.dev ? 'excluded' : entry.optional ? 'optional' : 'required',
    purl: purl(name, entry.version),
    ...(entry.license ? { licenses: [{ license: { id: entry.license } }] } : {}),
    ...(integrityHash(entry.integrity) ? { hashes: integrityHash(entry.integrity) } : {}),
    ...(entry.resolved ? { externalReferences: [{ type: 'distribution', url: entry.resolved }] } : {}),
    properties: [{ name: 'linerecall:lockPath', value: path }],
  })
}

const serverRefsByLockPath = new Map<string, string>()
for (const [path, entry] of Object.entries(serverLock.packages).sort(([left], [right]) => left.localeCompare(right))) {
  if (!path.startsWith('node_modules/') || !entry.version) continue
  const name = entry.name ?? packageNameFromLockPath(path)
  const reference = `linerecall:server:npm:${createHash('sha256').update(`${path}:${name}@${entry.version}`).digest('hex').slice(0, 24)}`
  serverRefsByLockPath.set(path, reference)
  components.push({
    type: 'library',
    'bom-ref': reference,
    name,
    version: entry.version,
    scope: entry.dev ? 'excluded' : entry.optional ? 'optional' : 'required',
    purl: purl(name, entry.version),
    ...(entry.license ? { licenses: [{ license: { id: entry.license } }] } : {}),
    ...(integrityHash(entry.integrity) ? { hashes: integrityHash(entry.integrity) } : {}),
    ...(entry.resolved ? { externalReferences: [{ type: 'distribution', url: entry.resolved }] } : {}),
    properties: [
      { name: 'linerecall:application', value: 'connected-server' },
      { name: 'linerecall:lockPath', value: `server/${path}` },
    ],
  })
}

const hostedRefsByLockPath = new Map<string, string>()
for (const [path, entry] of Object.entries(hostedLock.packages).sort(([left], [right]) => left.localeCompare(right))) {
  if (!path.startsWith('node_modules/') || !entry.version) continue
  const name = entry.name ?? packageNameFromLockPath(path)
  const reference = `linerecall:hosted:npm:${createHash('sha256').update(`${path}:${name}@${entry.version}`).digest('hex').slice(0, 24)}`
  hostedRefsByLockPath.set(path, reference)
  components.push({
    type: 'library',
    'bom-ref': reference,
    name,
    version: entry.version,
    scope: entry.dev ? 'excluded' : entry.optional ? 'optional' : 'required',
    purl: purl(name, entry.version),
    ...(entry.license ? { licenses: [{ license: { id: entry.license } }] } : {}),
    ...(integrityHash(entry.integrity) ? { hashes: integrityHash(entry.integrity) } : {}),
    ...(entry.resolved ? { externalReferences: [{ type: 'distribution', url: entry.resolved }] } : {}),
    properties: [
      { name: 'linerecall:application', value: 'hosted-client' },
      { name: 'linerecall:lockPath', value: `hosted/${path}` },
    ],
  })
}

const deploymentFileRefs: Array<{ ref: string; path: string }> = []
const deploymentFiles = await collectFiles([
  'hosted/src', 'hosted/tests', 'hosted/index.html', 'hosted/package.json', 'hosted/package-lock.json',
  'hosted/tsconfig.json', 'hosted/vite.config.ts',
  'server/src', 'server/migrations', 'server/package.json', 'server/package-lock.json',
  'server/Dockerfile', 'server/compose.yaml', 'infra',
], {
  extensions: new Set(['', '.hcl', '.json', '.sql', '.tf', '.tfvars', '.ts', '.yaml', '.yml']),
  maxBytes: 5 * 1024 * 1024,
})
for (const path of deploymentFiles) {
  const relativePath = workspaceRelative(path)
  const reference = `linerecall:file:${createHash('sha256').update(relativePath).digest('hex').slice(0, 24)}`
  deploymentFileRefs.push({ ref: reference, path: relativePath })
  components.push({
    type: 'file',
    'bom-ref': reference,
    name: relativePath,
    scope: 'required',
    hashes: [{ alg: 'SHA-256', content: await sha256File(path) }],
    properties: [{
      name: 'linerecall:application',
      value: relativePath.startsWith('hosted/')
        ? 'hosted-client'
        : relativePath.startsWith('server/')
          ? 'connected-server'
          : relativePath.startsWith('infra/oci-zero-spend/')
            ? 'oci-zero-spend-reference-infrastructure'
            : 'aws-reference-infrastructure',
    }],
  })
}

const infrastructureToolRefs = new Map<string, string>()
for (const dependency of infrastructureToolchain.dependencies) {
  const reference = `linerecall:infra-tool:${createHash('sha256').update(dependency.identifier).digest('hex').slice(0, 20)}`
  infrastructureToolRefs.set(dependency.identifier, reference)
  components.push({
    type: 'application',
    'bom-ref': reference,
    name: dependency.name,
    version: dependency.versionConstraint,
    scope: 'excluded',
    licenses: [{ license: { id: dependency.license } }],
    properties: [
      { name: 'linerecall:dependencyIdentifier', value: dependency.identifier },
      { name: 'linerecall:distributionBoundary', value: 'deployment build tool; not shipped in the browser or API image' },
      { name: 'linerecall:declarationPath', value: dependency.declarationPath ?? 'infra/versions.tf' },
      { name: 'linerecall:providerLockPath', value: dependency.providerLockPath ?? infrastructureToolchain.providerLockPath },
      { name: 'linerecall:providerLockStatus', value: dependency.providerLockStatus ?? infrastructureToolchain.providerLockStatus },
    ],
  })
}

const productionEmbeddedSnapshot = 'build/production/embedded-snapshot.json'
const reviewEmbeddedSnapshot = 'src/generated/embedded-snapshot.json'
const embeddedSnapshotManifest = await fileExists(resolve(workspaceRoot, productionEmbeddedSnapshot))
  ? productionEmbeddedSnapshot
  : reviewEmbeddedSnapshot
const embeddedSnapshotValue = JSON.parse(
  await readFile(resolve(workspaceRoot, embeddedSnapshotManifest), 'utf8'),
) as { schema?: unknown }
if (
  embeddedSnapshotValue.schema !== 'linerecall-app-wire-v2'
  && embeddedSnapshotValue.schema !== 'linerecall-app-wire-v3'
) throw new Error('Embedded snapshot SBOM input has an unsupported schema')

const dataComponents = [
  { name: 'Lichess chess-openings taxonomy', version: '17ee660257de02870636f36248e919f2e01d8e85', license: 'CC0-1.0', manifest: 'data/manifests/taxonomy.source.json', scope: 'required' },
  { name: 'Lichess official broadcast-derived statistics', version: '2020-01..2026-06', license: 'CC-BY-SA-4.0', manifest: 'data/manifests/broadcasts.source.json', scope: 'required' },
  { name: 'LineRecall embedded opening snapshot', version: embeddedSnapshotValue.schema, license: 'CC-BY-SA-4.0', manifest: embeddedSnapshotManifest, scope: 'required' },
  { name: 'Chessnut SVG chess pieces by Alexis Luengas', version: '3b7f2811bfb0682932f40688fcfb5d5caf7aece3', license: 'Apache-2.0', manifest: 'data/manifests/chessnut-pieces.source.json', scope: 'required', componentType: 'file' },
  { name: 'Lichess Standard rated Q2 2026 source corpus', version: '2026-04..2026-06', license: 'CC0-1.0', manifest: 'data/manifests/lichess-standard-q2-2026.source.json', scope: 'excluded' },
  { name: 'Lichess puzzle source corpus', version: '2026-07-05', license: 'CC0-1.0', manifest: 'data/manifests/lichess-puzzles.source.json', scope: 'excluded' },
  { name: 'Stockfish audit engine', version: '18', license: 'GPL-3.0-only', manifest: 'data/manifests/stockfish-18.source.json', scope: 'excluded' },
  { name: 'Scid ECO audit oracle', version: '8ffd1e3a02b9f61b5616e38b18ce932b904e04ff', license: 'GPL-2.0-only', manifest: 'data/manifests/scid.source.json', scope: 'excluded' },
] as const
const requiredDataRefs: string[] = []
for (const source of dataComponents) {
  const manifestPath = resolve(workspaceRoot, source.manifest)
  const reference = `linerecall:source:${createHash('sha256').update(source.name).digest('hex').slice(0, 16)}`
  if (source.scope === 'required') requiredDataRefs.push(reference)
  components.push({
    type: 'componentType' in source ? source.componentType : source.scope === 'required' ? 'data' : 'application',
    'bom-ref': reference,
    name: source.name,
    version: source.version,
    scope: source.scope,
    licenses: [{ license: { id: source.license } }],
    hashes: [{ alg: 'SHA-256', content: await sha256File(manifestPath) }],
    properties: [
      { name: 'linerecall:manifest', value: source.manifest },
      { name: 'linerecall:distributionBoundary', value: source.scope === 'excluded' ? 'offline-audit-only; not shipped' : 'shipped with attribution/provenance' },
    ],
  })
}

function resolveDependencyPath(refs: ReadonlyMap<string, string>, fromPath: string, dependencyName: string): string | null {
  let cursor = fromPath
  while (true) {
    const candidate = cursor ? `${cursor}/node_modules/${dependencyName}` : `node_modules/${dependencyName}`
    if (refs.has(candidate)) return candidate
    const nestedIndex = cursor.lastIndexOf('/node_modules/')
    if (nestedIndex >= 0) cursor = cursor.slice(0, nestedIndex)
    else if (cursor !== '') cursor = ''
    else return null
  }
}

const dependencyGraph: Array<{ ref: string; dependsOn: string[] }> = []
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith('node_modules/') || !entry.version) continue
  const reference = refsByLockPath.get(path)
  if (!reference) continue
  const names = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
  ])
  const dependsOn = [...names].flatMap((name) => {
    const dependencyPath = resolveDependencyPath(refsByLockPath, path, name)
    const dependencyReference = dependencyPath ? refsByLockPath.get(dependencyPath) : undefined
    return dependencyReference ? [dependencyReference] : []
  }).sort()
  dependencyGraph.push({ ref: reference, dependsOn })
}
const rootReference = `pkg:npm/${packageJson.name}@${packageJson.version}`
const hostedRootReference = 'linerecall:application:hosted-client'
const serverRootReference = 'linerecall:application:connected-server'
const awsInfrastructureRootReference = 'linerecall:application:aws-reference-infrastructure'
const ociInfrastructureRootReference = 'linerecall:application:oci-zero-spend-reference-infrastructure'
components.push({
  type: 'application',
  'bom-ref': hostedRootReference,
  name: hostedPackageJson.name,
  version: hostedPackageJson.version,
  scope: 'required',
  purl: purl(hostedPackageJson.name, hostedPackageJson.version),
  properties: [{ name: 'linerecall:application', value: 'hosted-client' }],
})
components.push({
  type: 'application',
  'bom-ref': serverRootReference,
  name: serverPackageJson.name,
  version: serverPackageJson.version,
  scope: 'required',
  purl: purl(serverPackageJson.name, serverPackageJson.version),
  properties: [{ name: 'linerecall:application', value: 'connected-server' }],
})
components.push({
  type: 'application',
  'bom-ref': awsInfrastructureRootReference,
  name: 'LineRecall AWS reference infrastructure',
  version: packageJson.version,
  scope: 'required',
  properties: [{ name: 'linerecall:application', value: 'aws-reference-infrastructure' }],
})
components.push({
  type: 'application',
  'bom-ref': ociInfrastructureRootReference,
  name: 'LineRecall OCI zero-spend reference infrastructure',
  version: packageJson.version,
  scope: 'required',
  properties: [{ name: 'linerecall:application', value: 'oci-zero-spend-reference-infrastructure' }],
})
const rootEntry = lock.packages[''] ?? {}
const rootDependencyNames = new Set([
  ...Object.keys(rootEntry.dependencies ?? {}),
  ...Object.keys(rootEntry.optionalDependencies ?? {}),
])
dependencyGraph.unshift({
  ref: rootReference,
  dependsOn: [
    ...[...rootDependencyNames].flatMap((name) => {
      const reference = refsByLockPath.get(`node_modules/${name}`)
      return reference ? [reference] : []
    }),
    hostedRootReference,
    serverRootReference,
    awsInfrastructureRootReference,
    ociInfrastructureRootReference,
    ...requiredDataRefs,
  ].sort(),
})

for (const [path, entry] of Object.entries(hostedLock.packages)) {
  if (!path.startsWith('node_modules/') || !entry.version) continue
  const reference = hostedRefsByLockPath.get(path)
  if (!reference) continue
  const names = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
  ])
  const dependsOn = [...names].flatMap((name) => {
    const dependencyPath = resolveDependencyPath(hostedRefsByLockPath, path, name)
    const dependencyReference = dependencyPath ? hostedRefsByLockPath.get(dependencyPath) : undefined
    return dependencyReference ? [dependencyReference] : []
  }).sort()
  dependencyGraph.push({ ref: reference, dependsOn })
}
const hostedRootEntry = hostedLock.packages[''] ?? {}
const hostedRootDependencyNames = new Set([
  ...Object.keys(hostedRootEntry.dependencies ?? {}),
  ...Object.keys(hostedRootEntry.optionalDependencies ?? {}),
])
dependencyGraph.push({
  ref: hostedRootReference,
  dependsOn: [
    ...[...hostedRootDependencyNames].flatMap((name) => {
      const reference = hostedRefsByLockPath.get(`node_modules/${name}`)
      return reference ? [reference] : []
    }),
    ...deploymentFileRefs.filter((item) => item.path.startsWith('hosted/')).map((item) => item.ref),
    ...requiredDataRefs,
  ].sort(),
})

for (const [path, entry] of Object.entries(serverLock.packages)) {
  if (!path.startsWith('node_modules/') || !entry.version) continue
  const reference = serverRefsByLockPath.get(path)
  if (!reference) continue
  const names = new Set([
    ...Object.keys(entry.dependencies ?? {}),
    ...Object.keys(entry.optionalDependencies ?? {}),
    ...Object.keys(entry.peerDependencies ?? {}),
  ])
  const dependsOn = [...names].flatMap((name) => {
    const dependencyPath = resolveDependencyPath(serverRefsByLockPath, path, name)
    const dependencyReference = dependencyPath ? serverRefsByLockPath.get(dependencyPath) : undefined
    return dependencyReference ? [dependencyReference] : []
  }).sort()
  dependencyGraph.push({ ref: reference, dependsOn })
}
const serverRootEntry = serverLock.packages[''] ?? {}
const serverRootDependencyNames = new Set([
  ...Object.keys(serverRootEntry.dependencies ?? {}),
  ...Object.keys(serverRootEntry.optionalDependencies ?? {}),
])
dependencyGraph.push({
  ref: serverRootReference,
  dependsOn: [
    ...[...serverRootDependencyNames].flatMap((name) => {
      const reference = serverRefsByLockPath.get(`node_modules/${name}`)
      return reference ? [reference] : []
    }),
    ...deploymentFileRefs.filter((item) => item.path.startsWith('server/')).map((item) => item.ref),
  ].sort(),
})
dependencyGraph.push({
  ref: awsInfrastructureRootReference,
  dependsOn: [
    ...['opentofu', 'registry.opentofu.org/hashicorp/aws'].flatMap((identifier) => {
      const reference = infrastructureToolRefs.get(identifier)
      return reference ? [reference] : []
    }),
    ...deploymentFileRefs
      .filter((item) => item.path.startsWith('infra/') && !item.path.startsWith('infra/oci-zero-spend/'))
      .map((item) => item.ref),
  ].sort(),
})
dependencyGraph.push({
  ref: ociInfrastructureRootReference,
  dependsOn: [
    ...['opentofu', 'registry.opentofu.org/oracle/oci'].flatMap((identifier) => {
      const reference = infrastructureToolRefs.get(identifier)
      return reference ? [reference] : []
    }),
    ...deploymentFileRefs.filter((item) => item.path.startsWith('infra/oci-zero-spend/')).map((item) => item.ref),
  ].sort(),
})

const output = option('--output', 'audit/generated/sbom.cdx.json')
const serial = process.env.SOURCE_DATE_EPOCH
  ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
  : new Date().toISOString()
const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  serialNumber: `urn:uuid:${randomUUID()}`,
  version: 1,
  metadata: {
    timestamp: serial,
    tools: { components: [{ type: 'application', name: 'LineRecall SBOM generator', version: '1' }] },
    component: {
      type: 'application',
      'bom-ref': rootReference,
      name: packageJson.name,
      version: packageJson.version,
      purl: `pkg:npm/${packageJson.name}@${packageJson.version}`,
    },
    properties: [
      { name: 'linerecall:notice', value: 'Backtest derivatives are separately licensed CC-BY-SA-4.0; excluded audit tools do not ship.' },
    ],
  },
  components,
  dependencies: dependencyGraph,
}
await writeJsonAtomic(output, sbom)
process.stdout.write(`CycloneDX 1.5 SBOM: ${output} (${components.length} components)\n`)
