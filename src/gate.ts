import { readFile } from 'node:fs/promises'
import type { CaseResult, CaseStatus, GateDiff, GateReport, GateVerdict, RunReport } from './types.js'

/** gate 视角的归一化状态：error 按 fail 处理 */
function effective(status: CaseStatus): 'pass' | 'fail' {
  return status === 'pass' ? 'pass' : 'fail'
}

export function gateExitCode(verdict: GateVerdict, strict: boolean): number {
  switch (verdict) {
    case 'PASS':
      return 0
    case 'FAIL':
      return 1
    case 'N/A':
      return 2
    case 'WARN':
      return strict ? 2 : 0
  }
}

/**
 * 门禁判定：对比 baseline（before）与本次（after）报告。
 * 规则（优先级从高到低）：
 * - 有用例 PASS → FAIL/error → FAIL
 * - 新增用例即 FAIL/error → FAIL
 * - 有用例 FAIL/error → PASS，或用例数量变化（新增通过/移除）→ WARN
 * - 完全一致 → PASS
 * - before 为 null（无 baseline）→ N/A
 */
export function computeGate(before: RunReport | null, after: RunReport, strict: boolean): GateReport {
  const base: Omit<GateReport, 'verdict' | 'exitCode'> = {
    strict,
    reasons: [],
    regressions: [],
    newFailures: [],
    improvements: [],
    added: [],
    removed: [],
  }
  if (!before) {
    return { ...base, verdict: 'N/A', exitCode: gateExitCode('N/A', strict), reasons: ['no baseline report; gate not applicable'] }
  }

  const beforeMap = new Map(before.cases.map((c) => [c.name, c.status]))
  const afterMap = new Map(after.cases.map((c) => [c.name, c.status]))

  for (const [name, afterStatus] of afterMap) {
    const beforeStatus = beforeMap.get(name)
    const diff: GateDiff = { name, before: beforeStatus ?? 'absent', after: afterStatus }
    if (beforeStatus === undefined) {
      if (effective(afterStatus) === 'fail') base.newFailures.push(diff)
      else base.added.push(name)
    } else if (effective(beforeStatus) === 'pass' && effective(afterStatus) === 'fail') {
      base.regressions.push(diff)
    } else if (effective(beforeStatus) === 'fail' && effective(afterStatus) === 'pass') {
      base.improvements.push(diff)
    }
  }
  for (const name of beforeMap.keys()) {
    if (!afterMap.has(name)) base.removed.push(name)
  }

  let verdict: GateVerdict
  if (base.regressions.length > 0 || base.newFailures.length > 0) {
    verdict = 'FAIL'
    for (const d of base.regressions) base.reasons.push(`regression: ${d.name} pass -> ${d.after}`)
    for (const d of base.newFailures) base.reasons.push(`new failing case: ${d.name}`)
  } else if (base.improvements.length > 0 || base.added.length > 0 || base.removed.length > 0) {
    verdict = 'WARN'
    for (const d of base.improvements) base.reasons.push(`improvement: ${d.name} fail -> pass`)
    for (const n of base.added) base.reasons.push(`added passing case: ${n}`)
    for (const n of base.removed) base.reasons.push(`removed case: ${n}`)
  } else {
    verdict = 'PASS'
    base.reasons.push('all case results identical to baseline')
  }

  return { ...base, verdict, exitCode: gateExitCode(verdict, strict) }
}

/** gate 文本输出（key=value 行 + 明细行），供 CI grep */
export function renderGateText(report: GateReport): string {
  const lines = [
    `OVERALL=${report.verdict}`,
    `EXIT_CODE=${report.exitCode}`,
    `STRICT=${report.strict}`,
    `REGRESSIONS=${report.regressions.length}`,
    `NEW_FAILURES=${report.newFailures.length}`,
    `IMPROVEMENTS=${report.improvements.length}`,
    `ADDED=${report.added.length}`,
    `REMOVED=${report.removed.length}`,
  ]
  for (const r of report.reasons) lines.push(`REASON ${r}`)
  for (const d of report.regressions) lines.push(`REGRESSION ${d.name}: ${d.before} -> ${d.after}`)
  for (const d of report.newFailures) lines.push(`NEW_FAILURE ${d.name}: ${d.after}`)
  for (const d of report.improvements) lines.push(`IMPROVEMENT ${d.name}: ${d.before} -> ${d.after}`)
  return lines.join('\n')
}

/** gate JSON 输出（gate_json=true，单条 JSON 供 CI 解析） */
export function renderGateJson(report: GateReport): string {
  return JSON.stringify(report)
}

/**
 * 加载报告 JSON 文件。
 * - allowMissing=true 且文件不存在 → 返回 null（无 baseline → N/A）
 * - 其他读取/解析失败 → throw `eval_gate:` 前缀错误
 */
export async function loadReport(path: string, allowMissing = false): Promise<RunReport | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if (allowMissing && (err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`eval_gate: cannot read report '${path}': ${(err as Error).message}`)
  }
  try {
    const report = JSON.parse(text) as RunReport
    if (!Array.isArray(report.cases)) throw new Error("missing 'cases' array")
    return report
  } catch (err) {
    throw new Error(`eval_gate: invalid report '${path}': ${(err as Error).message}`)
  }
}

/** 供测试/工具复用：从 CaseResult 数组构造最小 RunReport */
export function summarize(cases: CaseResult[]): RunReport['summary'] {
  return {
    total: cases.length,
    passed: cases.filter((c) => c.status === 'pass').length,
    failed: cases.filter((c) => c.status === 'fail').length,
    errored: cases.filter((c) => c.status === 'error').length,
  }
}
