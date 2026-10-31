import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { computeGate, renderGateText } from '../src/gate.ts'
import { apply } from '../src/index.ts'
import { loadCases, parseCase, runEval } from '../src/runner.ts'
import type { RunOptions } from '../src/runner.ts'
import {
  buildCalibration,
  checkSentinelCases,
  judgeSentinel,
  needsMockSentinels,
  SENTINELS_DIR,
  sentinelReasons,
  sentinelsState,
  skippedCalibration,
  weakCaseWarnings,
} from '../src/sentinel.ts'
import type { CaseStatus, EvalCase, RunReport, SentinelResult } from '../src/types.ts'

const CASES_DIR = fileURLToPath(new URL('../cases', import.meta.url))
const FAKE_DSH = fileURLToPath(new URL('./probes/fake-dsh.mjs', import.meta.url))
const SENTINEL_NAMES = ['sentinel-mock-echo', 'sentinel-mock-impossible']

const tempRoots: string[] = []
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

describe('cases/_sentinels（内置哨兵集）', () => {
  it('ships exactly S1 (must-pass, F0) and S2 (must-fail, persistent F1, measured exit_code 1)', async () => {
    const sentinels = checkSentinelCases(await loadCases(SENTINELS_DIR), SENTINELS_DIR)
    expect(sentinels.map((s) => [s.name, s.sentinel])).toEqual([
      ['sentinel-mock-echo', 'must-pass'],
      ['sentinel-mock-impossible', 'must-fail'],
    ])
    const [s1, s2] = sentinels
    expect(s1?.mock).toEqual({ fault: 'F0' })
    expect(s1?.assert).toEqual({ turn_end: 'completed', exit_code: 0, output_contains: ['【P01】', '【P24】'] })
    // S2：持续注入（不设 once），mock 每个请求都只发到【P12】；exit_code 1 为 dsh 0.1.7-rc.2 实测——
    // 不声明的话非零退出直接记 error，哨兵会因 error 被误判为破
    expect(s2?.mock).toEqual({ fault: 'F1' })
    expect(s2?.assert).toEqual({ exit_code: 1, turn_end: 'completed', output_contains: ['【P24】'] })
  })

  it('stays invisible to loadCases of cases/ (one directory level, not recursive)', async () => {
    const names = (await loadCases(CASES_DIR)).map((c) => c.evalCase.name)
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((n) => SENTINEL_NAMES.includes(n))).toEqual([])
  })
})

describe('parseCase sentinel', () => {
  const yaml = (sentinel: string): string => `name: s\nprompt: "p"\n${sentinel}mock:\n  fault: F0\nassert:\n  turn_end: completed\n`

  it('parses must-pass / must-fail and leaves it undefined when absent', () => {
    expect(parseCase(yaml('sentinel: must-pass\n'), 's.yml').sentinel).toBe('must-pass')
    expect(parseCase(yaml('sentinel: must-fail\n'), 's.yml').sentinel).toBe('must-fail')
    expect(parseCase(yaml(''), 's.yml').sentinel).toBeUndefined()
  })

  it('rejects any other value', () => {
    for (const value of ['maybe', 'true', '1', '"must-pass "']) {
      expect(() => parseCase(yaml(`sentinel: ${value}\n`), 's.yml')).toThrow(/'sentinel' must be one of must-pass, must-fail/)
    }
  })
})

describe('checkSentinelCases', () => {
  const mockCase = (extra: Partial<EvalCase> = {}): EvalCase => ({ name: 'x', prompt: 'p', mock: { fault: 'F0' }, assert: {}, ...extra })

  it('rejects a sentinel file without a sentinel kind', () => {
    expect(() => checkSentinelCases([{ file: 'x.yml', evalCase: mockCase() }], '/s')).toThrow(/sentinel file 'x\.yml' in '\/s' must declare 'sentinel: must-pass' or 'sentinel: must-fail'/)
  })

  it('rejects a non-mock sentinel (P0 runs mock sentinels only)', () => {
    expect(() => checkSentinelCases([{ file: 'x.yml', evalCase: mockCase({ sentinel: 'must-pass', mock: undefined }) }], '/s')).toThrow(/sentinel 'x' in '\/s' must be a mock case/)
  })
})

