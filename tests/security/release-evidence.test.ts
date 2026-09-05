import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sha256File } from '../../scripts/security/lib/files.ts'
import {
  clearDefaultReleaseOutputs,
  contentAddressEvidenceFile,
  EvidenceRecordSchema,
  GateConfigSchema,
  readEvidence,
  readGateConfigAfterCleanup,
} from '../../scripts/release/lib/evidence-integrity.ts'
import {
  CONNECTED_SOURCE_ROOTS,
  createSourceSnapshot,
  validateSourceSnapshot,
} from '../../scripts/release/lib/source-snapshot.ts'
import { initializeEvidence } from '../../scripts/release/init-evidence.ts'

const hash = 'a'.repeat(64)
const defaultReceiptPath = `audit/evidence/receipts/${hash}/browser.json`

function config(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    candidate: 'build/candidate/linerecall.html',
    artifact: 'dist/linerecall.html',
    marker: 'dist/SHIPPABLE.json',
    report: 'audit/generated/release-gate.json',
    automated: [{ id: 'typecheck', command: 'npm', args: ['run', 'typecheck'] }],
    evidence: [{
      id: 'browser-e2e',
      path: 'audit/evidence/browser-e2e.json',
      template: 'audit/templates/evidence/browser-e2e.json',
    }],
    releaseBindings: {
      sourceSnapshot: 'audit/generated/connected-source-snapshot.json',
      productionReadiness: 'data/generated/v3/production-data-readiness.json',
      appSnapshotManifest: 'data/generated/app-snapshot/manifest.json',
    },
    signing: {
      evidenceId: 'browser-e2e',
      trustedKeys: 'config/release-signing-keys.json',
      attestationSourcePath: 'audit/generated/release-signing-attestation.json',
    },
    limitations: [],
    ...overrides,
  }
}

function completedEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    id: 'browser-e2e',
    status: 'pass',
    completedAt: '2026-07-13T18:00:00.000Z',
    reviewer: 'Release reviewer',
    artifactSha256: hash,
    summary: 'Exact candidate passed.',
    evidence: [{ path: defaultReceiptPath, sha256: hash }],
    limitations: [],
    ...overrides,
  }
}

test('evidence schema enforces completed and not-run field consistency', () => {
  assert.doesNotThrow(() => EvidenceRecordSchema.parse(completedEvidence()))
  assert.throws(() => EvidenceRecordSchema.parse(completedEvidence({ completedAt: null })))
  assert.throws(() => EvidenceRecordSchema.parse(completedEvidence({ status: 'fail', evidence: [] })))
  assert.throws(() => EvidenceRecordSchema.parse(completedEvidence({
    evidence: [{ path: `audit/evidence/receipts/${'b'.repeat(64)}/report.json`, sha256: hash }],
  })))
  assert.throws(() => EvidenceRecordSchema.parse(completedEvidence({
    status: 'not_run',
    completedAt: null,
    reviewer: 'Reviewer must be absent',
    artifactSha256: null,
    evidence: [],
  })))
  assert.doesNotThrow(() => EvidenceRecordSchema.parse({
    schemaVersion: 2,
    id: 'accessibility-manual',
    status: 'not_run',
    completedAt: null,
    reviewer: null,
    artifactSha256: null,
    summary: 'Not run.',
    evidence: [],
    limitations: ['Hard blocker.'],
  }))
})

test('release configuration rejects duplicate IDs within and across gate groups', () => {
  assert.throws(() => GateConfigSchema.parse(config({
    automated: [
      { id: 'same', command: 'npm', args: [] },
      { id: 'same', command: 'npm', args: [] },
    ],
  })), /Duplicate release gate ID same/u)
  assert.throws(() => GateConfigSchema.parse(config({
    automated: [{ id: 'same', command: 'npm', args: [] }],
    evidence: [{ id: 'same', path: 'audit/evidence/same.json', template: 'audit/templates/evidence/same.json' }],
  })), /Duplicate release gate ID same/u)
  assert.throws(() => GateConfigSchema.parse(config({
    evidence: [
      { id: 'one', path: 'audit/evidence/shared.json', template: 'audit/templates/evidence/one.json' },
      { id: 'two', path: 'audit/evidence/shared.json', template: 'audit/templates/evidence/two.json' },
    ],
    signing: {
      evidenceId: 'one',
      trustedKeys: 'config/release-signing-keys.json',
      attestationSourcePath: 'audit/generated/release-signing-attestation.json',
    },
  })), /Duplicate evidence destination/u)
  assert.throws(() => GateConfigSchema.parse(config({
    evidence: [{
      id: 'browser-e2e',
      path: 'audit/evidence/browser-e2e.json',
      template: 'audit/evidence/browser-e2e.json',
    }],
  })), /must be different paths/u)
})

