import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  collectFiles,
  option,
  sha256Bytes,
  workspaceRelative,
  workspaceRoot,
} from './lib/files.ts'
import { finishReport, makeReport, type CheckResult } from './lib/report.ts'

interface SecretRule {
  id: string
  pattern: RegExp
}

const secretRules: readonly SecretRule[] = [
  { id: 'private-key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u },
  { id: 'aws-access-key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u },
  { id: 'github-token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/u },
  { id: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/u },
  { id: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/u },
  { id: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}\b/u },
  { id: 'auth-config', pattern: /(?:_authToken|api[_-]?key|client[_-]?secret|password)\s*[=:]\s*['"]?[A-Za-z0-9_./+=-]{16,}/iu },
  { id: 'credential-url', pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@/iu },
]

const scanExtensions = new Set([
  '', '.cjs', '.crt', '.css', '.env', '.hcl', '.html', '.js', '.json', '.jsx', '.md', '.mjs', '.mts', '.npmrc',
  '.pem', '.ps1', '.sh', '.sql', '.tf', '.tfvars', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml',
])

function recognizedPlaceholder(value: string): boolean {
  return /(?:change[-_]?me|local-only-change-me|replace[-_]?me|example\.(?:invalid|test))/iu.test(value)
}

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length
}

export async function scanSecrets(): Promise<CheckResult> {
  const roots = [
    '.npmrc', '.env.example', '.github', 'package.json', 'package-lock.json', 'linerecall.html',
    'src', 'scripts', 'tests', 'docs', 'data/manifests', 'audit/evidence',
    'hosted', 'server', 'infra', 'build/candidate', 'build/hosted', 'dist',
  ]
  const files = await collectFiles(roots, {
    extensions: scanExtensions,
    ignoredDirectories: new Set(['.git', 'node_modules', '.cache', 'coverage', 'data/generated', 'dist']),
    // The release artifact is capped at 10 MiB and must never be silently
    // skipped if it grows beyond the current development size.
    maxBytes: 10 * 1024 * 1024,
  })
  const findings: Array<Record<string, unknown>> = []
  const scannerPath = resolve(workspaceRoot, 'scripts/security/secret-scan.ts')
  for (const file of files) {
    if (resolve(file) === scannerPath) continue
    const source = await readFile(file, 'utf8')
    for (const rule of secretRules) {
      for (const match of source.matchAll(new RegExp(rule.pattern.source, `${rule.pattern.flags}g`))) {
        const line = source.split('\n')[lineNumber(source, match.index ?? 0) - 1] ?? ''
        if (line.includes('secret-scan: allow')) continue
        if (recognizedPlaceholder(match[0])) continue
        findings.push({
          rule: rule.id,
          path: workspaceRelative(file),
          line: lineNumber(source, match.index ?? 0),
          fingerprint: sha256Bytes(`${rule.id}:${match[0]}`).slice(0, 16),
        })
      }
    }
  }
  return {
    id: 'credential-patterns',
    status: findings.length === 0 ? 'pass' : 'fail',
    summary: findings.length === 0
      ? `${files.length - 1} files contain no recognized credential pattern`
      : `${findings.length} possible credential(s) found; values are redacted`,
    findings,
    metrics: {
      filesScanned: Math.max(0, files.length - 1),
      connectedFiles: files.filter((file) => workspaceRelative(file).startsWith('server/')).length,
      hostedFiles: files.filter((file) => workspaceRelative(file).startsWith('hosted/')).length,
      infrastructureFiles: files.filter((file) => workspaceRelative(file).startsWith('infra/')).length,
      findingCount: findings.length,
    },
  }
}

const output = option('--output', 'audit/generated/secret-scan.json')
await finishReport(output, makeReport('secret-scan', [await scanSecrets()]))
