import { open, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { ImmutableJsonReceiptV1Schema, resolveSafeReceiptPath } from './immutable-json-receipt.ts'

const MAX_HANDOFF_INPUT_BYTES = 2 * 1024 * 1024

export function commandOption(name: string, fallback: string): string {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? fallback : process.argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`Missing option ${name}`)
  return value
}

export async function readHandoffBuildInput(root: string, relativePath: string): Promise<unknown> {
  ImmutableJsonReceiptV1Schema.shape.path.parse(relativePath)
  const rootReal = await realpath(resolve(root))
  const path = await resolveSafeReceiptPath(rootReal, relativePath)
  const handle = await open(path, 'r')
  try {
    const details = await handle.stat()
    if (details.size < 1 || details.size > MAX_HANDOFF_INPUT_BYTES) {
      throw new Error(`Handoff build input must be 1-${MAX_HANDOFF_INPUT_BYTES} bytes`)
    }
    const bytes = new Uint8Array(details.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== details.size) throw new Error('Handoff build input changed while it was read')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, details.size))
    if (text.includes('\0')) throw new Error('Handoff build input contains a NUL character')
    return JSON.parse(text) as unknown
  } finally {
    await handle.close()
  }
}
