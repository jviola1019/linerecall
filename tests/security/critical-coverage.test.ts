import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { CRITICAL_SERVER_PATHS, measureCriticalServerCoverage } from '../../scripts/release/lib/istanbul-critical.ts'

function file(branches: number[], functions: number[]) {
  return { b: { 0: branches }, f: Object.fromEntries(functions.map((value, index) => [String(index), value])) }
}

test('public family and tactical record validators remain inside the critical coverage gate', () => {
  assert.ok(CRITICAL_SERVER_PATHS.includes('server/src/family-training-contracts.ts'))
  assert.ok(CRITICAL_SERVER_PATHS.includes('server/src/puzzle-record.ts'))
})

test('critical server coverage requires every named module and both 90 percent thresholds', () => {
  const measured = measureCriticalServerCoverage({
    'C:\\workspace\\server\\src\\app.ts': file([1, 1, 1, 1, 1, 1, 1, 1, 1, 0], [1, 1]),
    '/workspace/server/src/contracts.ts': file([1, 1], [1, 0]),
  }, ['server/src/app.ts', 'server/src/contracts.ts', 'server/src/config.ts'])

  assert.deepEqual(measured.metrics.map(({ path }) => path), ['server/src/app.ts', 'server/src/contracts.ts'])
  assert.deepEqual(measured.findings, [
    { rule: 'critical-server-function-below-90', path: 'server/src/contracts.ts', functionPercent: 50 },
    { rule: 'critical-server-file-missing', path: 'server/src/config.ts' },
  ])
})

test('empty branch or function sets are treated as fully covered, not divided by zero', () => {
  const measured = measureCriticalServerCoverage({
    '/workspace/server/src/config.ts': file([], []),
  }, ['server/src/config.ts'])
  assert.equal(measured.findings.length, 0)
  assert.equal(measured.metrics[0]?.branchPercent, 100)
  assert.equal(measured.metrics[0]?.functionPercent, 100)
})

test('the server test command and release checker share one fresh machine-readable report', async () => {
  const packageValue = JSON.parse(await readFile('server/package.json', 'utf8')) as {
    scripts?: { 'test:coverage'?: string }
  }
  const coverageCommand = packageValue.scripts?.['test:coverage'] ?? ''
  assert.match(coverageCommand, /--reports-dir coverage\/critical/u)
  assert.match(coverageCommand, /--reporter=json/u)

  const checker = await readFile('scripts/release/check-server-critical-coverage.ts', 'utf8')
  assert.match(checker, /server\/coverage\/critical\/coverage-final\.json/u)
  assert.doesNotMatch(checker, /server\/coverage\/json\/coverage-final\.json/u)
})
