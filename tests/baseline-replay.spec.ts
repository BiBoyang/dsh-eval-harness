import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkAssertions } from '../src/assert.ts'
import { loadReport } from '../src/gate.ts'
import { loadCases } from '../src/runner.ts'
import type { CaseResult, CollectedTrace, EvalCase } from '../src/types.ts'

/*
 * baseline 回放（D3 oracle 回放的种子）：baseline/report.json 是人工复核过的真实轨迹，其中 PASS
 * 的用例就是「已知正确解」。用它的轨迹字段构造 CollectedTrace，以 cases/real 当前的 assert 跑
 * checkAssertions，必须零失败——已知正确解必被 verifier 接受。期望串抄错、工具名写错、断言收得
 * 过紧，在这里就会变红，不必等真实 API 跑一轮。
 *
 * 回放范围是「baseline 里 PASS 的用例 ∩ cases/real 当前用例」（按 name 配对）。其余三种情况列为
 * todo、不判红：用例还没进 baseline（新增）；baseline 里的用例已不在 cases/real（删除 / 改名）；
 * 该用例在 baseline 里不是 PASS（不是已知正确解）。update-baseline.yml 刷新 baseline 之前先跑
 * pnpm test，这三种情况判红会让 baseline 刷新不了；用例缺席由 gate 判 FAIL（E7），baseline 能否
 * 收下非 PASS 用例由刷新 PR 的人工复核决定。期望串有意改写（如 dsh 升级改了工具文案）时回放必红，
 * 同样会挡住 update-baseline——口径变化须人工确认，是预期行为。
 *
 * 只重放 checkAssertions 判的断言：output_judge 要调真实 judge；runner 层的 error 判定（超时、
 * 无 session 日志、未声明的非零退出）是录制时的事实。baseline 只读，只能由 update-baseline 刷新。
 */

const BASELINE = fileURLToPath(new URL('../baseline/report.json', import.meta.url))
const REAL_CASES_DIR = fileURLToPath(new URL('../cases/real', import.meta.url))

/** 报告里一条用例的轨迹字段 → CollectedTrace（runner traceFields 的逆；顶层字段是最后一次 attempt 的投影） */
function traceOf(result: CaseResult): CollectedTrace {
  return {
    turnEnd: result.turnEnd,
    toolsCalled: result.toolsCalled,
    toolCalls: result.toolCalls,
    toolResults: result.toolResults,
    finalText: result.finalText,
    steps: result.steps,
    tokens: result.tokens,
    toolErrors: result.toolErrors,
    events: result.events,
    skippedLines: result.skippedLines,
  }
}

// 每条用例展开成一个测试，收集阶段就要拿到数据，故用顶层 await；baseline 缺失或不合法时
// loadReport 抛错，整个文件加载失败，同样是红
const baseline = await loadReport(BASELINE)
if (baseline === null) throw new Error(`baseline report missing: '${BASELINE}'`)
const current = new Map((await loadCases(REAL_CASES_DIR)).map(({ evalCase }): [string, EvalCase] => [evalCase.name, evalCase]))
const baselineNames = new Set(baseline.cases.map((c) => c.name))

const replays = baseline.cases.flatMap((result) => {
  const evalCase = current.get(result.name)
  return result.status === 'pass' && evalCase !== undefined ? [{ result, evalCase }] : []
})
const notReplayed = [
  ...[...current.keys()].filter((name) => !baselineNames.has(name)).map((name) => `${name} is not in the baseline yet (new case; replayed after update-baseline)`),
  ...baseline.cases.filter((c) => !current.has(c.name)).map((c) => `${c.name} is in the baseline but gone from cases/real (deleted or renamed)`),
  ...baseline.cases.filter((c) => c.status !== 'pass' && current.has(c.name)).map((c) => `${c.name} is ${c.status} in the baseline (not a known-correct trajectory)`),
]

describe('baseline replay × cases/real', () => {
  it('replays at least one baseline trajectory', () => {
    // 配对全部落空（如批量改名）时，下面的逐条回放会空转成绿
    expect(replays.length).toBeGreaterThan(0)
  })

  for (const { result, evalCase } of replays) {
    it(`${result.name}: current assertions accept the baseline trajectory`, () => {
      expect(checkAssertions(evalCase.assert, traceOf(result), { exitCode: result.exitCode })).toEqual([])
    })
  }

  for (const reason of notReplayed) it.todo(`not replayed: ${reason}`)
})