test('evidence initialization copies strict not-run templates and never overwrites a destination', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-evidence-init-'))
  try {
    await mkdir(join(root, 'config'), { recursive: true })
    await mkdir(join(root, 'audit/templates/evidence'), { recursive: true })
    const releaseConfig = config()
    await writeFile(join(root, 'config/release-gates.json'), `${JSON.stringify(releaseConfig)}\n`, 'utf8')
    const template = {
      schemaVersion: 2,
      id: 'browser-e2e',
      status: 'not_run',
      completedAt: null,
      reviewer: null,
      artifactSha256: null,
      summary: 'Not run.',
      evidence: [],
      limitations: ['Hard blocker.'],
    }
    await writeFile(join(root, 'audit/templates/evidence/browser-e2e.json'), `${JSON.stringify(template)}\n`, 'utf8')

    const first = await initializeEvidence(root)
    assert.deepEqual(first.created, ['audit/evidence/browser-e2e.json'])
    const destination = join(root, 'audit/evidence/browser-e2e.json')
    await writeFile(destination, '{"preserve":true}\n', 'utf8')
    const second = await initializeEvidence(root)
    assert.deepEqual(second.preserved, ['audit/evidence/browser-e2e.json'])
    assert.equal(await readFile(destination, 'utf8'), '{"preserve":true}\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('tracked release configuration declares strict not-run templates for every manual gate', async () => {
  const root = join(import.meta.dirname, '../..')
  const releaseConfig = GateConfigSchema.parse(JSON.parse(await readFile(
    join(root, 'config/release-gates.json'),
    'utf8',
  )) as unknown)
  const requiredHumanGates = new Set([
    'accessibility-manual',
    'editorial-human',
    'localization-human',
    'visual-human',
    'legal-trademark',
    'security-manual',
    'connected-staging',
    'release-signing',
  ])
  const configuredIds = new Set(releaseConfig.evidence.map(({ id }) => id))
  for (const id of requiredHumanGates) assert.ok(configuredIds.has(id), `missing human gate ${id}`)

  for (const requirement of releaseConfig.evidence) {
    const template = EvidenceRecordSchema.parse(JSON.parse(await readFile(
      join(root, ...requirement.template.split('/')),
      'utf8',
    )) as unknown)
    assert.equal(template.id, requirement.id)
    assert.equal(template.status, 'not_run')
    assert.equal(template.completedAt, null)
    assert.equal(template.reviewer, null)
    assert.equal(template.artifactSha256, null)
    assert.deepEqual(template.evidence, [])
  }
})

test('GitHub workflows build, audit, and scan connected code but cannot deploy Pages', async () => {
  const root = join(import.meta.dirname, '../..')
  const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8')
  for (const command of [
    'npm run security:source-snapshot',
    'npm run hosted:build',
    'npm run hosted:audit',
    'npm run server:build',
    'npm run server:audit',
  ]) assert.ok(ci.includes(command), `CI is missing ${command}`)

  const pages = await readFile(join(root, '.github/workflows/pages.yml'), 'utf8')
  assert.doesNotMatch(pages, /actions\/deploy-pages|actions\/configure-pages|actions\/upload-pages-artifact/u)
  assert.doesNotMatch(pages, /pages:\s*write|id-token:\s*write/u)
  assert.match(pages, /actions\/upload-artifact@/u)
  assert.match(pages, /Review bundle only/u)

  const codeql = await readFile(join(root, '.github/workflows/codeql.yml'), 'utf8')
  assert.match(codeql, /contents:\s*read/u)
  assert.match(codeql, /security-events:\s*write/u)
  assert.match(codeql, /github\/codeql-action\/init@[a-f0-9]{40}/u)
  assert.match(codeql, /github\/codeql-action\/analyze@[a-f0-9]{40}/u)
  assert.match(codeql, /languages:\s*javascript-typescript/u)
  assert.match(codeql, /queries:\s*security-extended/u)
  assert.doesNotMatch(codeql, /actions\/deploy-pages|pages:\s*write|id-token:\s*write/u)

  for (const [name, workflow] of [['ci', ci], ['pages', pages], ['codeql', codeql]] as const) {
    const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]!)
    assert.ok(actions.length > 0, `${name} workflow does not invoke a reviewed action`)
    for (const action of actions) {
      if (action.startsWith('./')) continue
      assert.match(action, /@[a-f0-9]{40}$/u, `${name} workflow action is not pinned: ${action}`)
    }
  }
})