describe('judgeSentinel（期望判定）', () => {
  const result = (status: CaseStatus, extra: { error?: string; failures?: string[] } = {}) => ({ name: 's', status, failures: [], ...extra })

  it('must-pass is ok only on pass; fail and error both breach', () => {
    expect(judgeSentinel('must-pass', result('pass'))).toEqual({ name: 's', kind: 'must-pass', expected: 'pass', status: 'pass', ok: true })
    expect(judgeSentinel('must-pass', result('fail')).ok).toBe(false)
    expect(judgeSentinel('must-pass', result('error')).ok).toBe(false)
  })

  it('must-fail is ok only on fail; pass breaches and error breaches too', () => {
    expect(judgeSentinel('must-fail', result('fail')).ok).toBe(true)
    expect(judgeSentinel('must-fail', result('pass')).ok).toBe(false)
    // error（如 delivery-missing：dsh 没打到 mock）证明不了判分会说不，同样是破
    expect(judgeSentinel('must-fail', result('error')).ok).toBe(false)
  })

  it('carries the error and non-empty failures for diagnosis', () => {
    expect(judgeSentinel('must-pass', result('error', { error: 'delivery-missing: x' }))).toEqual({
      name: 's',
      kind: 'must-pass',
      expected: 'pass',
      status: 'error',
      error: 'delivery-missing: x',
      ok: false,
    })
    expect(judgeSentinel('must-fail', result('fail', { failures: ['output_contains: missing'] })).failures).toEqual(['output_contains: missing'])
  })
})

describe('calibration 组装与 gate 视角', () => {
  const sentinel = (name: string, ok: boolean, status: CaseStatus = ok ? 'pass' : 'fail'): SentinelResult => ({ name, kind: 'must-pass', expected: 'pass', status, ok })

  it('healthy needs at least one sentinel and every sentinel ok', () => {
    expect(buildCalibration([sentinel('a', true), sentinel('b', true)], []).healthy).toBe(true)
    expect(buildCalibration([sentinel('a', true), sentinel('b', false)], []).healthy).toBe(false)
    expect(buildCalibration([], []).healthy).toBe(false)
  })

  it('skipped calibration has no sentinels and is never healthy', () => {
    expect(skippedCalibration([{ name: 'w', reason: 'no-outcome-assertion' }])).toEqual({
      sentinels: [],
      healthy: false,
      skipped: true,
      weakCases: [{ name: 'w', reason: 'no-outcome-assertion' }],
    })
  })

  it('maps calibration to ok / breach / skipped / absent with gate reasons', () => {
    expect(sentinelsState(undefined)).toBe('absent')
    expect(sentinelReasons(undefined)).toEqual([])
    expect(sentinelsState(buildCalibration([sentinel('a', true)], []))).toBe('ok')
    expect(sentinelReasons(buildCalibration([sentinel('a', true)], []))).toEqual([])
    expect(sentinelsState(skippedCalibration([]))).toBe('skipped')
    expect(sentinelReasons(skippedCalibration([]))).toEqual(['sentinels skipped'])
    const breached = buildCalibration([sentinel('a', true), sentinel('b', false, 'error')], [])
    expect(sentinelsState(breached)).toBe('breach')
    expect(sentinelReasons(breached)).toEqual(['sentinel breach: b expected must-pass got error'])
  })

  it('is fail-safe on an inconsistent in-memory calibration (healthy flag vs sentinel details)', () => {
    expect(sentinelsState({ sentinels: [sentinel('a', false)], healthy: true, weakCases: [] })).toBe('breach')
    expect(sentinelsState({ sentinels: [sentinel('a', true)], healthy: false, weakCases: [] })).toBe('breach')
    expect(sentinelReasons({ sentinels: [sentinel('a', true)], healthy: false, weakCases: [] })).toEqual(['sentinel breach: calibration unhealthy'])
  })
})

describe('注入规则与弱用例（纯函数）', () => {
  const real: EvalCase = { name: 'real', prompt: 'p', assert: { output_contains: ['not-in-prompt'] } }
  const strongMock: EvalCase = { name: 'mock-strong', prompt: 'p', mock: { fault: 'F0' }, assert: { exit_code: 0, turn_end: 'completed' } }
  const weakMock: EvalCase = { name: 'mock-weak', prompt: 'p', mock: { fault: 'F0' }, assert: { turn_end: 'completed' } }

  it('needs mock sentinels iff the case set contains a mock case', () => {
    expect(needsMockSentinels([real])).toBe(false)
    expect(needsMockSentinels([])).toBe(false)
    expect(needsMockSentinels([real, strongMock])).toBe(true)
  })

  it('warns about weak subject cases only', () => {
    expect(weakCaseWarnings([real, strongMock, weakMock])).toEqual([{ name: 'mock-weak', reason: 'host-without-exit-and-turn-end' }])
  })
})

