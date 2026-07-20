import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { workspaceRoot } from '../security/lib/files.ts'

const output = resolve(workspaceRoot, 'coverage/domain.lcov')
await mkdir(resolve(workspaceRoot, 'coverage'), { recursive: true })
const tsxCli = resolve(workspaceRoot, 'node_modules/tsx/dist/cli.mjs')
const args = [
  tsxCli,
  '--test',
  '--experimental-test-coverage',
  '--test-reporter=lcov',
  `--test-reporter-destination=${output}`,
  'tests/domain/**/*.test.ts',
]

const code = await new Promise<number>((resolveCode, reject) => {
  const child = spawn(process.execPath, args, {
    cwd: workspaceRoot,
    windowsHide: true,
    stdio: 'inherit',
  })
  child.once('error', reject)
  child.once('close', (exitCode) => resolveCode(exitCode ?? 1))
})
if (code !== 0) {
  process.stderr.write(`Critical-domain coverage tests failed with exit code ${code}.\n`)
  process.exitCode = code
} else {
  process.stdout.write(`Critical-domain LCOV written to ${output}.\n`)
}
