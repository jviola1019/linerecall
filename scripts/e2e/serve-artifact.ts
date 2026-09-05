import { createServer } from 'node:http'
import { basename, resolve } from 'node:path'
import { readHandleBoundRegularFile } from '../lib/handle-bound-file.ts'
import { loadHostingPolicy, responseHeadersForAlias } from '../security/lib/hosting.ts'

const root = resolve(process.env.LINERECALL_E2E_DIR ?? 'build/candidate')
const artifactName = basename(process.env.LINERECALL_E2E_ARTIFACT ?? 'linerecall.html')
const artifactPath = resolve(root, artifactName)
const portValue = Number(process.env.LINERECALL_E2E_PORT ?? '4173')

if (!Number.isSafeInteger(portValue) || portValue < 1024 || portValue > 65_535) {
  throw new Error('LINERECALL_E2E_PORT must be an integer from 1024 through 65535')
}
if (!artifactPath.startsWith(`${root}\\`) && !artifactPath.startsWith(`${root}/`)) {
  throw new Error('The E2E artifact path escapes its configured directory')
}
const artifactBytes = await readHandleBoundRegularFile(
  artifactPath,
  'E2E artifact',
  10 * 1024 * 1024,
)
const artifactHtml = artifactBytes.toString('utf8')
const hostedHeaders = responseHeadersForAlias(artifactHtml, await loadHostingPolicy())

function responseHeaders(overrides: Readonly<Record<string, string | number>> = {}): Record<string, string | number> {
  return { ...hostedHeaders, ...overrides }
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, responseHeaders({
      Allow: 'GET, HEAD',
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    }))
    response.end('Method not allowed')
    return
  }
  if (requestUrl.pathname === '/') {
    response.writeHead(302, responseHeaders({ Location: `/${artifactName}`, 'Cache-Control': 'no-store' }))
    response.end()
    return
  }
  if (requestUrl.pathname !== `/${artifactName}`) {
    response.writeHead(404, responseHeaders({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    }))
    response.end('Not found')
    return
  }
  response.writeHead(200, responseHeaders({
    'Content-Length': artifactBytes.byteLength,
  }))
  if (request.method === 'HEAD') {
    response.end()
    return
  }
  response.end(artifactBytes)
})

server.listen(portValue, '127.0.0.1', () => {
  process.stdout.write(`LineRecall E2E server listening on http://127.0.0.1:${portValue}/${artifactName}\n`)
})

const close = (): void => {
  server.close((error) => {
    if (error) {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    }
  })
}
process.once('SIGINT', close)
process.once('SIGTERM', close)
