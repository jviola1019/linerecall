import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import {
  fileExists,
  option,
  sha256File,
  workspaceRoot,
  writeJsonAtomic,
} from '../security/lib/files.ts'
import {
  EvidenceRecordSchema,
  EvidenceReferenceSchema,
  GateConfigSchema,
  contentAddressEvidenceFile,
  resolveWorkspaceEvidencePath,
} from './lib/evidence-integrity.ts'

const MigratableEvidenceSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  id: z.string().min(1),
  status: z.enum(['pass', 'fail', 'not_run']),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  reviewer: z.string().min(1).nullable(),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  summary: z.string().min(1),
  evidence: z.array(z.union([z.string().min(1), EvidenceReferenceSchema])),
  limitations: z.array(z.string().min(1)),
}).passthrough()

const configPath = option('--config', 'config/release-gates.json')
const write = process.argv.includes('--write')
const config = GateConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')) as unknown)
const candidatePath = resolve(workspaceRoot, config.candidate)
if (!(await fileExists(candidatePath))) throw new Error(`Candidate is missing: ${config.candidate}`)
const candidateSha256 = await sha256File(candidatePath)

const updates: Array<{ path: string; record: z.infer<typeof EvidenceRecordSchema>; changed: boolean }> = []
for (const requirement of config.evidence) {
  const evidencePath = resolveWorkspaceEvidencePath(workspaceRoot, requirement.path)
  const currentText = await readFile(evidencePath, 'utf8')
  const current = MigratableEvidenceSchema.parse(JSON.parse(currentText) as unknown)
  if (current.id !== requirement.id) {
    throw new Error(`Evidence ID mismatch for ${requirement.path}: ${current.id}`)
  }
  if (current.status !== 'not_run' && current.artifactSha256 !== candidateSha256) {
    throw new Error(
      `Refusing to refresh stale ${current.status} evidence ${requirement.id}; update its exact-candidate review first`,
    )
  }

  const receipts = []
  for (const reference of current.evidence) {
    const path = typeof reference === 'string' ? reference : (reference.sourcePath ?? reference.path)
    receipts.push(await contentAddressEvidenceFile(path, workspaceRoot, write))
  }
  const record = EvidenceRecordSchema.parse({
    ...current,
    schemaVersion: 2,
    evidence: receipts,
  })
  const nextText = `${JSON.stringify(record, null, 2)}\n`
  updates.push({ path: evidencePath, record, changed: nextText !== currentText })
}

if (write) {
  for (const update of updates) await writeJsonAtomic(update.path, update.record)
}

process.stdout.write(`${JSON.stringify({
  mode: write ? 'write' : 'dry-run',
  candidateSha256,
  records: updates.map((update) => ({
    path: update.path.slice(workspaceRoot.length + 1).replaceAll('\\', '/'),
    status: update.record.status,
    references: update.record.evidence.length,
    changed: update.changed,
  })),
}, null, 2)}\n`)

if (!write && updates.some((update) => update.changed)) {
  process.stderr.write('Evidence receipts need regeneration; rerun with --write only after the exact reports are finalized.\n')
  process.exitCode = 1
}
