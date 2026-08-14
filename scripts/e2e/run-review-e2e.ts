import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'

const workspace = process.cwd()
const viteCli = resolve(workspace, 'node_modules/vite/bin/vite.js')
const playwrightCli = resolve(workspace, 'node_modules/@playwright/test/cli.js')
const portText = process.env.LINERECALL_REVIEW_E2E_PORT ?? '4187'
const port = Number(portText)
if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error('LINERECALL_REVIEW_E2E_PORT must be an integer from 1024 through 65535')
}
const healthUrl = `http://127.0.0.1:${port}/index.html`

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: workspace,
      env,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', rejectRun)
    child.once('exit', (code, signal) => {
      if (signal) rejectRun(new Error(`${command} ended with signal ${signal}`))
      else resolveRun(code ?? 1)
    })
  })
}

async function isReady(): Promise<boolean> {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) })
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}

async function waitForServer(server: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Review server exited with code ${server.exitCode}`)
    if (await isReady()) return
    await new Promise((resolveWait) => setTimeout(resolveWait, 150))
  }
  throw new Error(`Review server did not become ready at ${healthUrl}`)
}

async function stopServer(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null) return
  server.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolveExit) => server.once('exit', () => resolveExit())),
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 3_000)),
  ])
  if (server.exitCode === null) server.kill('SIGKILL')
}

const buildCode = await run(process.execPath, [
  viteCli,
  'build',
  '--config',
  'vite.review-harness.config.ts',
])
if (buildCode !== 0) process.exit(buildCode)
if (await isReady()) throw new Error(`Review port ${port} is already in use`)

const server = spawn(process.execPath, [
  viteCli,
  'preview',
  '--config',
  'vite.review-harness.config.ts',
  '--host',
  '127.0.0.1',
  '--port',
  portText,
  '--strictPort',
], {
  cwd: workspace,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})
server.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk))
server.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))

let exitCode = 1
try {
  await waitForServer(server)
  exitCode = await run(process.execPath, [
    playwrightCli,
    'test',
    '--config',
    'playwright.review.config.ts',
    ...process.argv.slice(2),
  ], {
    ...process.env,
    LINERECALL_REVIEW_EXTERNAL_SERVER: '1',
  })
} finally {
  await stopServer(server)
}
process.exit(exitCode)
