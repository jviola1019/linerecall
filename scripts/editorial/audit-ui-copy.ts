import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parse } from '@babel/parser'
import * as t from '@babel/types'
import { z } from 'zod'
import {
  collectFiles,
  isExecutedDirectly,
  option,
  workspaceRelative,
  workspaceRoot,
  writeJsonAtomic,
} from '../security/lib/files.ts'

const PolicySchema = z.object({
  schemaVersion: z.literal(1),
  maximumHeadingCharacters: z.number().int().min(20).max(120),
  maximumControlCharacters: z.number().int().min(20).max(160),
  maximumBodyCharacters: z.number().int().min(80).max(500),
  maximumBodyWords: z.number().int().min(15).max(100),
  duplicateMinimumCharacters: z.number().int().min(20).max(100),
  duplicateMaximumOccurrences: z.number().int().min(1).max(5),
  prohibitedPatterns: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    pattern: z.string().min(1).max(200),
  }).strict()).min(1),
  learnerWorkflow: z.object({
    pathPrefixes: z.array(z.string().min(1).max(200)).min(1),
    prohibitedPatterns: z.array(z.object({
      id: z.string().regex(/^[a-z0-9-]+$/u),
      pattern: z.string().min(1).max(200),
    }).strict()).min(1),
  }).strict().optional(),
}).strict()

export type CopyKind = 'heading' | 'control' | 'body'
export interface CopyEntry {
  path: string
  line: number
  kind: CopyKind
  text: string
}

export interface CopyFinding {
  rule: string
  path: string
  line: number
  detail: string
}

const visibleAttributes = new Set(['aria-label', 'placeholder', 'title'])
const copyPropertyNames = new Set(['description', 'emptyLabel', 'label', 'message', 'summary', 'title'])
const visibleCallNames = new Set(['announce', 'onAnnouncement'])
const mojibakePattern = /(?:[ÃÂ�]|â€)/u

function normalizedText(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function elementKind(ancestors: readonly t.Node[]): CopyKind {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const current = ancestors[index]
    if (!current || !t.isJSXElement(current) || !t.isJSXIdentifier(current.openingElement.name)) continue
    const tag = current.openingElement.name.name.toLowerCase()
    if (/^h[1-4]$/u.test(tag)) return 'heading'
    if (tag === 'button' || tag === 'label' || tag === 'option' || tag === 'summary') return 'control'
    return 'body'
  }
  return 'body'
}

function sourceLine(node: t.Node): number {
  return node.loc?.start.line ?? 1
}

function calledFunctionName(node: t.CallExpression | t.OptionalCallExpression): string | null {
  const { callee } = node
  if (t.isIdentifier(callee)) return callee.name
  if ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee)) && t.isIdentifier(callee.property)) {
    return callee.property.name
  }
  return null
}

function collectRenderedExpressionCopy(
  node: t.Node | null | undefined,
  add: (node: t.Node, value: string) => void,
): void {
  if (!node) return
  if (t.isStringLiteral(node)) {
    add(node, node.value)
    return
  }
  if (t.isTemplateLiteral(node)) {
    for (const quasi of node.quasis) add(quasi, quasi.value.cooked ?? quasi.value.raw)
    return
  }
  if (t.isConditionalExpression(node)) {
    collectRenderedExpressionCopy(node.consequent, add)
    collectRenderedExpressionCopy(node.alternate, add)
    return
  }
  if (t.isLogicalExpression(node)) {
    if (node.operator !== '&&') collectRenderedExpressionCopy(node.left, add)
    collectRenderedExpressionCopy(node.right, add)
    return
  }
  if (t.isSequenceExpression(node)) {
    collectRenderedExpressionCopy(node.expressions.at(-1), add)
    return
  }
  if (t.isArrayExpression(node)) {
    for (const element of node.elements) {
      if (element && !t.isSpreadElement(element)) collectRenderedExpressionCopy(element, add)
    }
    return
  }
  if (
    t.isParenthesizedExpression(node)
    || t.isTSAsExpression(node)
    || t.isTSTypeAssertion(node)
    || t.isTSNonNullExpression(node)
  ) {
    collectRenderedExpressionCopy(node.expression, add)
  }
}

export function collectCopyFromSource(path: string, sourceText: string): CopyEntry[] {
  const source = parse(sourceText, {
    sourceType: 'module',
    sourceFilename: path,
    plugins: ['jsx', 'typescript'],
  })
  const entries: CopyEntry[] = []
  const add = (node: t.Node, value: string, kind: CopyKind): void => {
    const text = normalizedText(value)
    if (text.length === 0 || !/\p{L}/u.test(text)) return
    entries.push({ path: path.replaceAll('\\', '/'), line: sourceLine(node), kind, text })
  }
  const visit = (node: t.Node, ancestors: readonly t.Node[]): void => {
    if (t.isJSXText(node)) add(node, node.value, elementKind(ancestors))
    if (
      t.isJSXExpressionContainer(node)
      && !t.isJSXEmptyExpression(node.expression)
      && !t.isJSXAttribute(ancestors.at(-1))
    ) {
      const kind = elementKind(ancestors)
      collectRenderedExpressionCopy(node.expression, (copyNode, value) => add(copyNode, value, kind))
    }
    if (t.isJSXAttribute(node) && t.isJSXIdentifier(node.name) && visibleAttributes.has(node.name.name) && node.value) {
      if (t.isStringLiteral(node.value)) add(node, node.value.value, 'control')
      if (t.isJSXExpressionContainer(node.value) && !t.isJSXEmptyExpression(node.value.expression)) {
        collectRenderedExpressionCopy(node.value.expression, (copyNode, value) => add(copyNode, value, 'control'))
      }
    }
    if (t.isObjectProperty(node) && t.isIdentifier(node.key) && copyPropertyNames.has(node.key.name)) {
      if (t.isStringLiteral(node.value) || (t.isTemplateLiteral(node.value) && node.value.expressions.length === 0)) {
        const value = t.isStringLiteral(node.value) ? node.value.value : (node.value.quasis[0]?.value.cooked ?? '')
        add(node, value, node.key.name === 'label' ? 'control' : node.key.name === 'title' ? 'heading' : 'body')
      }
    }
    if ((t.isCallExpression(node) || t.isOptionalCallExpression(node)) && visibleCallNames.has(calledFunctionName(node) ?? '')) {
      for (const argument of node.arguments) {
        if (t.isSpreadElement(argument) || t.isArgumentPlaceholder(argument) || t.isJSXNamespacedName(argument)) continue
        collectRenderedExpressionCopy(argument, (copyNode, value) => add(copyNode, value, 'body'))
      }
    }
    const keys = t.VISITOR_KEYS[node.type] ?? []
    for (const key of keys) {
      const child = (node as unknown as Record<string, unknown>)[key]
      if (Array.isArray(child)) {
        for (const entry of child) if (entry && typeof entry === 'object' && 'type' in entry) visit(entry as t.Node, [...ancestors, node])
      } else if (child && typeof child === 'object' && 'type' in child) {
        visit(child as t.Node, [...ancestors, node])
      }
    }
  }
  visit(source, [])
  return entries
}

