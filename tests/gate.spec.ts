import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeGate, gateExitCode, loadReport, renderGateJson, renderGateText } from '../src/gate.ts'
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
    events: 0,
    skippedLines: 0,
    durationMs: 1,
    attempts: 1,
    attemptResults: [{
      index: 1,
      status,
      failures: status === 'fail' ? ['boom'] : [],
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
    }],
  }
}

function report(cases: CaseResult[]): RunReport {
  return {
    schemaVersion: 1,
    tool: 'dsh-eval-harness',
    version: '0.1.0',
    startedAt: '2026-08-13T00:00:00.000Z',
    finishedAt: '2026-08-13T00:00:01.000Z',
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

describe('computeGate token regressions', () => {
  const withTokens = (name: string, status: CaseStatus, total: number): CaseResult => ({
    ...caseResult(name, status),
    tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total },
  })

  it('WARN when an unchanged-status case exceeds the default +50% token threshold', () => {
    const g = computeGate(report([withTokens('a', 'pass', 1000)]), report([withTokens('a', 'pass', 1600)]), false)
    expect(g.verdict).toBe('WARN')
    expect(g.exitCode).toBe(0)
    expect(g.tokenRegressions).toEqual([{ name: 'a', before: 1000, after: 1600, increasePct: 60 }])
  })

  it('PASS when the increase is within the threshold', () => {
    const g = computeGate(report([withTokens('a', 'pass', 1000)]), report([withTokens('a', 'pass', 1400)]), false)
    expect(g.verdict).toBe('PASS')
    expect(g.tokenRegressions).toEqual([])
  })

  it('respects a custom threshold and is disabled by 0', () => {
    const before = report([withTokens('a', 'pass', 1000)])
    const after = report([withTokens('a', 'pass', 1200)])
    expect(computeGate(before, after, false, { maxTokenIncreasePct: 10 }).verdict).toBe('WARN')
    expect(computeGate(before, after, false, { maxTokenIncreasePct: 0 }).verdict).toBe('PASS')
  })

  it('skips cases whose baseline total is 0 (increase undefined)', () => {
    const g = computeGate(report([withTokens('a', 'pass', 0)]), report([withTokens('a', 'pass', 5000)]), false)
    expect(g.verdict).toBe('PASS')
  })

  it('FAIL verdict still records token regressions in reasons', () => {
    const before = report([withTokens('a', 'pass', 1000), withTokens('b', 'pass', 1000)])
    const after = report([withTokens('a', 'fail', 1000), withTokens('b', 'pass', 2000)])
    const g = computeGate(before, after, false)
    expect(g.verdict).toBe('FAIL')
    expect(g.tokenRegressions.map((d) => d.name)).toEqual(['b'])
    expect(g.reasons.some((r) => r.includes('token regression: b'))).toBe(true)
  })

  it('skips cases whose status changed (pass->fail / fail->pass are not token regressions)', () => {
    const before = report([withTokens('a', 'pass', 1000), withTokens('b', 'fail', 1000), withTokens('c', 'fail', 1000)])
    const after = report([withTokens('a', 'fail', 2000), withTokens('b', 'pass', 2000), withTokens('c', 'error', 2000)])
    const g = computeGate(before, after, false)
    expect(g.verdict).toBe('FAIL')
    expect(g.tokenRegressions).toEqual([])
    expect(g.reasons.some((r) => r.includes('token regression'))).toBe(false)
  })

  it('counts fail -> fail with a token jump (status unchanged)', () => {
    const g = computeGate(report([withTokens('a', 'fail', 1000)]), report([withTokens('a', 'fail', 2000)]), false)
    expect(g.verdict).toBe('WARN')
    expect(g.tokenRegressions.map((d) => d.name)).toEqual(['a'])
  })

  it('text output has TOKEN_REGRESSIONS count and detail lines', () => {
    const g = computeGate(report([withTokens('a', 'pass', 1000)]), report([withTokens('a', 'pass', 1600)]), false)
    const text = renderGateText(g)
    expect(text).toContain('OVERALL=WARN')
    expect(text).toContain('TOKEN_REGRESSIONS=1')
    expect(text).toContain('TOKEN_REGRESSION a: total 1000 -> 1600 (+60%)')
  })
})

describe('computeGate skippedLines increases', () => {
  const withSkipped = (name: string, status: CaseStatus, skipped: number): CaseResult => ({
    ...caseResult(name, status),
    skippedLines: skipped,
  })

  it('WARN when skippedLines grows with unchanged status', () => {
    const g = computeGate(report([withSkipped('a', 'pass', 0)]), report([withSkipped('a', 'pass', 3)]), false)
    expect(g.verdict).toBe('WARN')
    expect(g.exitCode).toBe(0)
    expect(g.skippedLineIncreases).toEqual([{ name: 'a', before: 0, after: 3 }])
    expect(g.reasons.some((r) => r.includes('skipped lines increase: a 0 -> 3'))).toBe(true)
  })

  it('PASS when skippedLines is unchanged or decreased', () => {
    expect(computeGate(report([withSkipped('a', 'pass', 2)]), report([withSkipped('a', 'pass', 2)]), false).verdict).toBe('PASS')
    expect(computeGate(report([withSkipped('a', 'pass', 2)]), report([withSkipped('a', 'pass', 1)]), false).verdict).toBe('PASS')
  })

  it('records increases even under FAIL verdict; new cases are not compared', () => {
    const g = computeGate(
      report([withSkipped('a', 'pass', 0)]),
      report([withSkipped('a', 'fail', 2), withSkipped('b', 'pass', 5)]),
      false,
    )
    expect(g.verdict).toBe('FAIL')
    expect(g.skippedLineIncreases).toEqual([{ name: 'a', before: 0, after: 2 }])
  })

  it('text output has SKIPPED_LINE_INCREASES count and detail lines', () => {
    const g = computeGate(report([withSkipped('a', 'pass', 0)]), report([withSkipped('a', 'pass', 3)]), false)
    const text = renderGateText(g)
    expect(text).toContain('OVERALL=WARN')
    expect(text).toContain('SKIPPED_LINE_INCREASES=1')
    expect(text).toContain('SKIPPED_LINE_INCREASE a: 0 -> 3')
  })
})

describe('computeGate flaky signals', () => {
  const CRASH = "Error: ENOENT: no such file or directory, readlink '/x'\n    at readlinkSync (node:fs:1761:18)\n    at ensureSymlink (file:///app/lib/index.js:380:7)\n"

  const flakyCase = (name: string, stderrTail?: string): CaseResult => {
    const base = caseResult(name, 'pass')
    const errorAttempt = { ...caseResult(name, 'error').attemptResults[0], ...(stderrTail === undefined ? {} : { stderrTail }) }
    return { ...base, attempts: 2, flaky: true, attemptResults: [errorAttempt, { ...base.attemptResults[0], index: 2 }] }
  }

  it('WARN when flaky cases increase vs baseline', () => {
    const g = computeGate(report([caseResult('a', 'pass')]), report([flakyCase('a')]), false)
    expect(g.verdict).toBe('WARN')
    expect(g.flakyCases).toEqual(['a'])
    expect(g.reasons.some((r) => r.includes('new flaky case: a'))).toBe(true)
  })

  it('PASS when the same case is flaky in baseline (no repeated alarm)', () => {
    const g = computeGate(report([flakyCase('a')]), report([flakyCase('a')]), false)
    expect(g.verdict).toBe('PASS')
    expect(g.flakyCases).toEqual([])
    // baseline hygiene 提示：flaky 不该收编进 baseline，但只提示不影响判定
    expect(g.baselineFlakyCases).toEqual(['a'])
    expect(g.reasons.some((r) => r.includes('baseline contains 1 flaky case(s)'))).toBe(true)
  })

  it('text output has FLAKY count and detail lines', () => {
    const g = computeGate(report([caseResult('a', 'pass')]), report([flakyCase('a')]), false)
    const text = renderGateText(g)
    expect(text).toContain('FLAKY=1')
    expect(text).toContain('FLAKY_CASE a')
  })

  it('flaky first-attempt crash feeds the signature aggregation (double signal accepted)', () => {
    const g = computeGate(
      report([caseResult('a', 'pass'), caseResult('b', 'pass')]),
      report([flakyCase('a', CRASH), flakyCase('b', CRASH)]),
      false,
    )
    expect(g.verdict).toBe('WARN')
    expect(g.flakyCases).toEqual(['a', 'b'])
    expect(g.repeatedErrorSignatures).toEqual([{ signature: 'ENOENT@ensureSymlink', occurrences: 2, cases: ['a', 'b'] }])
  })
})

describe('computeGate tool error recovery signals', () => {
  const recoveredCase = (name: string): CaseResult => ({
    ...caseResult(name, 'pass'),
    toolErrors: [{ name: 'bash', error: 'exit 1' }],
  })

  it('WARN when a pass-with-tool-errors case is new vs baseline', () => {
    const g = computeGate(report([caseResult('a', 'pass')]), report([recoveredCase('a')]), false)
    expect(g.verdict).toBe('WARN')
    expect(g.toolErrorRecoveries).toEqual(['a'])
    expect(g.reasons.some((r) => r.includes('tool error recovered: a'))).toBe(true)
  })

  it('PASS when the recovery already exists in baseline', () => {
    const g = computeGate(report([recoveredCase('a')]), report([recoveredCase('a')]), false)
    expect(g.verdict).toBe('PASS')
    expect(g.toolErrorRecoveries).toEqual([])
  })

  it('failing cases with tool errors are not recoveries', () => {
    const fail = { ...caseResult('a', 'fail'), toolErrors: [{ name: 'bash', error: 'exit 1' }] }
    const g = computeGate(report([fail]), report([fail]), false)
    expect(g.verdict).toBe('PASS')
    expect(g.toolErrorRecoveries).toEqual([])
  })
})

describe('computeGate error signature aggregation', () => {
  const CRASH = "Error: ENOENT: no such file or directory, readlink '/x'\n    at readlinkSync (node:fs:1761:18)\n    at ensureSymlink (file:///app/lib/index.js:380:7)\n"
  const crashedCase = (name: string): CaseResult => {
    const base = caseResult(name, 'error')
    return { ...base, attemptResults: [{ ...base.attemptResults[0], stderrTail: CRASH }] }
  }

  it('WARN when one signature repeats across cases (shared-state suspect)', () => {
    const g = computeGate(report([caseResult('a', 'error'), caseResult('b', 'error')]), report([crashedCase('a'), crashedCase('b')]), false)
    expect(g.verdict).toBe('WARN')
    expect(g.repeatedErrorSignatures).toEqual([{ signature: 'ENOENT@ensureSymlink', occurrences: 2, cases: ['a', 'b'] }])
    expect(g.reasons.some((r) => r.includes('repeated error signature: ENOENT@ensureSymlink x2'))).toBe(true)
  })

  it('does not signal on a single occurrence', () => {
    const g = computeGate(report([caseResult('a', 'error')]), report([crashedCase('a')]), false)
    expect(g.verdict).toBe('PASS')
    expect(g.repeatedErrorSignatures).toEqual([])
  })

  it('text output has REPEATED_ERROR_SIGNATURES count and detail lines', () => {
    const g = computeGate(report([caseResult('a', 'error'), caseResult('b', 'error')]), report([crashedCase('a'), crashedCase('b')]), false)
    const text = renderGateText(g)
    expect(text).toContain('REPEATED_ERROR_SIGNATURES=1')
    expect(text).toContain('ERROR_SIGNATURE ENOENT@ensureSymlink: x2 across [a, b]')
  })
})

describe('computeGate dsh version change', () => {
  const withVersion = (r: RunReport, dshVersion: string): RunReport => ({ ...r, dshVersion })

  it('stays PASS and only adds an informational reason + output line', () => {
    const before = withVersion(report([caseResult('a', 'pass')]), '0.1.0-rc.6')
    const after = withVersion(report([caseResult('a', 'pass')]), '0.1.1-rc.2')
    const g = computeGate(before, after, false)
    expect(g.verdict).toBe('PASS')
    expect(g.dshVersionChange).toEqual({ before: '0.1.0-rc.6', after: '0.1.1-rc.2' })
    expect(g.reasons.some((r) => r.includes('dsh version changed: 0.1.0-rc.6 -> 0.1.1-rc.2'))).toBe(true)
    const text = renderGateText(g)
    expect(text).toContain('DSH_VERSION_CHANGED=0.1.0-rc.6 -> 0.1.1-rc.2')
  })

  it('no signal when version is unchanged or missing on either side', () => {
    const a = withVersion(report([caseResult('x', 'pass')]), '0.1.1-rc.2')
    expect(computeGate(a, a, false).dshVersionChange).toBeUndefined()
    expect(computeGate(report([caseResult('x', 'pass')]), a, false).dshVersionChange).toBeUndefined()
  })
})

describe('computeGate reliability gate (minTrialSuccessRate)', () => {
  const withReliability = (name: string, passes: number, trials: number): CaseResult => ({
    ...caseResult(name, 'pass'),
    reliability: { trials, passes, successRate: passes / trials, passAtK: 1, passPowK: 1, k: 1 },
  })

  it('is off by default: unreliable case stays PASS without the option', () => {
    // 10 次过 9 次：点估计 0.9，单侧 Wilson 下界约 0.65——不设阈值时门禁不消费尺子
    const g = computeGate(report([caseResult('a', 'pass')]), report([withReliability('a', 9, 10)]), false)
    expect(g.verdict).toBe('PASS')
    expect(g.unreliableCases).toEqual([])
  })

  it('WARN when the Wilson lower bound falls below the threshold (not the point estimate)', () => {
    const before = report([caseResult('a', 'pass')])
    const after = report([withReliability('a', 9, 10)])
    const g = computeGate(before, after, false, { minTrialSuccessRate: 0.8 })
    expect(g.verdict).toBe('WARN')
    expect(g.unreliableCases).toHaveLength(1)
    expect(g.unreliableCases[0]?.name).toBe('a')
    expect(g.unreliableCases[0]?.successRate).toBeCloseTo(0.9)
    expect(g.unreliableCases[0]?.lowerBound).toBeCloseTo(0.65, 1)
    expect(g.reasons.some((r) => r.includes('unreliable case: a'))).toBe(true)
  })

  it('PASS when the lower bound clears the threshold', () => {
    // n=100, 96 过：下界约 0.91，过 0.8 阈值
    const g = computeGate(report([caseResult('a', 'pass')]), report([withReliability('a', 96, 100)]), false, {
      minTrialSuccessRate: 0.8,
    })
    expect(g.verdict).toBe('PASS')
    expect(g.unreliableCases).toEqual([])
  })

  it('ignores cases without a reliability block and validates the threshold', () => {
    const g = computeGate(report([caseResult('a', 'pass')]), report([caseResult('a', 'pass')]), false, {
      minTrialSuccessRate: 0.9,
    })
    expect(g.verdict).toBe('PASS')
    expect(() =>
      computeGate(report([caseResult('a', 'pass')]), report([caseResult('a', 'pass')]), false, { minTrialSuccessRate: 1.5 }),
    ).toThrow(/min_trial_success_rate must be in \[0, 1\]/)
  })

  it('text output has UNRELIABLE count and detail lines', () => {
    const g = computeGate(report([caseResult('a', 'pass')]), report([withReliability('a', 9, 10)]), false, {
      minTrialSuccessRate: 0.8,
    })
    const text = renderGateText(g)
    expect(text).toContain('UNRELIABLE=1')
    expect(text).toContain('UNRELIABLE_CASE a: successRate 0.90')
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

describe('loadReport schema validation', () => {
  const writeReport = async (value: unknown): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'eval-report-'))
    const path = join(root, 'report.json')
    await writeFile(path, JSON.stringify(value))
    return path
  }

  it('loads current schema 1 reports', async () => {
    const path = await writeReport(report([caseResult('a', 'pass')]))
    const loaded = await loadReport(path)
    expect(loaded?.schemaVersion).toBe(1)
    expect(loaded?.cases[0]?.events).toBe(0)
    expect(loaded?.cases[0]?.attemptResults).toHaveLength(1)
  })

  it('preserves dshVersion and rejects a non-string one', async () => {
    const withVersion = { ...report([caseResult('a', 'pass')]), dshVersion: '0.1.0-rc.6' }
    expect((await loadReport(await writeReport(withVersion)))?.dshVersion).toBe('0.1.0-rc.6')

    const badVersion = { ...report([caseResult('a', 'pass')]), dshVersion: 123 }
    await expect(loadReport(await writeReport(badVersion))).rejects.toThrow(/dshVersion must be a string/)
  })

  it('preserves a valid reliability block and rejects malformed ones', async () => {
    const reliability = { trials: 3, passes: 2, successRate: 2 / 3, passAtK: 1, passPowK: 4 / 9, k: 2 }
    const base = caseResult('a', 'pass')
    const good = { ...report([base]), cases: [{ ...base, reliability }] }
    expect((await loadReport(await writeReport(good)))?.cases[0]?.reliability?.trials).toBe(3)

    const badRate = { ...report([base]), cases: [{ ...base, reliability: { ...reliability, successRate: 1.5 } }] }
    await expect(loadReport(await writeReport(badRate))).rejects.toThrow(/reliability\.successRate must be a number in \[0, 1\]/)

    const passesOverflow = { ...report([base]), cases: [{ ...base, reliability: { ...reliability, passes: 4 } }] }
    await expect(loadReport(await writeReport(passesOverflow))).rejects.toThrow(/reliability\.passes must not exceed trials/)
  })

  it('normalizes legacy reports without schemaVersion', async () => {
    const legacy = {
      tool: 'dsh-eval-harness',
      version: '0.2.0',
      startedAt: '2026-08-14T02:48:31.228Z',
      profile: 'headless',
      cases: [
        {
          name: 'legacy',
          status: 'pass',
          failures: [],
          toolsCalled: [],
          toolCalls: [],
          toolResults: [],
          finalText: 'ok',
          steps: 0,
          tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3 },
          toolErrors: [],
          durationMs: 4,
        },
      ],
      summary: { total: 1, passed: 1, failed: 0, errored: 0 },
    }
    const loaded = await loadReport(await writeReport(legacy))
    expect(loaded?.schemaVersion).toBe(0)
    expect(loaded?.finishedAt).toBe(legacy.startedAt)
    expect(loaded?.durationMs).toBe(0)
    expect(loaded?.cases[0]?.attempts).toBe(1)
    expect(loaded?.cases[0]?.events).toBe(0)
    expect(loaded?.cases[0]?.attemptResults).toHaveLength(1)
  })

  it('normalizes pre-attempt-history flaky reports without fabricating attempts', async () => {
    const base = caseResult('legacy-flaky', 'pass')
    const legacy = {
      ...report([base]),
      schemaVersion: 0,
      cases: [{ ...base, attempts: 2, flaky: true, attemptResults: undefined }],
    }
    const loaded = await loadReport(await writeReport(legacy))
    expect(loaded?.cases[0]?.attempts).toBe(1)
    expect(loaded?.cases[0]?.attemptResults).toHaveLength(1)
    expect(loaded?.cases[0]?.flaky).toBeUndefined()
  })

  it('rejects unsupported schema versions', async () => {
    const path = await writeReport({ ...report([]), schemaVersion: 2 })
    await expect(loadReport(path)).rejects.toThrow(/unsupported schemaVersion '2'/)
  })

  it('rejects duplicate names and summary mismatches', async () => {
    const duplicate = report([caseResult('a', 'pass'), caseResult('a', 'pass')])
    await expect(loadReport(await writeReport(duplicate))).rejects.toThrow(/duplicate case name 'a'/)

    const mismatch = { ...report([caseResult('a', 'pass')]), summary: { total: 1, passed: 0, failed: 1, errored: 0 } }
    await expect(loadReport(await writeReport(mismatch))).rejects.toThrow(/summary does not match cases/)
  })

  it('rejects inconsistent attempt history', async () => {
    const base = caseResult('a', 'pass')
    const mismatch = { ...report([base]), cases: [{ ...base, attempts: 2, attemptResults: base.attemptResults }] }
    await expect(loadReport(await writeReport(mismatch))).rejects.toThrow(/attempts must equal attemptResults.length/)
    const wrongStatus = { ...report([base]), cases: [{ ...base, attemptResults: [{ ...base.attemptResults[0], status: 'fail' }] }] }
    await expect(loadReport(await writeReport(wrongStatus))).rejects.toThrow(/last status must equal case status/)
  })

  it('returns null for a missing optional baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eval-report-missing-'))
    expect(await loadReport(join(root, 'missing.json'), true)).toBeNull()
  })
})