test('completed evidence is invalidated when a referenced report is mutated', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-evidence-'))
  try {
    await mkdir(join(root, 'reports'), { recursive: true })
    await mkdir(join(root, 'audit/evidence'), { recursive: true })
    const reportPath = join(root, 'reports/browser.json')
    await writeFile(reportPath, '{"status":"pass"}\n', 'utf8')
    const receipt = await contentAddressEvidenceFile('reports/browser.json', root, true)
    const evidencePath = join(root, 'audit/evidence/browser-e2e.json')
    await writeFile(evidencePath, `${JSON.stringify(completedEvidence({
      evidence: [receipt],
    }))}\n`, 'utf8')

    assert.equal((await readEvidence('browser-e2e', 'audit/evidence/browser-e2e.json', hash, root)).status, 'pass')
    await writeFile(join(root, receipt.path), '{"status":"fail"}\n', 'utf8')
    const mutated = await readEvidence('browser-e2e', 'audit/evidence/browser-e2e.json', hash, root)
    assert.equal(mutated.status, 'fail')
    assert.match(mutated.summary, /digest mismatch/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('completed manual evidence must preserve every immutable template requirement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-evidence-template-'))
  try {
    await mkdir(join(root, 'audit/templates/evidence'), { recursive: true })
    await mkdir(join(root, 'audit/evidence'), { recursive: true })
    await mkdir(join(root, 'reports'), { recursive: true })
    const templatePath = 'audit/templates/evidence/accessibility-manual.json'
    const evidencePath = 'audit/evidence/accessibility-manual.json'
    const reportPath = 'reports/accessibility.json'
    await writeFile(join(root, reportPath), '{"status":"pass"}\n', 'utf8')
    const reportReceipt = await contentAddressEvidenceFile(reportPath, root, true)
    const requiredEnvironments = ['NVDA with Chrome', 'VoiceOver on iOS', 'TalkBack on Android']
    const requiredChecks = ['WCAG 2.2 AA manual matrix']
    await writeFile(join(root, templatePath), `${JSON.stringify({
      schemaVersion: 2,
      id: 'accessibility-manual',
      status: 'not_run',
      completedAt: null,
      reviewer: null,
      artifactSha256: null,
      summary: 'Not run.',
      evidence: [],
      limitations: ['Manual review is required.'],
      requiredEnvironments,
      requiredChecks,
    })}\n`, 'utf8')
    const record = completedEvidence({
      id: 'accessibility-manual',
      evidence: [reportReceipt],
      requiredEnvironments,
      requiredChecks,
      requirementResults: [...requiredEnvironments, ...requiredChecks].map((requirement) => ({
        requirement,
        status: 'pass',
        evidencePaths: [reportReceipt.path],
      })),
    })
    await writeFile(join(root, evidencePath), `${JSON.stringify(record)}\n`, 'utf8')
    assert.equal((await readEvidence(
      'accessibility-manual', evidencePath, hash, root, undefined, undefined, templatePath,
    )).status, 'pass')

    const { requiredEnvironments: _removed, ...withoutEnvironments } = record
    await writeFile(join(root, evidencePath), `${JSON.stringify(withoutEnvironments)}\n`, 'utf8')
    const omitted = await readEvidence(
      'accessibility-manual', evidencePath, hash, root, undefined, undefined, templatePath,
    )
    assert.equal(omitted.status, 'fail')
    assert.match(omitted.summary, /requiredEnvironments checklist/u)

    const { requirementResults: _results, ...withoutResults } = record
    await writeFile(join(root, evidencePath), `${JSON.stringify(withoutResults)}\n`, 'utf8')
    const unmapped = await readEvidence(
      'accessibility-manual', evidencePath, hash, root, undefined, undefined, templatePath,
    )
    assert.equal(unmapped.status, 'fail')
    assert.match(unmapped.summary, /map every template requirement/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('connected source snapshot is deterministic and detects source mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-source-snapshot-'))
  try {
    await mkdir(join(root, 'server/src'), { recursive: true })
    await writeFile(join(root, 'server/src/app.ts'), 'export const answer = 42\n', 'utf8')
    await writeFile(join(root, 'package-lock.json'), '{"lockfileVersion":3}\n', 'utf8')
    const roots = ['server/src', 'package-lock.json']
    const first = await createSourceSnapshot(root, roots)
    const second = await createSourceSnapshot(root, roots)
    assert.deepEqual(second, first)

    const manifestPath = join(root, 'source-snapshot.json')
    await writeFile(manifestPath, `${JSON.stringify(first, null, 2)}\n`, 'utf8')
    assert.equal((await validateSourceSnapshot(manifestPath, root, roots)).treeSha256, first.treeSha256)

    await writeFile(join(root, 'server/src/app.ts'), 'export const answer = 43\n', 'utf8')
    await assert.rejects(() => validateSourceSnapshot(manifestPath, root, roots), /stale/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('completed connected evidence is bound to the exact current source tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-source-bound-evidence-'))
  const directoryRoots = new Set([
    '.github/workflows', 'src', 'scripts', 'tests', 'data/manifests', 'docs',
    'licenses', 'config',
    'server/src', 'server/migrations', 'server/tests', 'server/docs',
    'hosted/src', 'hosted/tests', 'infra', 'audit/schemas', 'audit/templates',
  ])
  try {
    for (const selectedRoot of CONNECTED_SOURCE_ROOTS) {
      const absolute = join(root, ...selectedRoot.split('/'))
      if (directoryRoots.has(selectedRoot)) {
        await mkdir(absolute, { recursive: true })
        await writeFile(join(absolute, 'snapshot-fixture.txt'), `${selectedRoot}\n`, 'utf8')
      } else {
        await mkdir(join(absolute, '..'), { recursive: true })
        await writeFile(absolute, `${selectedRoot}\n`, 'utf8')
      }
    }
    await mkdir(join(root, 'audit/generated'), { recursive: true })
    await mkdir(join(root, 'audit/evidence'), { recursive: true })
    await mkdir(join(root, 'reports'), { recursive: true })

    const snapshot = await createSourceSnapshot(root)
    const snapshotPath = join(root, 'audit/generated/connected-source-snapshot.json')
    await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    const reportPath = join(root, 'reports/security.json')
    await writeFile(reportPath, '{"status":"pass"}\n', 'utf8')
    const reportReceipt = await contentAddressEvidenceFile('reports/security.json', root, true)
    const evidencePath = join(root, 'audit/evidence/security-review.json')
    await writeFile(evidencePath, `${JSON.stringify(completedEvidence({
      id: 'security-manual',
      sourceSnapshotSha256: snapshot.treeSha256,
      evidence: [reportReceipt],
    }))}\n`, 'utf8')

    assert.equal((await readEvidence(
      'security-manual',
      'audit/evidence/security-review.json',
      hash,
      root,
      'audit/generated/connected-source-snapshot.json',
    )).status, 'pass')

    await writeFile(join(root, 'server/src/snapshot-fixture.txt'), 'mutated\n', 'utf8')
    const stale = await readEvidence(
      'security-manual',
      'audit/evidence/security-review.json',
      hash,
      root,
      'audit/generated/connected-source-snapshot.json',
    )
    assert.equal(stale.status, 'fail')
    assert.match(stale.summary, /Source snapshot is invalid/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('receipt regeneration snapshots mutable reports under their content digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-evidence-archive-'))
  try {
    await mkdir(join(root, 'reports'), { recursive: true })
    const reportPath = join(root, 'reports/performance.json')
    await writeFile(reportPath, '{"result":"pass"}\n', 'utf8')
    const receipt = await contentAddressEvidenceFile('reports/performance.json', root, true)
    assert.match(receipt.path, new RegExp(`^audit/evidence/receipts/${receipt.sha256}/performance\\.json$`, 'u'))
    assert.equal(receipt.sourcePath, 'reports/performance.json')
    assert.equal(await sha256File(join(root, ...receipt.path.split('/'))), receipt.sha256)

    await writeFile(reportPath, '{"result":"fail"}\n', 'utf8')
    assert.equal(await sha256File(join(root, ...receipt.path.split('/'))), receipt.sha256)
    assert.notEqual(await sha256File(reportPath), receipt.sha256)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('malformed configuration cannot leave a stale aggregate report or release output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-release-cleanup-'))
  try {
    await mkdir(join(root, 'audit/generated'), { recursive: true })
    await mkdir(join(root, 'dist'), { recursive: true })
    const reportPath = join(root, 'audit/generated/release-gate.json')
    const artifactPath = join(root, 'dist/linerecall.html')
    const markerPath = join(root, 'dist/SHIPPABLE.json')
    const configPath = join(root, 'malformed.json')
    await writeFile(reportPath, '{"shippable":true}\n', 'utf8')
    await writeFile(artifactPath, 'stale artifact', 'utf8')
    await writeFile(markerPath, '{"shippable":true}\n', 'utf8')
    await writeFile(configPath, '{not-json', 'utf8')

    await assert.rejects(() => readGateConfigAfterCleanup(configPath, root))
    await assert.rejects(() => readFile(reportPath, 'utf8'))
    await assert.rejects(() => readFile(artifactPath, 'utf8'))
    await assert.rejects(() => readFile(markerPath, 'utf8'))

    // Cleanup is idempotent, including after a failed parse.
    await clearDefaultReleaseOutputs(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
