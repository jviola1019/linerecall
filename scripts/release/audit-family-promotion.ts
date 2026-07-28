import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { auditFamilyPromotion } from './lib/family-promotion-audit.ts'

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

function safeOutput(root: string, requested: string): string {
  if (isAbsolute(requested)) throw new Error('Audit output must be relative to the selected root')
  const output = resolve(root, requested)
  const rel = relative(resolve(root), output)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Audit output escapes the selected root')
  }
  return output
}

const root = resolve(option('--root', '.'))
const indexPath = option('--index', 'data/generated/v3/family-promotion-index.json')
const output = safeOutput(root, option('--output', 'audit/generated/family-promotion-audit.json'))
const report = await auditFamilyPromotion({ root, indexPath })
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ output, status: report.status, findings: report.findings.length })}\n`)
if (report.status !== 'pass') process.exitCode = 1