/** 本节用例：mock 用例的 prompt 不含任何期望串（mock 正文是固定的三节报告） */
const MOCK_A = 'name: mock-a\nprompt: "写报告"\ntags: [a]\nmock:\n  fault: F0\nassert:\n  turn_end: completed\n  exit_code: 0\n  output_contains: ["【P24】"]\n'
/** 弱 mock 用例：没声明 exit_code（host-without-exit-and-turn-end） */
const MOCK_B_WEAK = 'name: mock-b\nprompt: "写报告"\ntags: [b]\nmock:\n  fault: F0\nassert:\n  turn_end: completed\n  output_contains: ["【P24】"]\n'
const PLAIN = 'name: plain\nprompt: "p"\nassert:\n  turn_end: completed\n'

/**
 * 在临时用例目录上用 fake-dsh 探针跑一次：relay 把 mock 正文转述进 trace（S1 过、S2 不过，与真实
 * dsh 0.1.7-rc.2 同结论）；do-nothing 不连 mock。PROBE_MODE 经 process.env 传给子进程。
 */
async function withProbe<T>(
  mode: 'relay' | 'do-nothing',
  files: Record<string, string>,
  run: (dirs: { casesDir: string; outputDir: string; dshBin: string }) => Promise<T>,
): Promise<T> {
  if (/\s/.test(process.execPath) || /\s/.test(FAKE_DSH)) {
    throw new Error(`probe dshBin must not contain whitespace (splitDshBin splits on it): '${process.execPath}' '${FAKE_DSH}'`)
  }
  const root = await mkdtemp(join(tmpdir(), `eval-sentinel-${mode}-`))
  tempRoots.push(root)
  const casesDir = join(root, 'cases')
  await mkdir(casesDir)
  for (const [file, text] of Object.entries(files)) await writeFile(join(casesDir, file), text)
  const previous = process.env.PROBE_MODE
  process.env.PROBE_MODE = mode
  try {
    return await run({ casesDir, outputDir: join(root, 'out'), dshBin: `${process.execPath} ${FAKE_DSH}` })
  } finally {
    if (previous === undefined) delete process.env.PROBE_MODE
    else process.env.PROBE_MODE = previous
  }
}

async function runWithProbe(mode: 'relay' | 'do-nothing', files: Record<string, string>, extra: Partial<RunOptions> = {}): Promise<{ report: RunReport; outputDir: string }> {
  return withProbe(mode, files, async ({ casesDir, outputDir, dshBin }) => ({ report: await runEval({ casesDir, outputDir, dshBin, timeoutMs: 10_000, ...extra }), outputDir }))
}

/** .sessions 下哨兵的隔离目录名 */
const sentinelDirs = async (outputDir: string): Promise<string[]> => (await readdir(join(outputDir, '.sessions'))).filter((d) => d.startsWith('_sentinel-')).sort()

