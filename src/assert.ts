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

  if (assert.tools_exact !== undefined) {
    const actual = trace.toolsCalled
    const expected = assert.tools_exact
    if (actual.length !== expected.length || !expected.every((n, i) => actual[i] === n)) {
      failures.push(`tools_exact: expected exactly [${expected.join(', ')}], got [${actual.join(', ')}]`)
    }
  }

  if (assert.tools_not_called !== undefined) {
    const hit = assert.tools_not_called.filter((n) => trace.toolsCalled.includes(n))
    if (hit.length > 0) {
      failures.push(`tools_not_called: forbidden tool(s) called: [${hit.join(', ')}] (actual calls: [${trace.toolsCalled.join(', ')}])`)
    }
  }

  if (assert.output_contains !== undefined) {
    for (const kw of assert.output_contains) {
      if (!trace.finalText.includes(kw)) {
        failures.push(`output_contains: final assistant text missing '${kw}'`)
      }
    }
  }

  if (assert.output_not_contains !== undefined) {
    for (const kw of assert.output_not_contains) {
      if (trace.finalText.includes(kw)) {
        failures.push(`output_not_contains: final assistant text contains forbidden '${kw}'`)
      }
    }
  }

  if (assert.output_matches !== undefined) {
    for (const pattern of assert.output_matches) {
      // 正则合法性已在 parseCase 阶段校验；这里兜底防手工构造的断言对象
      let re: RegExp
      try {
        re = new RegExp(pattern)
      } catch {
        failures.push(`output_matches: invalid regex '${pattern}'`)
        continue
      }
      if (!re.test(trace.finalText)) {
        failures.push(`output_matches: final assistant text does not match /${pattern}/`)
      }
    }
  }

  if (assert.tool_args_contains !== undefined) {
    for (const p of assert.tool_args_contains) {
      const calls = trace.toolCalls.filter((c) => c.name === p.name)
      if (calls.length === 0) {
        failures.push(`tool_args_contains: tool '${p.name}' was never called`)
      } else if (!calls.some((c) => c.argsJson.includes(p.contains))) {
        failures.push(
          `tool_args_contains: no call to '${p.name}' with arguments containing '${p.contains}' (got ${calls.length} call(s): ${calls.map((c) => c.argsJson || '<no args>').join(' | ')})`,
        )
      }
    }
  }

  if (assert.tool_result_contains !== undefined) {
    for (const p of assert.tool_result_contains) {
      const results = trace.toolResults.filter((r) => r.name === p.name)
      if (results.length === 0) {
        failures.push(`tool_result_contains: tool '${p.name}' was never called (no result recorded)`)
      } else if (!results.some((r) => r.text.includes(p.contains))) {
        failures.push(
          `tool_result_contains: no result of '${p.name}' containing '${p.contains}' (got ${results.length} result(s))`,
        )
      }
    }
  }

  if (assert.max_steps !== undefined && trace.steps > assert.max_steps) {
    failures.push(`max_steps: ${trace.steps} steps > ${assert.max_steps}`)
  }

  if (assert.max_tokens !== undefined && trace.tokens.total > assert.max_tokens) {
    const t = trace.tokens
    failures.push(
      `max_tokens: total ${t.total} (in ${t.input} + out ${t.output} + reasoning ${t.reasoning}; cacheR ${t.cacheRead} + cacheW ${t.cacheWrite} not counted) > ${assert.max_tokens}`,
    )
  }

  if (assert.no_tool_errors === true && trace.toolErrors.length > 0) {
    for (const e of trace.toolErrors) {
      failures.push(`no_tool_errors: tool '${e.name}' returned error: ${e.error}`)
    }
  }

  return failures
}
