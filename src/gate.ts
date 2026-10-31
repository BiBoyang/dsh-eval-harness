import { readFile } from 'node:fs/promises'
import { aggregateErrorSignatures, REPEATED_SIGNATURE_THRESHOLD } from './error-signature.js'
import { wilsonLowerBoundOneSided95 } from './reliability.js'
import { expectedStatus, sentinelReasons, sentinelsState } from './sentinel.js'
import type { WeakReason } from './strength.js'
import type { AttemptResult, Calibration, CaseReliability, CaseResult, CaseStatus, GateDiff, GateReport, GateTokenDiff, GateUnreliableCase, GateVerdict, RunReport, SentinelResult, TokenUsage, WeakCaseWarning } from './types.js'
import { CURRENT_REPORT_SCHEMA_VERSION } from './types.js'

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

/** gate 阈值选项 */
export interface GateOptions {
  /**
   * token total（input+output+reasoning，与 max_tokens 同口径）涨幅上限百分比：
   * 状态不变的用例超过该涨幅记 token 回归（WARN）。默认 50；0 关闭。
   */
  maxTokenIncreasePct?: number
  /**
   * trials 可靠性门槛（0-1，缺省关闭）：带 reliability 的用例若 successRate 的
   * 单侧 95% Wilson 下界低于该值，记 WARN。判下界不判点估计——「成功率不低于
   * 阈值」是单侧问题；默认关闭以保留「trials 只测量不门禁」的语义。
   */
  minTrialSuccessRate?: number
}

/** 默认 token 涨幅阈值（百分比）；0 = 关闭 token 回归检测 */
export const DEFAULT_MAX_TOKEN_INCREASE_PCT = 50

/**
 * 门禁判定：对比 baseline（before）与本次（after）报告。
 * 规则（优先级从高到低）：
 * - after 报告带 calibration 且不健康（哨兵破 / 被跳过）→ FAIL。哨兵每次独立判，不与 baseline
 *   比，没有 baseline 也判 FAIL（P0 以 FAIL 落地，P1 改 INVALID）；没有 calibration 的报告不受影响
 * - 有用例 PASS → FAIL/error → FAIL
 * - 新增用例即 FAIL/error → FAIL
 * - baseline 有、本次缺席的用例 → FAIL（E7：缺席没有证据，不能当作通过；删用例须同 PR 刷新 baseline）
 * - 有用例 FAIL/error → PASS，或新增通过用例 → WARN
 * - 状态不变但 token total 涨幅超阈值（默认 +50%）→ WARN
 * - skippedLines 较 baseline 增长（trace 解析漏帧增多）→ WARN
 * - 新增 flaky 用例（较 baseline 增多；baseline 已有的不重复告警）→ WARN
 * - pass 但带工具硬错误的用例较 baseline 新增（agent 自我纠正了工具错误）→ WARN
 * - 同一 stderr 错误签名出现 >= 2 次（崩在同一处，疑似共享态事故）→ WARN
 * - 开启 minTrialSuccessRate 时：trials 用例的 successRate 单侧 95% Wilson 下界低于阈值 → WARN
 *   （尺子的读数进门禁；默认关闭，保留「trials 只测量」语义）
 * - dsh 版本较 baseline 变化 → 仅 informational reason，不影响判定（跨版本结果不可直接比，
 *   但版本切换是高频合法事件，WARN 要留给「证据表明有问题」）
 * - 完全一致 → PASS
 * - before 为 null（无 baseline）→ N/A
 */
