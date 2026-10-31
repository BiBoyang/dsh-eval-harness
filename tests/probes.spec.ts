import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { loadCases, runEval } from '../src/runner.ts'
import { assessAssertionStrength } from '../src/strength.ts'
import type { WeakReason } from '../src/strength.ts'
import type { EvalAssert, EvalCase, MockCaseConfig, RunReport } from '../src/types.ts'

/*
 * 棘轮白名单：两份名单都必须与实测「完全相等」，不是子集。新增弱用例会让测试变红；
 * 修好的用例也必须在同一个 PR 里从名单移除——名单永远等于真实状态。新增或修改
 * verifier、断言键、用例类别时，同步 docs/abc-checklist.md（PR 模板勾选项）。
 * 静态规则误判（期望串出现在 prompt 里、但语义上确实要执行才能得到）时，用例名留在
 * KNOWN_WEAK_CASES，并在该行旁写明理由；不许为了变绿改名单而不留理由。
 */

/**
 * parrot 探针在 cases/real 上能通过的用例：2026-10-30 实测 10/12；TASK-p0-case-hardening 给这 10 条
 * 补上 tool_result_contains 后为 0/12，名单应保持为空
 */
const KNOWN_PARROT_PASSABLE: readonly string[] = []

/** assessAssertionStrength 判弱的用例及原因（扫描范围见 caseDirs；初值 14 条，TASK-p0-case-hardening 后 4 条，cases/real 为 0） */
const KNOWN_WEAK_CASES: Readonly<Record<string, WeakReason>> = {
  // cases/example.case.yml：语法示例，不是被测用例（不在 cases/real 评测范围、没有 baseline），保留
  'echo-hello': 'answer-in-prompt',
  // cases/plugins/* 的 L2 冒烟：只断言 tools_called / exit_code / turn_end / max_steps。暂无可绑定的结果证据：
  // agent-teams、modlens 的本地 L2 报告（.eval/plugin-check-2026-09-26/）里工具结果文本是空串，routing-suite
  // 没有本地 L2 报告；疑似 collector 对非 text 结果块的提取缺口，单独排查后再加固，此前保留
  'agent-teams-smoke-status': 'no-outcome-assertion',
  'routing-suite-smoke-injected-list': 'no-outcome-assertion',
  'modlens-smoke-read-image': 'no-outcome-assertion',
}

const RATCHET_HINT =
  '棘轮白名单与实测不一致：新增弱用例 → 加固用例（静态误判才留白名单并写理由）；修好的用例 → 同一 PR 从白名单移除；两种情况都同步 docs/abc-checklist.md'

const CASES_DIR = fileURLToPath(new URL('../cases', import.meta.url))
const FAKE_DSH = fileURLToPath(new URL('./probes/fake-dsh.mjs', import.meta.url))

