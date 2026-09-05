import { readFile } from 'node:fs/promises'
import { buildHostingManifest, loadHostingPolicy } from './lib/hosting.ts'
import { option, writeJsonAtomic } from './lib/files.ts'

const artifactPath = option('--artifact', 'build/candidate/linerecall.html')
const policyPath = option('--policy', 'config/hosting-policy.json')
const outputPath = option('--output', 'build/candidate/hosting-manifest.json')

const [html, policy] = await Promise.all([
  readFile(artifactPath, 'utf8'),
  loadHostingPolicy(policyPath),
])
const manifest = buildHostingManifest(html, policy)
await writeJsonAtomic(outputPath, manifest)
process.stdout.write(
  `Hosting manifest generated: ${outputPath}\nArtifact SHA-256: ${manifest.artifact.sha256}\nImmutable route: ${manifest.deployment.immutableRoute}\n`,
)