export function computeGate(before: RunReport | null, after: RunReport, strict: boolean, options: GateOptions = {}): GateReport {
  const maxTokenIncreasePct = options.maxTokenIncreasePct ?? DEFAULT_MAX_TOKEN_INCREASE_PCT
  const base: Omit<GateReport, 'verdict' | 'exitCode'> = {
    strict,
    reasons: [],
    regressions: [],
    newFailures: [],
    improvements: [],
    added: [],
    removed: [],
    tokenRegressions: [],
    skippedLineIncreases: [],
    flakyCases: [],
    baselineFlakyCases: [],
    toolErrorRecoveries: [],
    repeatedErrorSignatures: [],
    unreliableCases: [],
    sentinels: sentinelsState(after.calibration),
  }
  // 哨兵破是「仪表坏了」的直接证据，整份报告的结论都不可信——不走「较 baseline 增多」的增量口径
  const sentinelFailures = sentinelReasons(after.calibration)
  if (!before) {
    if (sentinelFailures.length > 0) {
      return { ...base, verdict: 'FAIL', exitCode: gateExitCode('FAIL', strict), reasons: [...sentinelFailures, 'no baseline report; case comparison not applicable'] }
    }
    return { ...base, verdict: 'N/A', exitCode: gateExitCode('N/A', strict), reasons: ['no baseline report; gate not applicable'] }
  }

  const beforeMap = new Map(before.cases.map((c) => [c.name, c]))
  const afterMap = new Map(after.cases.map((c) => [c.name, c]))

  for (const [name, afterCase] of afterMap) {
    const beforeCase = beforeMap.get(name)
    const afterStatus = afterCase.status
    const diff: GateDiff = { name, before: beforeCase?.status ?? 'absent', after: afterStatus }
    if (beforeCase === undefined) {
      if (effective(afterStatus) === 'fail') base.newFailures.push(diff)
      else base.added.push(name)
    } else if (effective(beforeCase.status) === 'pass' && effective(afterStatus) === 'fail') {
      base.regressions.push(diff)
    } else if (effective(beforeCase.status) === 'fail' && effective(afterStatus) === 'pass') {
      base.improvements.push(diff)
    }
    // token 回归：状态不变（fail→fail 也算；fail→error 等变化不算）且两侧都有有效
    // total 时比涨幅；before.total 为 0 无法定义涨幅，跳过
    if (
      beforeCase !== undefined &&
      beforeCase.status === afterStatus &&
      maxTokenIncreasePct > 0 &&
      beforeCase.tokens.total > 0 &&
      afterCase.tokens.total > beforeCase.tokens.total * (1 + maxTokenIncreasePct / 100)
    ) {
      const tokenDiff: GateTokenDiff = {
        name,
        before: beforeCase.tokens.total,
        after: afterCase.tokens.total,
        increasePct: Math.round(((afterCase.tokens.total - beforeCase.tokens.total) / beforeCase.tokens.total) * 100),
      }
      base.tokenRegressions.push(tokenDiff)
    }
    // skippedLines 增长：trace 解析漏帧增多，断言可能基于残缺数据通过——与状态/token
    // 无关，只要较 baseline 增多就提示排查 collector 或 dsh 落盘格式变化
    if (beforeCase !== undefined && afterCase.skippedLines > beforeCase.skippedLines) {
      base.skippedLineIncreases.push({ name, before: beforeCase.skippedLines, after: afterCase.skippedLines })
    }
  }
  for (const name of beforeMap.keys()) {
    if (!afterMap.has(name)) base.removed.push(name)
  }

  // flaky：较 baseline 增多才告警——baseline 里已知的抖动用例不重复 WARN（告警疲劳会把
  // WARN 信号磨平）；代价是新 flaky 若被收编进 baseline 就会哑掉，故另有
  // baselineFlakyCases 提示约束「flaky 不收编进 baseline」。
  const beforeFlaky = new Set(before.cases.filter((c) => c.flaky === true).map((c) => c.name))
  base.flakyCases = after.cases.filter((c) => c.flaky === true && !beforeFlaky.has(c.name)).map((c) => c.name)
  base.baselineFlakyCases = before.cases.filter((c) => c.flaky === true).map((c) => c.name)
  // 工具错误自我纠正：pass 但 toolErrors 非空，说明 agent 吞掉/绕过了工具硬错误——
  // 最终文本可能完全正常，但链路并不干净。同样按较 baseline 增多告警。
  const recovered = (c: CaseResult): boolean => c.status === 'pass' && c.toolErrors.length > 0
  const beforeRecovered = new Set(before.cases.filter(recovered).map((c) => c.name))
  base.toolErrorRecoveries = after.cases.filter((c) => recovered(c) && !beforeRecovered.has(c.name)).map((c) => c.name)
  // 同一 stderr 签名跨用例/跨 attempt 反复出现：大概率不是用例的问题，而是共享态
  // （上游并发竞态、环境损坏）。接受与 flaky 信号对同一事故「双倍计票」——
  // flaky 说「有抖动」，签名聚合说「抖在同一处，去查共享态」。
  base.repeatedErrorSignatures = aggregateErrorSignatures(after).filter((g) => g.occurrences >= REPEATED_SIGNATURE_THRESHOLD)
  // 可靠性门禁（默认关闭）：尺子的读数只有被门禁消费才不是摆设。判 Wilson 下界
  // 不判点估计——10 次过 9 次的点估计 0.9，单侧 95% 下界只有约 0.65，小样本不配谈达标
  const minTrialSuccessRate = options.minTrialSuccessRate
  if (minTrialSuccessRate !== undefined) {
    if (!Number.isFinite(minTrialSuccessRate) || minTrialSuccessRate < 0 || minTrialSuccessRate > 1) {
      throw new Error(`eval_gate: min_trial_success_rate must be in [0, 1], got ${minTrialSuccessRate}`)
    }
    for (const c of after.cases) {
      if (c.reliability === undefined) continue
      const lowerBound = wilsonLowerBoundOneSided95(c.reliability.passes, c.reliability.trials)
      if (lowerBound < minTrialSuccessRate) {
        const entry: GateUnreliableCase = { name: c.name, successRate: c.reliability.successRate, lowerBound, trials: c.reliability.trials }
        base.unreliableCases.push(entry)
      }
    }
  }
  if (before.dshVersion !== undefined && after.dshVersion !== undefined && before.dshVersion !== after.dshVersion) {
    base.dshVersionChange = { before: before.dshVersion, after: after.dshVersion }
  }

  let verdict: GateVerdict
  if (sentinelFailures.length > 0 || base.regressions.length > 0 || base.newFailures.length > 0 || base.removed.length > 0) {
    verdict = 'FAIL'
    base.reasons.push(...sentinelFailures)
    for (const d of base.regressions) base.reasons.push(`regression: ${d.name} pass -> ${d.after}`)
    for (const d of base.newFailures) base.reasons.push(`new failing case: ${d.name}`)
    // E7：缺席不是通过——baseline 里的用例本次没有结果，就没有它仍然通过的证据
    for (const n of base.removed) base.reasons.push(`missing case: ${n} (in baseline, absent from current report)`)
  } else if (
    base.improvements.length > 0 ||
    base.added.length > 0 ||
    base.tokenRegressions.length > 0 ||
    base.skippedLineIncreases.length > 0 ||
    base.flakyCases.length > 0 ||
    base.toolErrorRecoveries.length > 0 ||
    base.repeatedErrorSignatures.length > 0 ||
    base.unreliableCases.length > 0
  ) {
    verdict = 'WARN'
    for (const d of base.improvements) base.reasons.push(`improvement: ${d.name} fail -> pass`)
    for (const n of base.added) base.reasons.push(`added passing case: ${n}`)
  } else {
    verdict = 'PASS'
    base.reasons.push('all case results identical to baseline')
  }
  for (const d of base.tokenRegressions) {
    base.reasons.push(`token regression: ${d.name} total ${d.before} -> ${d.after} (+${d.increasePct}%)`)
  }
  for (const d of base.skippedLineIncreases) {
    base.reasons.push(`skipped lines increase: ${d.name} ${d.before} -> ${d.after}`)
  }
  for (const n of base.flakyCases) {
    base.reasons.push(`new flaky case: ${n} (passed only after retry; investigate the first-attempt failure)`)
  }
  for (const n of base.toolErrorRecoveries) {
    base.reasons.push(`tool error recovered: ${n} (pass with tool hard error(s) the agent worked around)`)
  }
  for (const g of base.repeatedErrorSignatures) {
    base.reasons.push(`repeated error signature: ${g.signature} x${g.occurrences} across [${g.cases.join(', ')}] (shared-state suspect)`)
  }
  for (const u of base.unreliableCases) {
    base.reasons.push(`unreliable case: ${u.name} successRate ${u.successRate.toFixed(2)} (Wilson lower ${u.lowerBound.toFixed(2)}, n=${u.trials}) below gate threshold`)
  }
  // informational：不影响判定。版本切换是高频合法事件，但跨版本结果不可直接比，
  // 且升版后首跑是上游共享态重建（如 profile 目录 heal）的高危时刻，必须留痕。
  if (base.dshVersionChange !== undefined) {
    base.reasons.push(`dsh version changed: ${base.dshVersionChange.before} -> ${base.dshVersionChange.after} (results not directly comparable)`)
  }
  if (base.baselineFlakyCases.length > 0) {
    base.reasons.push(`baseline contains ${base.baselineFlakyCases.length} flaky case(s): [${base.baselineFlakyCases.join(', ')}] (do not accept flaky cases into baseline)`)
  }

  return { ...base, verdict, exitCode: gateExitCode(verdict, strict) }
}

