import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildCompactV3FamilyHandoff } from '../../scripts/data/build-compact-v3-family-handoff.ts'

async function absent(path: string): Promise<boolean> {
  try {
    await access(path)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
  }
}

test('compact family handoff fails closed before writing when either exact corpus is incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-family-handoff-'))
  const workDirectory = join(root, 'corpus')
  const plansDirectory = join(root, 'plans')
  const manifests = join(root, 'manifests')
  await Promise.all([mkdir(workDirectory), mkdir(plansDirectory), mkdir(manifests)])
  const broadcastManifestPath = join(manifests, 'broadcasts.source.json')
  const q2ManifestPath = join(manifests, 'standard.source.json')
  await Promise.all([
    writeFile(broadcastManifestPath, await readFile('data/manifests/broadcasts.source.json')),
    writeFile(q2ManifestPath, await readFile('data/manifests/lichess-standard-q2-2026.source.json')),
  ])
  await assert.rejects(
    buildCompactV3FamilyHandoff({
      root,
      workDirectory,
      plansDirectory,
      broadcastManifestPath,
      q2ManifestPath,
      outputPath: 'handoff/family.json',
      releaseId: 'synthetic-incomplete-handoff',
    }),
    /foundation is incomplete/u,
  )
  assert.equal(await absent(join(root, 'handoff/family.json')), true)
})