describe('runEval 注入哨兵', () => {
  it('a run with mock cases embeds S1/S2: healthy calibration, kept out of cases and summary', async () => {
    const { report, outputDir } = await runWithProbe('relay', { 'a.yml': MOCK_A, 'b.yml': MOCK_B_WEAK })

    expect(report.cases.map((c) => [c.name, c.status])).toEqual([
      ['mock-a', 'pass'],
      ['mock-b', 'pass'],
    ])
    expect(report.summary).toEqual({ total: 2, passed: 2, failed: 0, errored: 0 })
    expect(report.calibration?.healthy).toBe(true)
    expect(report.calibration?.skipped).toBeUndefined()
    expect(report.calibration?.sentinels.map(({ name, kind, expected, status, ok }) => ({ name, kind, expected, status, ok }))).toEqual([
      { name: 'sentinel-mock-echo', kind: 'must-pass', expected: 'pass', status: 'pass', ok: true },
      { name: 'sentinel-mock-impossible', kind: 'must-fail', expected: 'fail', status: 'fail', ok: true },
    ])
    // S2 不过的原因正是"内容没送全"（与真实 dsh 0.1.7-rc.2 的 failures 一致）
    expect(report.calibration?.sentinels[1]?.failures).toEqual(["turn_end: expected 'completed', got 'error'", "output_contains: final assistant text missing '【P24】'"])
    expect(report.calibration?.weakCases).toEqual([{ name: 'mock-b', reason: 'host-without-exit-and-turn-end' }])
    expect(await sentinelDirs(outputDir)).toEqual(['_sentinel-000-sentinel-mock-echo', '_sentinel-001-sentinel-mock-impossible'])

    // 落盘报告同样带 calibration；report.md 有健康行、哨兵明细与弱用例告警
    const onDisk = JSON.parse(await readFile(join(outputDir, 'report.json'), 'utf8')) as RunReport
    expect(onDisk.calibration).toEqual(report.calibration)
    const md = await readFile(join(outputDir, 'report.md'), 'utf8')
    expect(md).toContain('- 仪表健康：OK（哨兵 2/2 符合预期）')
    expect(md).toContain('- sentinel-mock-impossible（must-fail）：FAIL，符合预期')
    expect(md).toContain('- mock-b：host-without-exit-and-turn-end（mock 用例没有同时声明 exit_code 与 turn_end）')
    // 哨兵不进用例表
    expect(md).not.toMatch(/^\| sentinel-/m)
    expect(renderGateText(computeGate(null, report, false))).toContain('SENTINELS=ok')
  }, 30_000)

  it('sentinels run exactly once, whatever the global retries / trials', async () => {
    const { report, outputDir } = await runWithProbe('relay', { 'a.yml': MOCK_A }, { retries: 2, trials: 2 })
    expect(report.calibration?.healthy).toBe(true)
    expect(report.cases[0]?.attempts).toBe(2)
    for (const dir of await sentinelDirs(outputDir)) {
      expect(await readdir(join(outputDir, '.sessions', dir))).toEqual(['attempt-1'])
    }
  }, 30_000)

  it('tags / only filter the subject cases only; the sentinels still run', async () => {
    const files = { 'a.yml': MOCK_A, 'b.yml': MOCK_B_WEAK }
    const onlyA = (await runWithProbe('relay', files, { only: ['mock-a'] })).report
    expect(onlyA.cases.map((c) => c.name)).toEqual(['mock-a'])
    expect(onlyA.calibration?.sentinels.map((s) => s.name)).toEqual(SENTINEL_NAMES)
    expect(onlyA.calibration?.healthy).toBe(true)
    // 弱用例告警只看本次（筛选后）的 subject 用例
    expect(onlyA.calibration?.weakCases).toEqual([])

    const tagB = (await runWithProbe('relay', files, { tags: ['b'] })).report
    expect(tagB.cases.map((c) => c.name)).toEqual(['mock-b'])
    expect(tagB.calibration?.sentinels.map((s) => s.name)).toEqual(SENTINEL_NAMES)
    expect(tagB.calibration?.weakCases).toEqual([{ name: 'mock-b', reason: 'host-without-exit-and-turn-end' }])
  }, 30_000)

  it('a run without mock cases (after filtering) injects nothing and writes no calibration', async () => {
    const { report, outputDir } = await runWithProbe('do-nothing', { 'p.yml': PLAIN })
    expect(report.cases.map((c) => [c.name, c.status])).toEqual([['plain', 'pass']])
    expect(report.calibration).toBeUndefined()
    expect(await sentinelDirs(outputDir)).toEqual([])
    expect(await readFile(join(outputDir, 'report.md'), 'utf8')).not.toContain('仪表健康')
    expect(renderGateText(computeGate(null, report, false))).toContain('SENTINELS=absent')

    // 注入看筛选后的用例集：mock 用例被 only 筛掉，就不注入
    const filtered = await runWithProbe('do-nothing', { 'a.yml': MOCK_A, 'p.yml': PLAIN }, { only: ['plain'] })
    expect(filtered.report.calibration).toBeUndefined()
    expect(await sentinelDirs(filtered.outputDir)).toEqual([])
  }, 30_000)

  it('sentinels: false with mock cases records skipped (healthy false), runs no sentinel, and the gate FAILs', async () => {
    const { report, outputDir } = await runWithProbe('relay', { 'a.yml': MOCK_A }, { sentinels: false })
    expect(report.cases.map((c) => [c.name, c.status])).toEqual([['mock-a', 'pass']])
    expect(report.calibration).toEqual({ sentinels: [], healthy: false, skipped: true, weakCases: [] })
    expect(await sentinelDirs(outputDir)).toEqual([])
    expect(await readFile(join(outputDir, 'report.md'), 'utf8')).toContain('- 仪表健康：SKIPPED')

    const gate = computeGate(null, report, false)
    expect(gate.verdict).toBe('FAIL')
    expect(gate.exitCode).toBe(1)
    expect(gate.reasons[0]).toBe('sentinels skipped')
    expect(renderGateText(gate)).toContain('SENTINELS=skipped')
  }, 30_000)

  it('sentinels: false without mock cases writes no calibration (nothing to skip)', async () => {
    const { report } = await runWithProbe('do-nothing', { 'p.yml': PLAIN }, { sentinels: false })
    expect(report.calibration).toBeUndefined()
  }, 30_000)

  it('positive control: a dsh that never calls the mock but forges 【P24】 breaks both sentinels (delivery-missing) and the gate FAILs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eval-sentinel-forge-'))
    tempRoots.push(root)
    const header = '{"type":"session","version":0,"id":"s","createdAt":1,"cwd":"/x","delegationDepth":0}'
    const forged = '{"type":"assistant/message","seq":1,"time":1,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"【P01】伪造全文【P24】"}]}}}'
    const stepEnd = '{"type":"step/end","seq":2,"time":1,"data":{"turn":1,"step":1}}'
    const turnEnd = '{"type":"turn/end","seq":3,"time":1,"data":{"turn":1,"reason":{"kind":"completed"}}}'
    const fakeBin = join(root, 'fake-dsh-forge')
    await writeFile(
      fakeBin,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo 0.0.0-forge; exit 0; fi',
        'root=$(sed -n \'s/^    root: "\\(.*\\)"$/\\1/p\' "$4")',
        'dir="$root/case/session-forge"',
        'mkdir -p "$dir"',
        `printf '%s\\n' '${header}' '${forged}' '${stepEnd}' '${turnEnd}' > "$dir/session.jsonl"`,
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    const casesDir = join(root, 'cases')
    await mkdir(casesDir)
    await writeFile(join(casesDir, 'a.yml'), MOCK_A)
    const outputDir = join(root, 'out')
    const report = await runEval({ casesDir, outputDir, dshBin: fakeBin, timeoutMs: 10_000 })

    expect(report.calibration?.healthy).toBe(false)
    expect(report.calibration?.sentinels.map((s) => [s.name, s.status, s.ok])).toEqual([
      ['sentinel-mock-echo', 'error', false],
      ['sentinel-mock-impossible', 'error', false],
    ])
    for (const s of report.calibration?.sentinels ?? []) expect(s.error).toMatch(/^delivery-missing: expected fault F[01] on endpoint cc .*received 0 LLM request\(s\)$/)
    const md = await readFile(join(outputDir, 'report.md'), 'utf8')
    expect(md).toContain('- 仪表健康：BREACH（哨兵 0/2 符合预期）')
    expect(md).toContain('- sentinel-mock-echo（must-pass）：ERROR，**不符合预期**')

    // 即使与 baseline 完全一致，哨兵破照样 FAIL（不走增量）
    const gate = computeGate(report, report, false)
    expect(gate.verdict).toBe('FAIL')
    expect(gate.exitCode).toBe(1)
    expect(gate.reasons).toEqual([
      'sentinel breach: sentinel-mock-echo expected must-pass got error',
      'sentinel breach: sentinel-mock-impossible expected must-fail got error',
    ])
    expect(renderGateText(gate)).toContain('SENTINELS=breach')
  }, 30_000)
})

