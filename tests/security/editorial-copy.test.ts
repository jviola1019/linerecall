import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeCopy, collectCopyFromSource } from '../../scripts/editorial/audit-ui-copy.ts'

const policy = {
  schemaVersion: 1,
  maximumHeadingCharacters: 72,
  maximumControlCharacters: 96,
  maximumBodyCharacters: 320,
  maximumBodyWords: 56,
  duplicateMinimumCharacters: 36,
  duplicateMaximumOccurrences: 2,
  prohibitedPatterns: [
    { id: 'unsupported-causality', pattern: '\\bthis move guarantees a win\\b' },
  ],
}

test('copy inventory extracts headings, controls, and visible body text', () => {
  const entries = collectCopyFromSource('Example.tsx', `
    export const Example = () => <main>
      <h1>Study one line at a time</h1>
      <button aria-label="Start review">Begin</button>
      <button aria-label={pending ? 'Saving review' : 'Review ready'} />
      <p>Historical results describe the games in this cohort.</p>
      <button>{pending ? 'Saving family cycleâ€¦' : 'Practice family'}</button>
    </main>
  `)
  assert.deepEqual(entries.map(({ kind, text }) => ({ kind, text })), [
    { kind: 'heading', text: 'Study one line at a time' },
    { kind: 'control', text: 'Start review' },
    { kind: 'control', text: 'Begin' },
    { kind: 'control', text: 'Saving review' },
    { kind: 'control', text: 'Review ready' },
    { kind: 'body', text: 'Historical results describe the games in this cohort.' },
    { kind: 'control', text: 'Saving family cycleâ€¦' },
    { kind: 'control', text: 'Practice family' },
  ])
  assert.equal(analyzeCopy(entries, policy).some(({ rule }) => rule === 'encoding-mojibake'), true)
})

test('copy audit blocks encoding defects, inflated claims, excessive length, and repeated long prose', () => {
  const repeated = 'This sentence is deliberately long enough to trigger repetition review.'
  const findings = analyzeCopy([
    { path: 'a.tsx', line: 1, kind: 'body', text: 'Loading family packsâ€¦' },
    { path: 'a.tsx', line: 1, kind: 'body', text: 'This move guarantees a win.' },
    { path: 'a.tsx', line: 2, kind: 'heading', text: 'x'.repeat(73) },
    { path: 'a.tsx', line: 3, kind: 'body', text: repeated },
    { path: 'b.tsx', line: 3, kind: 'body', text: repeated },
    { path: 'c.tsx', line: 3, kind: 'body', text: repeated },
  ], policy)
  assert.deepEqual(new Set(findings.map(({ rule }) => rule)), new Set([
    'encoding-mojibake', 'unsupported-causality', 'heading-too-long', 'repetitive-long-copy',
  ]))
})
