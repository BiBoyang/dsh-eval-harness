import { fileURLToPath } from 'node:url'
import { assessAssertionStrength } from './strength.js'
import type { Calibration, CaseResult, EvalCase, SentinelKind, SentinelResult, SentinelsState, WeakCaseWarning } from './types.js'

/*
 * 内置哨兵：run 级仪表健康位（设计文档 docs/EVAL-HARDENING-DESIGN.md §5；P0 范围见
 * plans/TASK-p0-mock-sentinels.md）。
 *
 * - 哨兵是普通用例 yaml 加顶层键 `sentinel`（must-pass / must-fail），随包分发在
 *   cases/_sentinels/。loadCases 只读一层目录，不会把它们当成 subject 用例。
 * - 注入（P0）：本次（筛选后）用例集含 ≥1 条 mock 用例时跟着跑；不受 tags / only 筛选，
 *   单次 attempt、不重试，结果只写 report.calibration，不进 cases / summary。
 * - 判定：must-pass 要求 status=pass，must-fail 要求 status=fail，error 两种都不符合。
 *   任何一个哨兵不符合预期 → calibration.healthy=false → eval_gate 判 FAIL。
 *
 * 本模块只放纯函数：加载哨兵的 I/O 复用 runner 的 loadCases，避免 runner ↔ sentinel 循环依赖。
 */

/** 内置哨兵目录：src/ 与 lib/ 都在包根下一层，相对路径一致（package.json 的 files 含 cases） */
export const SENTINELS_DIR = fileURLToPath(new URL('../cases/_sentinels', import.meta.url))

/** 声明了 sentinel 种类的用例 */
export type SentinelCase = EvalCase & { sentinel: SentinelKind }

/** P0 注入规则：用例集含 ≥1 条 mock 用例才需要 mock 哨兵 */
export function needsMockSentinels(cases: readonly EvalCase[]): boolean {
  return cases.some((c) => c.mock !== undefined)
}

/**
 * 校验加载出的哨兵集：每条都声明 sentinel 种类，且都是 mock 用例（P0 只有 mock 哨兵，真实 API
 * 哨兵属 P1）。不合规 throw `eval_run:` 前缀错误——哨兵集坏了，这次 run 就无从校准。
 */
export function checkSentinelCases(cases: readonly { file: string; evalCase: EvalCase }[], dir: string): SentinelCase[] {
  return cases.map(({ file, evalCase }) => {
    const { sentinel } = evalCase
    if (sentinel === undefined) {
      throw new Error(`eval_run: sentinel file '${file}' in '${dir}' must declare 'sentinel: must-pass' or 'sentinel: must-fail'`)
    }
    if (evalCase.mock === undefined) {
      throw new Error(`eval_run: sentinel '${evalCase.name}' in '${dir}' must be a mock case (P0 runs mock sentinels only)`)
    }
    return { ...evalCase, sentinel }
  })
}

/** 哨兵种类对应的期望状态 */
export function expectedStatus(kind: SentinelKind): 'pass' | 'fail' {
  return kind === 'must-pass' ? 'pass' : 'fail'
}

/** 期望判定：status 等于期望才 ok。must-fail 的哨兵记了 error（如 delivery-missing）同样是破 */
export function judgeSentinel(kind: SentinelKind, result: Pick<CaseResult, 'name' | 'status' | 'error' | 'failures'>): SentinelResult {
  const expected = expectedStatus(kind)
  return {
    name: result.name,
    kind,
    expected,
    status: result.status,
    ...(result.error === undefined ? {} : { error: result.error }),
    ...(result.failures.length === 0 ? {} : { failures: result.failures }),
    ok: result.status === expected,
  }
}

/** 弱用例告警：本次 subject 用例里 assessAssertionStrength 判弱的（只告警，不影响判定） */
export function weakCaseWarnings(cases: readonly EvalCase[]): WeakCaseWarning[] {
  const warnings: WeakCaseWarning[] = []
  for (const c of cases) {
    const strength = assessAssertionStrength(c)
    if (!strength.strong) warnings.push({ name: c.name, reason: strength.reason })
  }
  return warnings
}

/** 组装 calibration：至少一个哨兵、且全部 ok 才 healthy */
export function buildCalibration(sentinels: SentinelResult[], weakCases: WeakCaseWarning[]): Calibration {
  return { sentinels, healthy: sentinels.length > 0 && sentinels.every((s) => s.ok), weakCases }
}

/** 关掉哨兵（RunOptions.sentinels === false）而用例集含 mock 用例：记跳过，不提供"跳过但放行"的组合 */
export function skippedCalibration(weakCases: WeakCaseWarning[]): Calibration {
  return { sentinels: [], healthy: false, skipped: true, weakCases }
}

/**
 * gate 与报告看到的仪表健康。fail-safe：healthy 标记与哨兵明细任何一边不健康都算 breach
 * （loadReport 拒绝两边不一致的报告，这里兜底直接构造的内存对象）。
 */
export function sentinelsState(calibration: Calibration | undefined): SentinelsState {
  if (calibration === undefined) return 'absent'
  if (calibration.skipped === true) return 'skipped'
  const allOk = calibration.sentinels.length > 0 && calibration.sentinels.every((s) => s.ok)
  return calibration.healthy && allOk ? 'ok' : 'breach'
}

/** gate 判 FAIL 的理由：skipped → `sentinels skipped`；breach → 每个不符合预期的哨兵一条 */
export function sentinelReasons(calibration: Calibration | undefined): string[] {
  const state = sentinelsState(calibration)
  if (state === 'skipped') return ['sentinels skipped']
  if (state !== 'breach' || calibration === undefined) return []
  const breaches = calibration.sentinels.filter((s) => !s.ok).map((s) => `sentinel breach: ${s.name} expected ${s.kind} got ${s.status}`)
  return breaches.length > 0 ? breaches : ['sentinel breach: calibration unhealthy']
}
