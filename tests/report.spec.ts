import { describe, expect, it } from 'vitest'
import { renderMarkdown } from '../src/report.ts'
import type { CaseResult, CaseStatus, RunReport } from '../src/types.ts'

function caseResult(name: string, status: CaseStatus): CaseResult {
  return {
    name,
    status,
    failures: [],
    toolsCalled: [],
    toolCalls: [],
    toolResults: [],
    finalText: '',
    steps: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    toolErrors: [],
    events: 0,
    skippedLines: 0,
    durationMs: 1,
    attempts: 1,
    attemptResults: [
      {
        index: 1,
        status,
        failures: [],
        toolsCalled: [],
        toolCalls: [],
        toolResults: [],
        finalText: '',
        steps: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
        toolErrors: [],
        events: 0,
        skippedLines: 0,
        durationMs: 1,
      },
    ],
  }
}

function report(cases: CaseResult[]): RunReport {
  return {
    schemaVersion: 1,
    tool: 'dsh-eval-harness',
    version: '0.0.0-test',
    startedAt: '2026-08-24T00:00:00.000Z',
    finishedAt: '2026-08-24T00:00:01.000Z',
    durationMs: 1000,
    profile: 'headless',
    cases,
    summary: {
      total: cases.length,
      passed: cases.filter((c) => c.status === 'pass').length,
      failed: cases.filter((c) => c.status === 'fail').length,
      errored: cases.filter((c) => c.status === 'error').length,
    },
  }
}

const CRASH = "Error: ENOENT: no such file or directory, readlink '/x'\n    at readlinkSync (node:fs:1761:18)\n    at ensureSymlink (file:///app/lib/index.js:380:7)\n"

function flakyWithCrash(name: string): CaseResult {
  const base = caseResult(name, 'pass')
  const errorAttempt = { ...caseResult(name, 'error').attemptResults[0], stderrTail: CRASH }
  return { ...base, attempts: 2, flaky: true, attemptResults: [errorAttempt, { ...base.attemptResults[0], index: 2 }] }
}

describe('renderMarkdown', () => {
  it('summary line notes flaky count only when present', () => {
    const clean = renderMarkdown(report([caseResult('a', 'pass')]))
    expect(clean).not.toContain('flaky')

    const withFlaky = renderMarkdown(report([flakyWithCrash('a'), caseResult('b', 'pass')]))
    expect(withFlaky).toContain('（其中 flaky 1 条')
  })

  it('renders the error signature section only for repeated signatures', () => {
    const single = renderMarkdown(report([flakyWithCrash('a'), caseResult('b', 'pass')]))
    expect(single).not.toContain('## 错误签名聚合')

    const repeated = renderMarkdown(report([flakyWithCrash('a'), flakyWithCrash('b')]))
    expect(repeated).toContain('## 错误签名聚合')
    expect(repeated).toContain('`ENOENT@ensureSymlink` × 2（用例：a, b）')
  })
})
