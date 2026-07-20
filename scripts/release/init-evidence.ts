import { constants } from 'node:fs'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isExecutedDirectly, option, workspaceRoot } from '../security/lib/files.ts'
import {
  EvidenceRecordSchema,
  GateConfigSchema,
  resolveWorkspaceEvidencePath,
} from './lib/evidence-integrity.ts'

export interface EvidenceInitResult {
  created: string[]
  preserved: string[]
}

export async function initializeEvidence(
  root = workspaceRoot,
  configPath = 'config/release-gates.json',
): Promise<EvidenceInitResult> {
  const configAbsolute = resolveWorkspaceEvidencePath(root, configPath)
  const config = GateConfigSchema.parse(JSON.parse(await readFile(configAbsolute, 'utf8')) as unknown)
  const result: EvidenceInitResult = { created: [], preserved: [] }

  for (const requirement of config.evidence) {
    const templatePath = resolveWorkspaceEvidencePath(root, requirement.template)
    const destinationPath = resolveWorkspaceEvidencePath(root, requirement.path)
    const template = EvidenceRecordSchema.parse(JSON.parse(await readFile(templatePath, 'utf8')) as unknown)
    if (template.id !== requirement.id) {
      throw new Error(`Evidence template ID mismatch for ${requirement.template}: ${template.id}`)
    }
    if (template.status !== 'not_run') {
      throw new Error(`Evidence template must remain not_run: ${requirement.template}`)
    }
    await mkdir(dirname(destinationPath), { recursive: true })
    try {
      await copyFile(templatePath, destinationPath, constants.COPYFILE_EXCL)
      result.created.push(requirement.path)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      result.preserved.push(requirement.path)
    }
  }
  return result
}

if (isExecutedDirectly(import.meta.url)) {
  const result = await initializeEvidence(workspaceRoot, option('--config', 'config/release-gates.json'))
  process.stdout.write(`${JSON.stringify({
    mode: 'non-overwriting',
    ...result,
  }, null, 2)}\n`)
}
