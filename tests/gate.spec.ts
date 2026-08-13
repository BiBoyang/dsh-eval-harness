import { describe, expect, it } from 'vitest'
import { computeGate, gateExitCode, renderGateJson, renderGateText } from '../src/gate.ts'
import type { CaseResult, CaseStatus, RunReport } from '../src/types.ts'

function caseResult(name: string, status: CaseStatus): CaseResult {
  return {
    name,
    status,
    failures: status === 'fail' ? ['boom'] : [],
    toolsCalled: [],
    toolCalls: [],
    toolResults: [],
    finalText: '',
    steps: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
    toolErrors: [],
    durationMs: 1,
  }
}

function report(cases: CaseResult[]): RunReport {
  return {
    tool: 'dsh-eval-harness',
    version: '0.1.0',
    startedAt: '2026-08-13T00:00:00.000Z',
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

describe('computeGate verdicts', () => {
  it('N/A when no baseline, exit 2', () => {
    const g = computeGate(null, report([caseResult('a', 'pass')]), false)
    expect(g.verdict).toBe('N/A')
    expect(g.exitCode).toBe(2)
  })

  it('PASS when all case results identical, exit 0', () => {
    const before = report([caseResult('a', 'pass'), caseResult('b', 'fail')])
    const after = report([caseResult('a', 'pass'), caseResult('b', 'fail')])
    const g = computeGate(before, after, false)
    expect(g.verdict).toBe('PASS')
    expect(g.exitCode).toBe(0)
  })

  it('FAIL on regression pass -> fail, exit 1', () => {
    const g = computeGate(report([caseResult('a', 'pass')]), report([caseResult('a', 'fail')]), false)
    expect(g.verdict).toBe('FAIL')
    expect(g.exitCode).toBe(1)
    expect(g.regressions.map((d) => d.name)).toEqual(['a'])
  })

  it('FAIL on regression pass -> error (error counts as fail)', () => {
    const g = computeGate(report([caseResult('a', 'pass')]), report([caseResult('a', 'error')]), false)
    expect(g.verdict).toBe('FAIL')
  })

  it('FAIL on newly added failing case', () => {
    const g = computeGate(report([caseResult('a', 'pass')]), report([caseResult('a', 'pass'), caseResult('b', 'fail')]), false)
    expect(g.verdict).toBe('FAIL')
    expect(g.newFailures.map((d) => d.name)).toEqual(['b'])
  })

  it('WARN on fail -> pass improvement, exit 0 (2 in strict)', () => {
    const before = report([caseResult('a', 'fail')])
    const after = report([caseResult('a', 'pass')])
    const g = computeGate(before, after, false)
    expect(g.verdict).toBe('WARN')
    expect(g.exitCode).toBe(0)
    expect(computeGate(before, after, true).exitCode).toBe(2)
  })

  it('WARN on added passing case (count change)', () => {
    const g = computeGate(report([caseResult('a', 'pass')]), report([caseResult('a', 'pass'), caseResult('b', 'pass')]), false)
    expect(g.verdict).toBe('WARN')
    expect(g.added).toEqual(['b'])
  })

  it('WARN on removed case', () => {
    const g = computeGate(report([caseResult('a', 'pass'), caseResult('b', 'pass')]), report([caseResult('a', 'pass')]), false)
    expect(g.verdict).toBe('WARN')
    expect(g.removed).toEqual(['b'])
  })

  it('FAIL dominates WARN signals', () => {
    const before = report([caseResult('a', 'pass'), caseResult('b', 'fail')])
    const after = report([caseResult('a', 'fail'), caseResult('b', 'pass')])
    const g = computeGate(before, after, false)
    expect(g.verdict).toBe('FAIL')
    expect(g.improvements).toHaveLength(1)
  })

  it('unchanged fail case alone stays PASS', () => {
    const g = computeGate(report([caseResult('a', 'fail')]), report([caseResult('a', 'fail')]), false)
    expect(g.verdict).toBe('PASS')
  })
})

describe('gateExitCode', () => {
  it('maps verdicts per protocol', () => {
    expect(gateExitCode('PASS', false)).toBe(0)
    expect(gateExitCode('FAIL', false)).toBe(1)
    expect(gateExitCode('N/A', false)).toBe(2)
    expect(gateExitCode('WARN', false)).toBe(0)
    expect(gateExitCode('WARN', true)).toBe(2)
  })
})

describe('gate output rendering', () => {
  const g = computeGate(report([caseResult('a', 'pass')]), report([caseResult('a', 'fail')]), false)

  it('text output has OVERALL/EXIT_CODE key=value lines and detail lines', () => {
    const text = renderGateText(g)
    expect(text).toContain('OVERALL=FAIL')
    expect(text).toContain('EXIT_CODE=1')
    expect(text).toContain('REGRESSIONS=1')
    expect(text).toContain('REGRESSION a: pass -> fail')
  })

  it('json output is a single parseable JSON object', () => {
    const parsed = JSON.parse(renderGateJson(g)) as { verdict: string; exitCode: number }
    expect(parsed.verdict).toBe('FAIL')
    expect(parsed.exitCode).toBe(1)
    expect(renderGateJson(g)).not.toContain('\n')
  })
})
