import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { hardenHtml } from './lib/csp.ts'
import { option, sha256Bytes } from './lib/files.ts'

const input = option('--input', 'build/candidate/linerecall.html')
const output = option('--output', 'build/candidate/linerecall.html')
const source = await readFile(input, 'utf8')
const hardened = hardenHtml(source)
const temporary = `${output}.${process.pid}.tmp`
const backup = `${output}.${process.pid}.bak`
await mkdir(dirname(output), { recursive: true })
await rm(temporary, { force: true })
await rm(backup, { force: true })
await writeFile(temporary, hardened.html, { encoding: 'utf8', flag: 'wx' })
let replacedExisting = false
try {
  try {
    await rename(output, backup)
    replacedExisting = true
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  await rename(temporary, output)
  await rm(backup, { force: true })
} catch (error) {
  await rm(temporary, { force: true })
  if (replacedExisting) {
    await rm(output, { force: true })
    await rename(backup, output)
  }
  throw error
}
process.stdout.write(
  `CSP injected: ${output}\nSHA-256: ${sha256Bytes(hardened.html)}\nPolicy: ${hardened.policy}\n`,
)
