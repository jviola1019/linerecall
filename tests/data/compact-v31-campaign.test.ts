import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const campaignPath = 'scripts/run-compact-v31-campaign.ps1'

test('unattended campaign launcher parses and requires explicit execution', async () => {
  const source = await readFile(campaignPath, 'utf8')
  assert.match(source, /\[switch\]\$Execute/u)
  assert.match(source, /data:evidence-v31-preflight/u)
  assert.match(source, /data:evidence-v31-benchmark/u)
  assert.match(source, /data:evidence-v31-compare/u)
  assert.doesNotMatch(source, /\b(?:Stop-Process|Remove-Item|taskkill)\b/iu)
  const command = [
    '$errors=$null;$tokens=$null;',
    `[System.Management.Automation.Language.Parser]::ParseFile('${campaignPath.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors)|Out-Null;`,
    'if($errors.Count){$errors|ForEach-Object{$_.Message};exit 1}',
  ].join('')
  await execute('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true })
})

test('campaign launcher preserves authenticated resumability and never starts Q2', async () => {
  const source = await readFile(campaignPath, 'utf8')
  assert.match(source, /same-run checkpoint identity/u)
  assert.match(source, /Re-run the same command to resume/u)
  assert.match(source, /Q2 has not started/u)
  assert.doesNotMatch(source, /standard-q2|lichess_db_standard/iu)
})
