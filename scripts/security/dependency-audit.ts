import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { option, workspaceRoot } from './lib/files.ts'
import { finishReport, makeReport, type CheckResult } from './lib/report.ts'

function runNpmAudit(cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    const child = spawn(process.execPath, [npmCli, 'audit', '--omit=dev', '--audit-level=high', '--json'], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('error', reject)
    child.once('close', (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

export async function auditDependencies(): Promise<CheckResult> {
  const targets = [
    { application: 'offline-client', directory: workspaceRoot },
    { application: 'hosted-client', directory: join(workspaceRoot, 'hosted') },
    { application: 'connected-server', directory: join(workspaceRoot, 'server') },
  ] as const
  const results = await Promise.all(targets.map(async (target) => ({
    ...target,
    result: await runNpmAudit(target.directory),
  })))
  const findings: Array<Record<string, unknown>> = []
  const audits: Array<Record<string, unknown>> = []
  let high = 0
  let critical = 0
  for (const target of results) {
    let parsed: {
      metadata?: { vulnerabilities?: Record<string, number> }
      error?: unknown
    }
    try {
      parsed = JSON.parse(target.result.stdout) as typeof parsed
    } catch {
      findings.push({
        application: target.application,
        rule: 'invalid-audit-response',
        exitCode: target.result.code,
        stderr: target.result.stderr.slice(0, 500),
      })
      continue
    }
    const vulnerabilities = parsed.metadata?.vulnerabilities ?? {}
    const applicationHigh = vulnerabilities.high ?? 0
    const applicationCritical = vulnerabilities.critical ?? 0
    high += applicationHigh
    critical += applicationCritical
    audits.push({
      application: target.application,
      high: applicationHigh,
      critical: applicationCritical,
      exitCode: target.result.code,
    })
    if (applicationHigh + applicationCritical > 0 || parsed.error) {
      findings.push({
        application: target.application,
        high: applicationHigh,
        critical: applicationCritical,
        auditError: parsed.error ?? null,
      })
    }
  }
  return {
    id: 'production-vulnerabilities',
    status: findings.length === 0 ? 'pass' : 'fail',
    summary: findings.length === 0
      ? 'No high or critical production dependency vulnerability reported for the offline client, hosted client, or connected server'
      : `${high} high and ${critical} critical production vulnerabilities across audited applications`,
    findings,
    metrics: {
      high,
      critical,
      applicationsAudited: audits.length,
      applicationResults: JSON.stringify(audits),
    },
  }
}

const output = option('--output', 'audit/generated/dependency-audit.json')
await finishReport(output, makeReport('dependency-audit', [await auditDependencies()]))
