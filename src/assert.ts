import type { CollectedTrace, EvalAssert } from './types.js'

/** 保序子序列匹配：sub 是否按顺序出现在 seq 中 */
export function isSubsequence<T>(seq: T[], sub: T[]): boolean {
  let i = 0
  for (const item of seq) {
    if (item === sub[i]) i++
    if (i === sub.length) return true
  }
  return i === sub.length
}

/**
 * 断言引擎：把用例断言应用到 collector 观测结果上。
 * 返回失败消息列表；空数组 = 全部通过。
 */
export function checkAssertions(assert: EvalAssert, trace: CollectedTrace): string[] {
  const failures: string[] = []

  if (assert.turn_end !== undefined && trace.turnEnd !== assert.turn_end) {
    failures.push(`turn_end: expected '${assert.turn_end}', got '${trace.turnEnd ?? '<missing>'}'`)
  }

  if (assert.tools_called !== undefined && !isSubsequence(trace.toolsCalled, assert.tools_called)) {
    failures.push(
      `tools_called: expected ordered subsequence [${assert.tools_called.join(', ')}], got [${trace.toolsCalled.join(', ')}]`,
    )
  }

  if (assert.output_contains !== undefined) {
    for (const kw of assert.output_contains) {
      if (!trace.finalText.includes(kw)) {
        failures.push(`output_contains: final assistant text missing '${kw}'`)
      }
    }
  }

  if (assert.max_steps !== undefined && trace.steps > assert.max_steps) {
    failures.push(`max_steps: ${trace.steps} steps > ${assert.max_steps}`)
  }

  if (assert.max_tokens !== undefined && trace.tokens.total > assert.max_tokens) {
    const t = trace.tokens
    failures.push(
      `max_tokens: total ${t.total} (in ${t.input} + out ${t.output} + cacheR ${t.cacheRead} + cacheW ${t.cacheWrite} + reasoning ${t.reasoning}) > ${assert.max_tokens}`,
    )
  }

  if (assert.no_tool_errors === true && trace.toolErrors.length > 0) {
    for (const e of trace.toolErrors) {
      failures.push(`no_tool_errors: tool '${e.name}' returned error: ${e.error}`)
    }
  }

  return failures
}
