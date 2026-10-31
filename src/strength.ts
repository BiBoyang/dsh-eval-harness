import type { EvalCase } from './types.js'

/**
 * 弱用例的原因：
 * - `host-without-exit-and-turn-end`：mock 用例（宿主为被测）没有同时声明 exit_code 与 turn_end
 * - `answer-in-prompt`：有文本 / 参数类断言，但每个期望串都能从 prompt 字面复述得到
 * - `no-outcome-assertion`：一条结果型断言都没有（只有工具名、终态、资源上限之类）
 */
export type WeakReason = 'host-without-exit-and-turn-end' | 'answer-in-prompt' | 'no-outcome-assertion'

/** 判强的依据：按规则的检查顺序，取第一条命中的条件 */
export type StrengthSignal = 'host-exit-and-turn-end' | 'tool_result_contains' | 'tool_args_contains' | 'output_contains' | 'output_matches'

export type AssertionStrength = { strong: true; signal: StrengthSignal } | { strong: false; reason: WeakReason }

/**
 * 断言强度静态检查：一个不解题的 agent 能不能过这条用例？纯函数，只看用例本身，
 * 不接入 runner。规则是设计文档 §6.2 E2 的 P0 静态版（契约 plans/TASK-p0-probe-agents.md）。
 *
 * - mock 用例（宿主为被测）：同时声明 exit_code 与 turn_end 为强，否则弱。送达证据
 *   由运行期对账强制（TASK-p0-evidence-floor），不在这里判。
 * - 真实 API 用例：满足任一条件为强——
 *   ① tool_result_contains 至少一条的 contains 非空（结果文本只能来自工具真实执行；
 *      空串对任何结果都成立，报错结果也不例外，不算）；
 *   ② 某条 tool_args_contains.contains 不在 prompt 字面中；
 *   ③ 某条 output_contains 不在 prompt 字面中；
 *   ④ 某条 output_matches 正则不匹配 prompt 全文。
 *   都不满足为弱：有 output_contains / output_matches / tool_args_contains 时原因是
 *   `answer-in-prompt`，三者都没有时是 `no-outcome-assertion`。
 *
 * 不算结果信号的断言：期望串在 prompt 里的 tool_args_contains（把整段 prompt 塞进参数
 * 即可命中，parrot 探针穿透 01-bash-tool 即此）；no_tool_errors（调用成功但答非所问也能过）；
 * tools_called / tools_exact / tools_not_called（只认工具名）；turn_end、exit_code、
 * max_steps、max_tokens、output_not_contains（do-nothing 即可满足）；output_judge 不在本规则
 * 内，judge 自身的放水方式见 docs/abc-checklist.md。
 *
 * 字面检索区分大小写，与 assert.ts 的 includes / 无 flag RegExp 同口径——复述 prompt 的
 * agent 能否命中，只取决于 prompt 原文。这是保守启发式：期望串出现在 prompt 里、但语义上
 * 确实要执行才能得到的用例会被误判为弱，逃生口是 tests/probes.spec.ts 白名单（附理由注释）。
 */
export function assessAssertionStrength(evalCase: EvalCase): AssertionStrength {
  const a = evalCase.assert
  if (evalCase.mock !== undefined) {
    return a.exit_code !== undefined && a.turn_end !== undefined
      ? { strong: true, signal: 'host-exit-and-turn-end' }
      : { strong: false, reason: 'host-without-exit-and-turn-end' }
  }
  const prompt = evalCase.prompt
  const notInPrompt = (expected: string): boolean => !prompt.includes(expected)
  if ((a.tool_result_contains ?? []).some((p) => p.contains !== '')) return { strong: true, signal: 'tool_result_contains' }
  if ((a.tool_args_contains ?? []).some((p) => notInPrompt(p.contains))) return { strong: true, signal: 'tool_args_contains' }
  if ((a.output_contains ?? []).some(notInPrompt)) return { strong: true, signal: 'output_contains' }
  if ((a.output_matches ?? []).some((pattern) => rejectsPrompt(pattern, prompt))) return { strong: true, signal: 'output_matches' }
  const textual = (a.output_contains ?? []).length + (a.output_matches ?? []).length + (a.tool_args_contains ?? []).length
  return { strong: false, reason: textual > 0 ? 'answer-in-prompt' : 'no-outcome-assertion' }
}

/**
 * output_matches 的正则是否拒绝 prompt 全文（复述 prompt 过不了它，才算结果信号）。
 * 非法正则不算：它在 assert.ts 里只会产出失败，证明不了任何结果；parseCase 已在
 * 解析期拒绝非法正则，这里兜底手工构造的用例对象。
 */
function rejectsPrompt(pattern: string, prompt: string): boolean {
  try {
    return !new RegExp(pattern).test(prompt)
  } catch {
    return false
  }
}
