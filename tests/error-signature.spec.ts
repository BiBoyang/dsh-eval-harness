import { describe, expect, it } from 'vitest'
import { aggregateErrorSignatures, extractErrorSignature, REPEATED_SIGNATURE_THRESHOLD } from '../src/error-signature.ts'
import type { CaseResult, CaseStatus, RunReport } from '../src/types.ts'

// 真实样本：dsh 0.1.1-rc.2 并发启动时 ensureSymlink 的两种 ENOENT 崩溃栈
// （deepseek-harness Discussions #4312，.eval/v0.3.2-candidate2 报告原文截断）
const READLINK_CRASH = `node:fs:1761
  return binding.readlink(getValidatedPath(path), options.encoding);
                 ^

Error: ENOENT: no such file or directory, readlink '/Users/boyang/.dsh/profiles/node_modules/commander'
    at readlinkSync (node:fs:1761:18)
    at ensureSymlink (file:///Users/boyang/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:380:7)
    at healProfilesModuleFallback (file:///Users/boyang/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:436:3)
`

const UNLINK_CRASH = `node:fs:1922
  binding.unlink(getValidatedPath(path));
          ^

Error: ENOENT: no such file or directory, unlink '/Users/boyang/.dsh/profiles/node_modules/@deepseek-ai/cordis-plugin-timer'
    at unlinkSync (node:fs:1922:11)
    at ensureSymlink (file:///Users/boyang/.npm/_npx/1e7f6d9597241db0/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:381:3)
`

describe('extractErrorSignature', () => {
  it('extracts <code>@<top app frame> from real ENOENT crash stacks', () => {
    // 两种崩溃（readlink/unlink）的系统调用不同，但栈顶应用帧同为 ensureSymlink——
    // 签名必须把它们聚成同一类
    expect(extractErrorSignature(READLINK_CRASH)).toBe('ENOENT@ensureSymlink')
    expect(extractErrorSignature(UNLINK_CRASH)).toBe('ENOENT@ensureSymlink')
  })

  it('skips node: internal frames and picks the first application frame', () => {
    const stderr = 'Error: EACCES: permission denied\n    at openSync (node:fs:600:3)\n    at prepareProfile (file:///app/lib/index.js:10:5)\n'
    expect(extractErrorSignature(stderr)).toBe('EACCES@prepareProfile')
  })

  it('falls back to code-only when no application frame exists', () => {
    const stderr = 'Error: ENOENT: no such file or directory\n    at readlinkSync (node:fs:1761:18)\n'
    expect(extractErrorSignature(stderr)).toBe('ENOENT')
  })

  it('handles non-system error names', () => {
    const stderr = 'TypeError: Cannot read properties of undefined\n    at parse (file:///app/x.js:1:1)\n'
    expect(extractErrorSignature(stderr)).toBe('TypeError@parse')
  })

  it('returns null when there is no Error line (conservative: rather miss than miscluster)', () => {
    expect(extractErrorSignature('some warning\nnot an error')).toBeNull()
    expect(extractErrorSignature('')).toBeNull()
    expect(extractErrorSignature(undefined)).toBeNull()
  })
})

function attempt(index: number, status: CaseStatus, stderrTail?: string): CaseResult['attemptResults'][number] {
  return {
    index,
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
    ...(stderrTail === undefined ? {} : { stderrTail }),
    durationMs: 1,
  }
}

function caseWithAttempts(name: string, status: CaseStatus, attempts: CaseResult['attemptResults']): CaseResult {
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
    attempts: attempts.length,
    attemptResults: attempts,
  }
}

function reportOf(cases: CaseResult[]): RunReport {
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

describe('aggregateErrorSignatures', () => {
  it('clusters the #4312 scenario: two cases crashing at the same signature', () => {
    const report = reportOf([
      caseWithAttempts('bash-tool', 'pass', [attempt(1, 'error', READLINK_CRASH), attempt(2, 'pass')]),
      caseWithAttempts('fs-write-read', 'pass', [attempt(1, 'error', UNLINK_CRASH), attempt(2, 'pass')]),
      caseWithAttempts('todo-tool', 'pass', [attempt(1, 'pass')]),
    ])
    const groups = aggregateErrorSignatures(report)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.signature).toBe('ENOENT@ensureSymlink')
    expect(groups[0]?.occurrences).toBe(2)
    expect(groups[0]?.cases).toEqual(['bash-tool', 'fs-write-read'])
    expect(groups[0]?.occurrences).toBeGreaterThanOrEqual(REPEATED_SIGNATURE_THRESHOLD)
  })

  it('ignores stderr of passing attempts and unparseable stderr', () => {
    const report = reportOf([
      caseWithAttempts('a', 'pass', [attempt(1, 'pass', READLINK_CRASH)]),
      caseWithAttempts('b', 'fail', [attempt(1, 'fail', 'no error line here')]),
    ])
    expect(aggregateErrorSignatures(report)).toEqual([])
  })

  it('counts repeated crashes of one case and sorts by occurrences desc', () => {
    const report = reportOf([
      caseWithAttempts('a', 'error', [attempt(1, 'error', READLINK_CRASH)]),
      caseWithAttempts('b', 'error', [attempt(1, 'error', READLINK_CRASH), attempt(2, 'error', UNLINK_CRASH)]),
      caseWithAttempts('c', 'error', [
        attempt(1, 'error', 'Error: EACCES: denied\n    at prepareProfile (file:///app/lib/index.js:10:5)\n'),
      ]),
    ])
    const groups = aggregateErrorSignatures(report)
    expect(groups[0]?.signature).toBe('ENOENT@ensureSymlink')
    expect(groups[0]?.occurrences).toBe(3)
    expect(groups[0]?.cases).toEqual(['a', 'b'])
    expect(groups[1]?.signature).toBe('EACCES@prepareProfile')
    expect(groups[1]?.occurrences).toBe(1)
  })
})