/** 静态检查的扫描范围：cases/、cases/real、cases/chaos、cases/plugins/*（loadCases 不递归，逐目录加载） */
async function caseDirs(): Promise<string[]> {
  const pluginsDir = join(CASES_DIR, 'plugins')
  const plugins = (await readdir(pluginsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(pluginsDir, entry.name))
    .sort()
  return [CASES_DIR, join(CASES_DIR, 'real'), join(CASES_DIR, 'chaos'), ...plugins]
}

/** 扫描目录下的全部用例，返回判弱的「用例名 → 原因」 */
async function scanWeakCases(dirs: readonly string[]): Promise<Record<string, WeakReason>> {
  const weak: [string, WeakReason][] = []
  const seen = new Map<string, string>()
  for (const dir of dirs) {
    for (const { file, evalCase } of await loadCases(dir)) {
      // 白名单按用例名记账；loadCases 只拒绝同目录重名，跨目录重名在这里拦
      const path = join(dir, file)
      const prev = seen.get(evalCase.name)
      if (prev !== undefined) throw new Error(`duplicate case name '${evalCase.name}' in '${prev}' and '${path}'`)
      seen.set(evalCase.name, path)
      const strength = assessAssertionStrength(evalCase)
      if (!strength.strong) weak.push([evalCase.name, strength.reason])
    }
  }
  return Object.fromEntries(weak)
}

const tempRoots: string[] = []
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * 用探针 agent 跑 runEval。dshBin 经 node 启动 fake-dsh（splitDshBin 按空白拆分，不依赖
 * 文件可执行位）；PROBE_MODE 经 process.env 传给子进程（--version 探针与真实 API 路径都继承）。
 */
async function runProbe(mode: 'do-nothing' | 'parrot', casesDir: string): Promise<RunReport> {
  if (/\s/.test(process.execPath) || /\s/.test(FAKE_DSH)) {
    throw new Error(`probe dshBin must not contain whitespace (splitDshBin splits on it): '${process.execPath}' '${FAKE_DSH}'`)
  }
  const root = await mkdtemp(join(tmpdir(), `eval-probe-${mode}-`))
  tempRoots.push(root)
  const previous = process.env.PROBE_MODE
  process.env.PROBE_MODE = mode
  try {
    return await runEval({ casesDir, outputDir: join(root, 'out'), dshBin: `${process.execPath} ${FAKE_DSH}`, timeoutMs: 10_000 })
  } finally {
    if (previous === undefined) delete process.env.PROBE_MODE
    else process.env.PROBE_MODE = previous
  }
}

const passedNames = (report: RunReport): string[] =>
  report.cases
    .filter((c) => c.status === 'pass')
    .map((c) => c.name)
    .sort()

/** error 证明不了断言拦住了谁（探针没跑起来时全是 error）：探针测试要求 error 为空 */
const erroredCases = (report: RunReport): string[] => report.cases.filter((c) => c.status === 'error').map((c) => `${c.name}: ${c.error}`)

describe('probe agents × cases/real', () => {
  it('do-nothing passes no case: every case fails on its assertions, none errors', async () => {
    const report = await runProbe('do-nothing', join(CASES_DIR, 'real'))
    expect(report.dshVersion).toBe('0.0.0-probe')
    expect(erroredCases(report)).toEqual([])
    expect(passedNames(report)).toEqual([])
  }, 30_000)

  it('parrot passes exactly KNOWN_PARROT_PASSABLE', async () => {
    const report = await runProbe('parrot', join(CASES_DIR, 'real'))
    expect(report.dshVersion).toBe('0.0.0-probe')
    expect(erroredCases(report)).toEqual([])
    expect(passedNames(report), RATCHET_HINT).toEqual([...KNOWN_PARROT_PASSABLE].sort())
  }, 30_000)
})

describe('assessAssertionStrength × cases/', () => {
  it('weak cases equal KNOWN_WEAK_CASES, reason by reason', async () => {
    const weak = await scanWeakCases(await caseDirs())
    expect(Object.keys(weak).sort(), RATCHET_HINT).toEqual(Object.keys(KNOWN_WEAK_CASES).sort())
    expect(weak).toEqual(KNOWN_WEAK_CASES)
  })

  it('KNOWN_PARROT_PASSABLE ⊆ static weak cases of cases/real', async () => {
    const realWeak = await scanWeakCases([join(CASES_DIR, 'real')])
    // parrot 能过、静态却判强 = 静态规则漏掉了一种放水方式
    expect(KNOWN_PARROT_PASSABLE.filter((name) => !Object.hasOwn(realWeak, name))).toEqual([])
  })
})

describe('assessAssertionStrength rules', () => {
  const PROMPT = '请用 bash 工具执行 `printf OK-7f3a`，把输出原样回复给我；最终回复里必须包含 OK-7f3a。'
  const realCase = (assert: EvalAssert): EvalCase => ({ name: 'real-case', prompt: PROMPT, assert })
  const mockCase = (assert: EvalAssert, mock: MockCaseConfig = { fault: 'F0' }): EvalCase => ({
    name: 'mock-case',
    prompt: '写一份三节分析报告。直接输出报告全文，不要调用任何工具。',
    mock,
    assert,
  })

  it('① tool_result_contains is an outcome signal even when its text is in the prompt', () => {
    expect(
      assessAssertionStrength(realCase({ tools_called: ['bash'], output_contains: ['OK-7f3a'], tool_result_contains: [{ name: 'bash', contains: 'OK-7f3a' }] })),
    ).toEqual({ strong: true, signal: 'tool_result_contains' })
    // 空串对任何结果（报错结果也一样）都成立，不算
    expect(assessAssertionStrength(realCase({ tools_called: ['bash'], tool_result_contains: [{ name: 'bash', contains: '' }] }))).toEqual({
      strong: false,
      reason: 'no-outcome-assertion',
    })
  })

  it('② tool_args_contains counts only when the expected string is not in the prompt', () => {
    expect(assessAssertionStrength(realCase({ output_contains: ['OK-7f3a'], tool_args_contains: [{ name: 'bash', contains: 'base64 -d' }] }))).toEqual({
      strong: true,
      signal: 'tool_args_contains',
    })
    // 期望串在 prompt 里：parrot 把整段 prompt 塞进参数即可命中
    expect(assessAssertionStrength(realCase({ tool_args_contains: [{ name: 'bash', contains: 'OK-7f3a' }] }))).toEqual({ strong: false, reason: 'answer-in-prompt' })
  })

  it('③ one output_contains string absent from the prompt is enough', () => {
    expect(assessAssertionStrength(realCase({ output_contains: ['OK-7f3a', 'derived-9d1c'] }))).toEqual({ strong: true, signal: 'output_contains' })
  })

  it('④ one output_matches regex that rejects the prompt is enough', () => {
    expect(assessAssertionStrength(realCase({ output_matches: ['OK-[0-9a-f]{4}', '^\\d+ bytes$'] }))).toEqual({ strong: true, signal: 'output_matches' })
    // 手工构造的非法正则证明不了任何结果，不算（parseCase 会在解析期拒绝它）
    expect(assessAssertionStrength(realCase({ output_matches: ['('] }))).toEqual({ strong: false, reason: 'answer-in-prompt' })
  })

  it('answer-in-prompt: every expected string can be parroted from the prompt; no_tool_errors does not help', () => {
    expect(
      assessAssertionStrength(
        realCase({
          turn_end: 'completed',
          tools_called: ['bash'],
          output_contains: ['OK-7f3a'],
          output_matches: ['OK-[0-9a-f]{4}'],
          tool_args_contains: [{ name: 'bash', contains: 'printf' }],
          no_tool_errors: true,
        }),
      ),
    ).toEqual({ strong: false, reason: 'answer-in-prompt' })
  })

  it('no-outcome-assertion: only tool names, terminal state and limits', () => {
    expect(
      assessAssertionStrength(
        realCase({
          turn_end: 'completed',
          exit_code: 0,
          tools_called: ['bash'],
          tools_exact: ['bash'],
          tools_not_called: ['write'],
          output_not_contains: ['抱歉'],
          max_steps: 6,
          max_tokens: 30000,
          no_tool_errors: true,
        }),
      ),
    ).toEqual({ strong: false, reason: 'no-outcome-assertion' })
  })

  it('mock case: exit_code + turn_end is strong', () => {
    expect(assessAssertionStrength(mockCase({ turn_end: 'max-tokens', exit_code: 1 }, { fault: 'F5', once: true }))).toEqual({
      strong: true,
      signal: 'host-exit-and-turn-end',
    })
  })

  it('mock case: missing exit_code or turn_end is weak, whatever the output assertions', () => {
    // 不在 prompt 里的 output_contains 足以让真实 API 用例判强；mock 用例只看宿主终态
    expect(assessAssertionStrength(mockCase({ turn_end: 'completed', output_contains: ['【P24】'] }))).toEqual({
      strong: false,
      reason: 'host-without-exit-and-turn-end',
    })
    expect(assessAssertionStrength(mockCase({ exit_code: 0, tool_result_contains: [{ name: 'bash', contains: 'x' }] }))).toEqual({
      strong: false,
      reason: 'host-without-exit-and-turn-end',
    })
  })
})
