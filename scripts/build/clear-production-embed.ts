import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

// This is the only replaceable intermediate used by the production candidate
// build. Promoted manifests and resources remain immutable; the embed command
// revalidates every referenced byte before recreating this file.
const controlledOutput = resolve('build/production/embedded-snapshot.json')
if (controlledOutput !== resolve(process.cwd(), 'build/production/embedded-snapshot.json')) {
  throw new Error('Production embed cleanup resolved outside the controlled build path')
}
await rm(controlledOutput, { force: true })