export function analyzeCopy(
  entries: readonly CopyEntry[],
  policyValue: unknown,
): CopyFinding[] {
  const policy = PolicySchema.parse(policyValue)
  const findings: CopyFinding[] = []
  const patterns = policy.prohibitedPatterns.map(({ id, pattern }) => ({ id, regex: new RegExp(pattern, 'iu') }))
  const learnerWorkflowPatterns = policy.learnerWorkflow?.prohibitedPatterns.map(({ id, pattern }) => ({
    id,
    regex: new RegExp(pattern, 'iu'),
  })) ?? []
  const duplicates = new Map<string, CopyEntry[]>()
  for (const entry of entries) {
    if (mojibakePattern.test(entry.text)) {
      findings.push({
        rule: 'encoding-mojibake',
        path: entry.path,
        line: entry.line,
        detail: 'Visible copy contains a common UTF-8 decoding artifact',
      })
    }
    const maximumCharacters = entry.kind === 'heading'
      ? policy.maximumHeadingCharacters
      : entry.kind === 'control'
        ? policy.maximumControlCharacters
        : policy.maximumBodyCharacters
    if (entry.text.length > maximumCharacters) {
      findings.push({ rule: `${entry.kind}-too-long`, path: entry.path, line: entry.line, detail: `${entry.text.length}/${maximumCharacters} characters` })
    }
    const words = entry.text.split(/\s+/u).length
    if (entry.kind === 'body' && words > policy.maximumBodyWords) {
      findings.push({ rule: 'body-too-many-words', path: entry.path, line: entry.line, detail: `${words}/${policy.maximumBodyWords} words` })
    }
    for (const { id, regex } of patterns) {
      if (regex.test(entry.text)) findings.push({ rule: id, path: entry.path, line: entry.line, detail: 'Prohibited or unsupported interface phrase' })
    }
    if (policy.learnerWorkflow?.pathPrefixes.some((prefix) => entry.path.startsWith(prefix))) {
      for (const { id, regex } of learnerWorkflowPatterns) {
        if (regex.test(entry.text)) {
          findings.push({
            rule: id,
            path: entry.path,
            line: entry.line,
            detail: 'Implementation terminology belongs in Data & Licenses, not a learner workflow',
          })
        }
      }
    }
    if (entry.text.length >= policy.duplicateMinimumCharacters) {
      const key = entry.text.toLocaleLowerCase('en-US')
      duplicates.set(key, [...(duplicates.get(key) ?? []), entry])
    }
  }
  for (const matches of duplicates.values()) {
    if (matches.length <= policy.duplicateMaximumOccurrences) continue
    const [first] = matches
    if (!first) continue
    findings.push({
      rule: 'repetitive-long-copy',
      path: first.path,
      line: first.line,
      detail: `Same ${first.text.length}-character copy appears ${matches.length} times`,
    })
  }
  return findings
}

export async function auditUiCopy(options: { policyPath: string; outputPath: string }): Promise<void> {
  const policy = PolicySchema.parse(JSON.parse(await readFile(options.policyPath, 'utf8')) as unknown)
  const files = await collectFiles(['src/app'], { extensions: new Set(['.tsx']) })
  const entries = (await Promise.all(files.map(async (path) =>
    collectCopyFromSource(workspaceRelative(path), await readFile(path, 'utf8'))
  ))).flat().sort((left, right) => left.path.localeCompare(right.path, 'en') || left.line - right.line)
  const findings = analyzeCopy(entries, policy)
  await writeJsonAtomic(options.outputPath, {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: findings.length === 0 ? 'pass' : 'fail',
    entries,
    findings,
    metrics: {
      files: files.length,
      entries: entries.length,
      headings: entries.filter(({ kind }) => kind === 'heading').length,
      controls: entries.filter(({ kind }) => kind === 'control').length,
      body: entries.filter(({ kind }) => kind === 'body').length,
    },
  })
  process.stdout.write(`UI copy audit: ${findings.length === 0 ? 'PASS' : 'FAIL'} (${entries.length} entries, ${findings.length} findings)\n`)
  if (findings.length > 0) process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
  await auditUiCopy({
    policyPath: option('--policy', 'config/ui-copy-policy.json'),
    outputPath: option('--output', 'audit/generated/ui-copy-inventory.json'),
  })
}
