import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { auditArtifact } from '../../scripts/security/audit-artifact.ts'

async function auditHtml(html: string) {
  const root = await mkdtemp(join(tmpdir(), 'linerecall-artifact-audit-'))
  const path = join(root, 'linerecall.html')
  await writeFile(path, html, 'utf8')
  try {
    return await auditArtifact(path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function check(results: Awaited<ReturnType<typeof auditHtml>>, id: string) {
  const result = results.find((entry) => entry.id === id)
  assert.ok(result, `Missing ${id} audit result`)
  return result
}

test('artifact audit accepts embedded data icons and the source locale boundary', async () => {
  const results = await auditHtml(`<!doctype html>
    <html lang="en-US" dir="ltr"><head>
      <meta name="viewport" content="width=device-width">
      <link rel="icon" href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E">
      <link href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E" rel="mask-icon">
    </head><body></body></html>`)
  assert.equal(check(results, 'offline-self-contained').status, 'pass')
  assert.equal(check(results, 'document-basics').status, 'pass')
})

test('artifact audit rejects remote link resources regardless of attribute order', async () => {
  const results = await auditHtml(`<!doctype html>
    <html lang="en-US" dir="ltr"><head>
      <meta name="viewport" content="width=device-width">
      <link href="https://example.invalid/app.css" rel="stylesheet">
      <link rel="icon" href="/favicon.svg">
    </head><body></body></html>`)
  const offline = check(results, 'offline-self-contained')
  assert.equal(offline.status, 'fail')
  assert.equal(offline.findings.filter((finding) => finding.rule === 'external-link-resource').length, 2)
})

test('artifact audit requires both en-US language and left-to-right direction in preboot HTML', async () => {
  const results = await auditHtml(`<!doctype html>
    <html lang="en" dir="rtl"><head>
      <meta name="viewport" content="width=device-width">
    </head><body></body></html>`)
  const rules = check(results, 'document-basics').findings.map((finding) => finding.rule)
  assert.deepEqual(rules, ['language-missing', 'direction-missing'])
})