/** gate 文本输出（key=value 行 + 明细行），供 CI grep */
export function renderGateText(report: GateReport): string {
  const lines = [
    `OVERALL=${report.verdict}`,
    `EXIT_CODE=${report.exitCode}`,
    `STRICT=${report.strict}`,
    `SENTINELS=${report.sentinels}`,
    `REGRESSIONS=${report.regressions.length}`,
    `NEW_FAILURES=${report.newFailures.length}`,
    `IMPROVEMENTS=${report.improvements.length}`,
    `ADDED=${report.added.length}`,
    `REMOVED=${report.removed.length}`,
    `TOKEN_REGRESSIONS=${report.tokenRegressions.length}`,
    `SKIPPED_LINE_INCREASES=${report.skippedLineIncreases.length}`,
    `FLAKY=${report.flakyCases.length}`,
    `TOOL_ERROR_RECOVERIES=${report.toolErrorRecoveries.length}`,
    `REPEATED_ERROR_SIGNATURES=${report.repeatedErrorSignatures.length}`,
    `BASELINE_FLAKY=${report.baselineFlakyCases.length}`,
    `UNRELIABLE=${report.unreliableCases.length}`,
    ...(report.dshVersionChange === undefined ? [] : [`DSH_VERSION_CHANGED=${report.dshVersionChange.before} -> ${report.dshVersionChange.after}`]),
  ]
  for (const r of report.reasons) lines.push(`REASON ${r}`)
  for (const d of report.regressions) lines.push(`REGRESSION ${d.name}: ${d.before} -> ${d.after}`)
  for (const d of report.newFailures) lines.push(`NEW_FAILURE ${d.name}: ${d.after}`)
  for (const d of report.improvements) lines.push(`IMPROVEMENT ${d.name}: ${d.before} -> ${d.after}`)
  for (const d of report.tokenRegressions) lines.push(`TOKEN_REGRESSION ${d.name}: total ${d.before} -> ${d.after} (+${d.increasePct}%)`)
  for (const d of report.skippedLineIncreases) lines.push(`SKIPPED_LINE_INCREASE ${d.name}: ${d.before} -> ${d.after}`)
  for (const n of report.flakyCases) lines.push(`FLAKY_CASE ${n}`)
  for (const n of report.toolErrorRecoveries) lines.push(`TOOL_ERROR_RECOVERY ${n}`)
  for (const g of report.repeatedErrorSignatures) lines.push(`ERROR_SIGNATURE ${g.signature}: x${g.occurrences} across [${g.cases.join(', ')}]`)
  for (const u of report.unreliableCases) lines.push(`UNRELIABLE_CASE ${u.name}: successRate ${u.successRate.toFixed(2)} (Wilson lower ${u.lowerBound.toFixed(2)}, n=${u.trials})`)
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
    return normalizeReport(JSON.parse(text), path)
  } catch (err) {
    throw new Error(`eval_gate: invalid report '${path}': ${(err as Error).message}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function failReport(_path: string, message: string): never {
  throw new Error(message)
}

function requiredString(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') failReport(path, `${field} must be a non-empty string`)
  return value
}

function validDate(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

function nonNegativeNumber(value: unknown, field: string, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    failReport(path, `${field} must be a finite non-negative number`)
  }
  return value
}

function nonNegativeInteger(value: unknown, field: string, path: string): number {
  const n = nonNegativeNumber(value, field, path)
  if (!Number.isInteger(n)) failReport(path, `${field} must be a non-negative integer`)
  return n
}

function positiveInteger(value: unknown, field: string, path: string): number {
  const n = nonNegativeInteger(value, field, path)
  if (n < 1) failReport(path, `${field} must be a positive integer`)
  return n
}

function stringArray(value: unknown, field: string, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    failReport(path, `${field} must be an array of strings`)
  }
  return value as string[]
}

function validateTokens(value: unknown, path: string): TokenUsage {
  if (!isRecord(value)) failReport(path, 'tokens must be a mapping')
  return {
    input: nonNegativeNumber(value.input, 'tokens.input', path),
    output: nonNegativeNumber(value.output, 'tokens.output', path),
    cacheRead: nonNegativeNumber(value.cacheRead, 'tokens.cacheRead', path),
    cacheWrite: nonNegativeNumber(value.cacheWrite, 'tokens.cacheWrite', path),
    reasoning: nonNegativeNumber(value.reasoning, 'tokens.reasoning', path),
    total: nonNegativeNumber(value.total, 'tokens.total', path),
  }
}

function normalizeAttempt(value: unknown, index: number, path: string): AttemptResult {
  if (!isRecord(value)) failReport(path, `attemptResults[${index}] must be a mapping`)
  const status = value.status
  if (status !== 'pass' && status !== 'fail' && status !== 'error') failReport(path, `attemptResults[${index}].status must be one of pass, fail, error`)
  if (value.error !== undefined && typeof value.error !== 'string') failReport(path, `attemptResults[${index}].error must be a string`)
  if (value.turnEnd !== undefined && typeof value.turnEnd !== 'string') failReport(path, `attemptResults[${index}].turnEnd must be a string`)
  if (value.exitCode !== undefined && value.exitCode !== null && (typeof value.exitCode !== 'number' || !Number.isInteger(value.exitCode) || value.exitCode < 0)) failReport(path, `attemptResults[${index}].exitCode must be a non-negative integer or null`)
  if (value.timedOut !== undefined && typeof value.timedOut !== 'boolean') failReport(path, `attemptResults[${index}].timedOut must be a boolean`)
  if (value.stderrTail !== undefined && typeof value.stderrTail !== 'string') failReport(path, `attemptResults[${index}].stderrTail must be a string`)
  return {
    index: positiveInteger(value.index, `attemptResults[${index}].index`, path),
    status,
    failures: stringArray(value.failures, `attemptResults[${index}].failures`, path),
    ...(value.error === undefined ? {} : { error: value.error as string }),
    ...(value.turnEnd === undefined ? {} : { turnEnd: value.turnEnd as string }),
    toolsCalled: stringArray(value.toolsCalled, `attemptResults[${index}].toolsCalled`, path),
    toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls as AttemptResult['toolCalls'] : failReport(path, `attemptResults[${index}].toolCalls must be an array`),
    toolResults: Array.isArray(value.toolResults) ? value.toolResults as AttemptResult['toolResults'] : failReport(path, `attemptResults[${index}].toolResults must be an array`),
    finalText: typeof value.finalText === 'string' ? value.finalText : failReport(path, `attemptResults[${index}].finalText must be a string`),
    steps: nonNegativeInteger(value.steps, `attemptResults[${index}].steps`, path),
    tokens: validateTokens(value.tokens, path),
    toolErrors: Array.isArray(value.toolErrors) ? value.toolErrors as AttemptResult['toolErrors'] : failReport(path, `attemptResults[${index}].toolErrors must be an array`),
    events: nonNegativeInteger(value.events, `attemptResults[${index}].events`, path),
    skippedLines: nonNegativeInteger(value.skippedLines, `attemptResults[${index}].skippedLines`, path),
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number | null }),
    ...(value.timedOut === undefined ? {} : { timedOut: value.timedOut as boolean }),
    ...(value.stderrTail === undefined ? {} : { stderrTail: value.stderrTail as string }),
    durationMs: nonNegativeNumber(value.durationMs, `attemptResults[${index}].durationMs`, path),
  }
}

function syntheticAttempt(value: Record<string, unknown>, status: CaseStatus, path: string): AttemptResult {
  return {
    index: 1,
    status,
    failures: value.failures as string[],
    ...(value.error === undefined ? {} : { error: value.error as string }),
    ...(value.turnEnd === undefined ? {} : { turnEnd: value.turnEnd as string }),
    toolsCalled: value.toolsCalled as string[],
    toolCalls: value.toolCalls as AttemptResult['toolCalls'],
    toolResults: value.toolResults as AttemptResult['toolResults'],
    finalText: value.finalText as string,
    steps: value.steps as number,
    tokens: validateTokens(value.tokens, path),
    toolErrors: value.toolErrors as AttemptResult['toolErrors'],
    events: value.events === undefined ? 0 : value.events as number,
    skippedLines: value.skippedLines === undefined ? 0 : value.skippedLines as number,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number | null }),
    ...(value.timedOut === undefined ? {} : { timedOut: value.timedOut as boolean }),
    ...(value.stderrTail === undefined ? {} : { stderrTail: value.stderrTail as string }),
    durationMs: value.durationMs as number,
  }
}

function normalizeReliability(value: unknown, path: string): CaseReliability {
  if (!isRecord(value)) failReport(path, 'reliability must be a mapping')
  const trials = positiveInteger(value.trials, 'reliability.trials', path)
  const passes = nonNegativeInteger(value.passes, 'reliability.passes', path)
  if (passes > trials) failReport(path, 'reliability.passes must not exceed trials')
  const k = positiveInteger(value.k, 'reliability.k', path)
  const rate = (key: 'successRate' | 'passAtK' | 'passPowK'): number => {
    const v = value[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) failReport(path, `reliability.${key} must be a number in [0, 1]`)
    return v
  }
  return { trials, passes, successRate: rate('successRate'), passAtK: rate('passAtK'), passPowK: rate('passPowK'), k }
}

function normalizeCase(value: unknown, index: number, schemaVersion: 0 | 1, path: string): CaseResult {
  if (!isRecord(value)) failReport(path, `cases[${index}] must be a mapping`)
  const name = requiredString(value.name, `cases[${index}].name`, path)
  const status = value.status
  if (status !== 'pass' && status !== 'fail' && status !== 'error') {
    failReport(path, `cases[${index}].status must be one of pass, fail, error`)
  }
  const failures = stringArray(value.failures, `cases[${index}].failures`, path)
  const toolsCalled = stringArray(value.toolsCalled, `cases[${index}].toolsCalled`, path)
  if (!Array.isArray(value.toolCalls)) failReport(path, `cases[${index}].toolCalls must be an array`)
  if (!Array.isArray(value.toolResults)) failReport(path, `cases[${index}].toolResults must be an array`)
  if (!Array.isArray(value.toolErrors)) failReport(path, `cases[${index}].toolErrors must be an array`)
  if (typeof value.finalText !== 'string') failReport(path, `cases[${index}].finalText must be a string`)
  const finalText = value.finalText
  const steps = nonNegativeInteger(value.steps, `cases[${index}].steps`, path)
  const durationMs = nonNegativeNumber(value.durationMs, `cases[${index}].durationMs`, path)
  const declaredAttempts = value.attempts === undefined ? 1 : positiveInteger(value.attempts, `cases[${index}].attempts`, path)
  const events = schemaVersion === 0 ? value.events === undefined ? 0 : nonNegativeInteger(value.events, `cases[${index}].events`, path) : nonNegativeInteger(value.events, `cases[${index}].events`, path)
  const skippedLines = schemaVersion === 0 ? value.skippedLines === undefined ? 0 : nonNegativeInteger(value.skippedLines, `cases[${index}].skippedLines`, path) : nonNegativeInteger(value.skippedLines, `cases[${index}].skippedLines`, path)
  const hasAttemptHistory = value.attemptResults !== undefined
  const attemptResults = !hasAttemptHistory
    ? [syntheticAttempt(value, status, path)]
    : (() => {
        if (!Array.isArray(value.attemptResults)) failReport(path, `cases[${index}].attemptResults must be an array`)
        return value.attemptResults.map((attempt, attemptIndex) => normalizeAttempt(attempt, attemptIndex, path))
      })()
  // Legacy reports may know that retries happened without preserving the
  // per-attempt data. Keep one honest synthetic attempt instead of fabricating history.
  const attempts = hasAttemptHistory ? declaredAttempts : 1
  if (attemptResults.length !== attempts) failReport(path, `cases[${index}].attempts must equal attemptResults.length`)
  for (let i = 0; i < attemptResults.length; i++) {
    const attempt = attemptResults[i]
    if (!attempt || attempt.index !== i + 1) failReport(path, `cases[${index}].attemptResults indices must be consecutive starting at 1`)
  }
  const lastAttempt = attemptResults[attemptResults.length - 1]
  if (!lastAttempt || lastAttempt.status !== status) failReport(path, `cases[${index}].attemptResults last status must equal case status`)

  if (value.error !== undefined && typeof value.error !== 'string') failReport(path, `cases[${index}].error must be a string`)
  if (value.turnEnd !== undefined && typeof value.turnEnd !== 'string') failReport(path, `cases[${index}].turnEnd must be a string`)
  const exitCode = value.exitCode
  if (exitCode !== undefined && exitCode !== null && (typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0)) {
    failReport(path, `cases[${index}].exitCode must be a non-negative integer or null`)
  }
  if (value.timedOut !== undefined && typeof value.timedOut !== 'boolean') failReport(path, `cases[${index}].timedOut must be a boolean`)
  if (value.stderrTail !== undefined && typeof value.stderrTail !== 'string') failReport(path, `cases[${index}].stderrTail must be a string`)
  if (value.flaky !== undefined && typeof value.flaky !== 'boolean') failReport(path, `cases[${index}].flaky must be a boolean`)

  return {
    name,
    status,
    failures,
    ...(value.error === undefined ? {} : { error: value.error as string }),
    ...(value.turnEnd === undefined ? {} : { turnEnd: value.turnEnd as string }),
    toolsCalled,
    toolCalls: value.toolCalls as CaseResult['toolCalls'],
    toolResults: value.toolResults as CaseResult['toolResults'],
    finalText,
    steps,
    tokens: validateTokens(value.tokens, path),
    toolErrors: value.toolErrors as CaseResult['toolErrors'],
    events,
    skippedLines,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number | null }),
    ...(value.timedOut === undefined ? {} : { timedOut: value.timedOut as boolean }),
    ...(value.stderrTail === undefined ? {} : { stderrTail: value.stderrTail as string }),
    durationMs,
    attempts,
    attemptResults,
    ...(value.flaky !== undefined && hasAttemptHistory ? { flaky: value.flaky as boolean } : {}),
    ...(value.reliability === undefined ? {} : { reliability: normalizeReliability(value.reliability, path) }),
  }
}

/** WeakReason 全集：Record 让它与 strength.ts 的联合类型一一对应（增删原因时编译期报错） */
const WEAK_REASONS: Record<WeakReason, true> = { 'host-without-exit-and-turn-end': true, 'answer-in-prompt': true, 'no-outcome-assertion': true }

function normalizeSentinel(value: unknown, index: number, path: string): SentinelResult {
  const field = `calibration.sentinels[${index}]`
  if (!isRecord(value)) failReport(path, `${field} must be a mapping`)
  const name = requiredString(value.name, `${field}.name`, path)
  const kind = value.kind
  if (kind !== 'must-pass' && kind !== 'must-fail') failReport(path, `${field}.kind must be one of must-pass, must-fail`)
  const expected = expectedStatus(kind)
  if (value.expected !== expected) failReport(path, `${field}.expected must be '${expected}' for kind ${kind}`)
  const status = value.status
  if (status !== 'pass' && status !== 'fail' && status !== 'error') failReport(path, `${field}.status must be one of pass, fail, error`)
  if (value.error !== undefined && typeof value.error !== 'string') failReport(path, `${field}.error must be a string`)
  const failures = value.failures === undefined ? undefined : stringArray(value.failures, `${field}.failures`, path)
  const ok = value.ok
  if (typeof ok !== 'boolean') failReport(path, `${field}.ok must be a boolean`)
  if (ok !== (status === expected)) failReport(path, `${field}.ok does not match status '${status}' for kind ${kind}`)
  return {
    name,
    kind,
    expected,
    status,
    ...(value.error === undefined ? {} : { error: value.error as string }),
    ...(failures === undefined ? {} : { failures }),
    ok,
  }
}

function normalizeWeakCase(value: unknown, index: number, path: string): WeakCaseWarning {
  if (!isRecord(value)) failReport(path, `calibration.weakCases[${index}] must be a mapping`)
  const name = requiredString(value.name, `calibration.weakCases[${index}].name`, path)
  const reason = value.reason
  if (typeof reason !== 'string' || !Object.hasOwn(WEAK_REASONS, reason)) {
    failReport(path, `calibration.weakCases[${index}].reason must be one of ${Object.keys(WEAK_REASONS).join(', ')}`)
  }
  return { name, reason: reason as WeakReason }
}

/**
 * calibration 段与普通用例同样严格：healthy 必须与哨兵明细一致（同 summary 对 cases 的校验）——
 * 手改 healthy=true 盖住破掉的哨兵，loadReport 直接拒绝
 */
function normalizeCalibration(value: unknown, path: string): Calibration {
  if (!isRecord(value)) failReport(path, 'calibration must be a mapping')
  if (!Array.isArray(value.sentinels)) failReport(path, 'calibration.sentinels must be an array')
  const sentinels = value.sentinels.map((item, index) => normalizeSentinel(item, index, path))
  if (value.skipped !== undefined && typeof value.skipped !== 'boolean') failReport(path, 'calibration.skipped must be a boolean')
  const skipped = value.skipped === true
  if (skipped && sentinels.length > 0) failReport(path, 'calibration.sentinels must be empty when skipped')
  if (!skipped && sentinels.length === 0) failReport(path, 'calibration.sentinels must not be empty unless skipped')
  if (typeof value.healthy !== 'boolean') failReport(path, 'calibration.healthy must be a boolean')
  const healthy = !skipped && sentinels.every((s) => s.ok)
  if (value.healthy !== healthy) failReport(path, `calibration.healthy does not match sentinels (expected ${healthy}, got ${value.healthy})`)
  if (!Array.isArray(value.weakCases)) failReport(path, 'calibration.weakCases must be an array')
  const weakCases = value.weakCases.map((item, index) => normalizeWeakCase(item, index, path))
  return { sentinels, healthy, ...(value.skipped === undefined ? {} : { skipped }), weakCases }
}

function normalizeReport(value: unknown, path: string): RunReport {
  if (!isRecord(value)) failReport(path, 'top level must be a mapping')
  const schemaVersion = value.schemaVersion === undefined ? 0 : value.schemaVersion
  if (schemaVersion !== 0 && schemaVersion !== CURRENT_REPORT_SCHEMA_VERSION) {
    failReport(path, `unsupported schemaVersion '${String(schemaVersion)}' (current: ${CURRENT_REPORT_SCHEMA_VERSION})`)
  }
  const tool = requiredString(value.tool, 'tool', path)
  if (tool !== 'dsh-eval-harness') failReport(path, `tool must be 'dsh-eval-harness', got '${tool}'`)
  const version = requiredString(value.version, 'version', path)
  const startedAt = requiredString(value.startedAt, 'startedAt', path)
  if (!validDate(startedAt)) failReport(path, 'startedAt must be a valid date string')
  const profile = requiredString(value.profile, 'profile', path)
  if (value.dshVersion !== undefined && typeof value.dshVersion !== 'string') failReport(path, 'dshVersion must be a string')
  if (!Array.isArray(value.cases)) failReport(path, 'cases must be an array')

  const cases = value.cases.map((item, index) => normalizeCase(item, index, schemaVersion, path))
  const names = new Set<string>()
  for (const c of cases) {
    if (names.has(c.name)) failReport(path, `duplicate case name '${c.name}'`)
    names.add(c.name)
  }

  const finishedAt = schemaVersion === 0 && value.finishedAt === undefined ? startedAt : requiredString(value.finishedAt, 'finishedAt', path)
  if (!validDate(finishedAt)) failReport(path, 'finishedAt must be a valid date string')
  if (Date.parse(finishedAt) < Date.parse(startedAt)) failReport(path, 'finishedAt must not be earlier than startedAt')
  const durationMs = schemaVersion === 0 && value.durationMs === undefined ? 0 : nonNegativeNumber(value.durationMs, 'durationMs', path)
  if (!isRecord(value.summary)) failReport(path, 'summary must be a mapping')
  const summary = {
    total: nonNegativeInteger(value.summary.total, 'summary.total', path),
    passed: nonNegativeInteger(value.summary.passed, 'summary.passed', path),
    failed: nonNegativeInteger(value.summary.failed, 'summary.failed', path),
    errored: nonNegativeInteger(value.summary.errored, 'summary.errored', path),
  }
  const actual = summarize(cases)
  if (JSON.stringify(summary) !== JSON.stringify(actual)) {
    failReport(path, `summary does not match cases (expected ${JSON.stringify(actual)}, got ${JSON.stringify(summary)})`)
  }
  const calibration = value.calibration === undefined ? undefined : normalizeCalibration(value.calibration, path)

  return {
    schemaVersion,
    tool,
    version,
    startedAt,
    finishedAt,
    durationMs,
    profile,
    ...(value.dshVersion === undefined ? {} : { dshVersion: value.dshVersion as string }),
    cases,
    summary,
    ...(calibration === undefined ? {} : { calibration }),
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