describe('eval_run 工具输出', () => {
  interface RegisteredTool {
    name: string
    execute: (args: Record<string, unknown>) => Promise<unknown>
  }

  /** 拿到 apply 注册的 eval_run（走 defineTool 的参数校验，与 dsh 调用工具同一入口） */
  const evalRunTool = (): RegisteredTool => {
    const tools: RegisteredTool[] = []
    apply({ tools: { register: (tool: RegisteredTool) => tools.push(tool) } } as unknown as Parameters<typeof apply>[0])
    const tool = tools.find((t) => t.name === 'eval_run')
    if (!tool) throw new Error('eval_run is not registered')
    return tool
  }

  const runTool = (mode: 'relay' | 'do-nothing', files: Record<string, string>): Promise<{ output: Record<string, unknown>; outputDir: string }> =>
    withProbe(mode, files, async ({ casesDir, outputDir, dshBin }) => {
      const text = await evalRunTool().execute({ cases_dir: casesDir, output_dir: outputDir, dsh_bin: dshBin, timeout_ms: 10_000 })
      return { output: JSON.parse(String(text)) as Record<string, unknown>, outputDir }
    })

  it('carries the calibration block right after summary when the run has mock cases', async () => {
    const { output, outputDir } = await runTool('relay', { 'a.yml': MOCK_A })
    expect(Object.keys(output)).toEqual(['summary', 'calibration', 'report_json', 'report_md', 'cases'])
    const onDisk = JSON.parse(await readFile(join(outputDir, 'report.json'), 'utf8')) as RunReport
    expect(output.calibration).toEqual(onDisk.calibration)
    expect((output.calibration as RunReport['calibration'])?.healthy).toBe(true)
  }, 30_000)

  it('has no calibration key when the run has no mock cases', async () => {
    const { output } = await runTool('do-nothing', { 'p.yml': PLAIN })
    expect(Object.keys(output)).toEqual(['summary', 'report_json', 'report_md', 'cases'])
  }, 30_000)
})
