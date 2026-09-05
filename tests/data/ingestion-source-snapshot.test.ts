import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  createIngestionSourceSnapshot,
  INGESTION_SOURCE_ENTRYPOINTS,
} from '../../scripts/data/ingestion-source-snapshot.ts'

async function copySnapshotFiles(root: string): Promise<void> {
  const source = await createIngestionSourceSnapshot()
  for (const file of source.files) {
    const destination = join(root, file.path)
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, await readFile(file.path))
  }
}

test('ingestion identity excludes approval/docs/UI bytes but binds parser and lockfile changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-ingestion-snapshot-'))
  try {
    await copySnapshotFiles(root)
    const baseline = await createIngestionSourceSnapshot(root)
    assert.deepEqual(baseline.entrypoints, INGESTION_SOURCE_ENTRYPOINTS)
    assert.ok(baseline.files.every(({ path }) => !path.startsWith('docs/')))
    assert.ok(baseline.files.every(({ path }) => !path.startsWith('src/app/')))
    assert.ok(baseline.files.some(({ path }) => path === 'scripts/data/ingestion-source-snapshot.ts'))
    assert.ok(baseline.files.every(({ path }) => !path.startsWith('data/manifests/')))

    await mkdir(join(root, 'docs'), { recursive: true })
    await mkdir(join(root, 'src/components'), { recursive: true })
    await mkdir(join(root, 'data/manifests'), { recursive: true })
    await writeFile(join(root, 'docs/approval-notes.md'), 'reviewed control receipt\n')
    await writeFile(join(root, 'src/components/changed-ui.tsx'), 'export const changedUi = true\n')
    await writeFile(join(root, 'data/manifests/approved-control.json'), '{"decision":"approved"}\n')
    assert.equal((await createIngestionSourceSnapshot(root)).treeSha256, baseline.treeSha256)

    const parser = join(root, 'scripts/data/broadcast-pgn.ts')
    const parserBaseline = await readFile(parser)
    await writeFile(parser, `${parserBaseline.toString('utf8')}\n// parser change\n`)
    assert.notEqual((await createIngestionSourceSnapshot(root)).treeSha256, baseline.treeSha256)

    await writeFile(parser, `${parserBaseline.toString('utf8')}\nvoid import(dynamicSpecifier)\n`)
    await assert.rejects(createIngestionSourceSnapshot(root), /non-literal module reference/iu)
    await writeFile(parser, `${parserBaseline.toString('utf8')}\nvoid new URL(dynamicSpecifier, import.meta.url)\n`)
    await assert.rejects(createIngestionSourceSnapshot(root), /non-literal worker\/module URL/iu)
    await writeFile(parser, parserBaseline)

    const worker = join(root, 'scripts/data/snapshot-worker-fixture.ts')
    const asset = join(root, 'scripts/data/snapshot-fixture.json')
    await writeFile(worker, "export const value = 1\nexport { default as fixture } from './snapshot-fixture.json' with { type: 'json' }\n")
    await writeFile(asset, '{"fixture":true}\n')
    await writeFile(parser, `${parserBaseline.toString('utf8')}\nfunction nested() { return { worker: new URL('./snapshot-worker-fixture.ts', import.meta.url) } }\n`)
    const workerSnapshot = await createIngestionSourceSnapshot(root)
    assert.ok(workerSnapshot.files.some(({ path }) => path.endsWith('snapshot-worker-fixture.ts')))
    assert.ok(workerSnapshot.files.some(({ path }) => path.endsWith('snapshot-fixture.json')))
    await writeFile(worker, 'export const value = 2\n')
    assert.notEqual((await createIngestionSourceSnapshot(root)).treeSha256, workerSnapshot.treeSha256)
    for (const unsafe of ["function nested() { return import(dynamicSpecifier) }", 'require(dynamicSpecifier)']) {
      await writeFile(parser, `${parserBaseline.toString('utf8')}\n${unsafe}\n`)
      await assert.rejects(createIngestionSourceSnapshot(root), /non-literal module reference/iu)
    }
    await writeFile(parser, `${parserBaseline.toString('utf8')}\nimport 'file:///outside.js'\n`)
    await assert.rejects(createIngestionSourceSnapshot(root), /unsupported module reference/iu)
    await writeFile(parser, parserBaseline)

    const linked = join(root, 'scripts/data/linked-sources')
    await symlink(join(root, 'scripts/security'), linked, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(parser, `${parserBaseline.toString('utf8')}\nexport * from './linked-sources/lib/files.ts'\n`)
    await assert.rejects(createIngestionSourceSnapshot(root), /symbolic|linked/iu)
    await writeFile(parser, parserBaseline)

    const schema = join(root, 'scripts/data/compact-v31-contracts.ts')
    const schemaBaseline = await readFile(schema)
    await writeFile(schema, `${schemaBaseline.toString('utf8')}\n// runtime schema change\n`)
    assert.notEqual((await createIngestionSourceSnapshot(root)).treeSha256, baseline.treeSha256)
    await writeFile(schema, schemaBaseline)

    const lockfile = join(root, 'package-lock.json')
    const lockfileBaseline = await readFile(lockfile)
    await writeFile(lockfile, `${lockfileBaseline.toString('utf8')}\n`)
    assert.notEqual((await createIngestionSourceSnapshot(root)).treeSha256, baseline.treeSha256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
