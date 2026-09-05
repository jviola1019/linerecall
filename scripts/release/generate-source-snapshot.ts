import { option, workspaceRoot, writeJsonAtomic } from '../security/lib/files.ts'
import { createSourceSnapshot } from './lib/source-snapshot.ts'

const output = option('--output', 'audit/generated/connected-source-snapshot.json')
const manifest = await createSourceSnapshot(workspaceRoot)
await writeJsonAtomic(output, manifest)
process.stdout.write(`${JSON.stringify({
  output: output.slice(workspaceRoot.length + 1).replaceAll('\\', '/'),
  files: manifest.fileCount,
  bytes: manifest.totalBytes,
  treeSha256: manifest.treeSha256,
}, null, 2)}\n`)
