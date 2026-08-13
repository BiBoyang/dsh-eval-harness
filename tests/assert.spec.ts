import { describe, expect, it } from 'vitest'
import { checkAssertions, isSubsequence } from '../src/assert.ts'
import type { CollectedTrace } from '../src/types.ts'

function trace(overrides: Partial<CollectedTrace> = {}): CollectedTrace {
  return {
    turnEnd: 'completed',
    toolsCalled: ['tool_a', 'tool_b', 'tool_c'],
    toolCalls: [
      { name: 'tool_a', callId: 'c1', argsJson: '{"path":"/tmp/a.txt"}' },
      { name: 'tool_b', callId: 'c2', argsJson: '{"query":"hello"}' },
      { name: 'tool_c', callId: 'c3', argsJson: '{}' },
    ],
    toolResults: [
      { name: 'tool_a', callId: 'c1', text: 'file written to /tmp/a.txt' },
      { name: 'tool_b', callId: 'c2', text: 'search results for hello: 3 hits' },
      { name: 'tool_c', callId: 'c3', text: 'done' },
    ],
    finalText: '结果是 hello eval，已完成',
    steps: 3,
    tokens: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 1500 },
    toolErrors: [],
    events: 10,
    skippedLines: 0,
    ...overrides,
  }
}

describe('isSubsequence', () => {
  it('matches ordered subsequence with gaps', () => {
    expect(isSubsequence(['a', 'x', 'b', 'y', 'c'], ['a', 'b', 'c'])).toBe(true)
  })
  it('rejects wrong order', () => {
    expect(isSubsequence(['b', 'a'], ['a', 'b'])).toBe(false)
  })
  it('rejects missing element', () => {
    expect(isSubsequence(['a'], ['a', 'b'])).toBe(false)
  })
  it('empty expected always matches', () => {
    expect(isSubsequence([], [])).toBe(true)
    expect(isSubsequence(['a'], [])).toBe(true)
  })
})

describe('checkAssertions', () => {
  it('passes when all assertions hold', () => {
    const failures = checkAssertions(
      { turn_end: 'completed', tools_called: ['tool_a', 'tool_c'], output_contains: ['hello', '完成'], max_steps: 4, max_tokens: 2000 },
      trace(),
    )
    expect(failures).toEqual([])
  })

  it('turn_end mismatch fails', () => {
    const failures = checkAssertions({ turn_end: 'completed' }, trace({ turnEnd: 'aborted' }))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("turn_end")
    expect(failures[0]).toContain("'aborted'")
  })

  it('turn_end missing frame fails with <missing>', () => {
    const failures = checkAssertions({ turn_end: 'completed' }, trace({ turnEnd: undefined }))
    expect(failures[0]).toContain('<missing>')
  })

  it('tools_called honors order (subsequence, not substring set)', () => {
    expect(checkAssertions({ tools_called: ['tool_c', 'tool_a'] }, trace())).toHaveLength(1)
    expect(checkAssertions({ tools_called: ['tool_a', 'tool_c'] }, trace())).toHaveLength(0)
    expect(checkAssertions({ tools_called: ['tool_a', 'nope'] }, trace())).toHaveLength(1)
  })

  it('output_contains requires every keyword', () => {
    expect(checkAssertions({ output_contains: ['hello', 'eval'] }, trace())).toHaveLength(0)
    const failures = checkAssertions({ output_contains: ['hello', '不存在'] }, trace())
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('不存在')
  })

  it('max_steps: equal passes, exceed fails', () => {
    expect(checkAssertions({ max_steps: 3 }, trace())).toHaveLength(0)
    const failures = checkAssertions({ max_steps: 2 }, trace())
    expect(failures[0]).toContain('3 steps > 2')
  })

  it('max_tokens compares against total (computed by collector as in+out+reasoning)', () => {
    expect(checkAssertions({ max_tokens: 1500 }, trace())).toHaveLength(0)
    const failures = checkAssertions({ max_tokens: 1499 }, trace())
    expect(failures[0]).toContain('total 1500')
    expect(failures[0]).toContain('not counted') // 失败信息标明 cache 口径
  })

  it('max_tokens boundary: total equal passes, exceeding fails', () => {
    const atLimit = trace({ tokens: { input: 100, output: 50, cacheRead: 99999, cacheWrite: 0, reasoning: 0, total: 150 } })
    expect(checkAssertions({ max_tokens: 150 }, atLimit)).toHaveLength(0)
    expect(checkAssertions({ max_tokens: 149 }, atLimit)).toHaveLength(1)
  })

  it('no_tool_errors fails with tool name and error summary', () => {
    const t = trace({ toolErrors: [{ name: 'write', error: 'PermissionDenied: /etc/passwd' }] })
    const failures = checkAssertions({ no_tool_errors: true }, t)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("tool 'write'")
    expect(failures[0]).toContain('PermissionDenied')
  })

  it('no_tool_errors passes when toolErrors is empty', () => {
    expect(checkAssertions({ no_tool_errors: true }, trace())).toHaveLength(0)
  })

  it('toolErrors do not affect results when no_tool_errors is unset', () => {
    const t = trace({ toolErrors: [{ name: 'x', error: 'boom' }] })
    expect(checkAssertions({}, t)).toEqual([])
    expect(checkAssertions({ no_tool_errors: false }, t)).toEqual([])
  })

  it('empty assert passes anything', () => {
    expect(checkAssertions({}, trace({ turnEnd: undefined, toolsCalled: [], finalText: '' }))).toEqual([])
  })

  it('collects multiple failures at once', () => {
    const failures = checkAssertions(
      { turn_end: 'x', output_contains: ['nope'], max_steps: 1 },
      trace(),
    )
    expect(failures).toHaveLength(3)
  })
})

describe('new assertions (P1)', () => {
  it('tools_exact: exact sequence passes', () => {
    expect(checkAssertions({ tools_exact: ['tool_a', 'tool_b', 'tool_c'] }, trace())).toHaveLength(0)
    expect(checkAssertions({ tools_exact: [] }, trace({ toolsCalled: [] }))).toHaveLength(0)
  })

  it('tools_exact: extra/missing/reordered calls fail with both sequences printed', () => {
    const extra = checkAssertions({ tools_exact: ['tool_a', 'tool_b'] }, trace())
    expect(extra[0]).toBe('tools_exact: expected exactly [tool_a, tool_b], got [tool_a, tool_b, tool_c]')
    const reordered = checkAssertions({ tools_exact: ['tool_b', 'tool_a', 'tool_c'] }, trace())
    expect(reordered[0]).toContain('expected exactly [tool_b, tool_a, tool_c]')
  })

  it('tools_not_called: absent tools pass', () => {
    expect(checkAssertions({ tools_not_called: ['bash', 'write'] }, trace())).toHaveLength(0)
  })

  it('tools_not_called: called forbidden tool fails with names', () => {
    const failures = checkAssertions({ tools_not_called: ['tool_b', 'nope'] }, trace())
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('forbidden tool(s) called: [tool_b]')
  })

  it('output_not_contains: absent keyword passes', () => {
    expect(checkAssertions({ output_not_contains: ['抱歉', '失败'] }, trace())).toHaveLength(0)
  })

  it('output_not_contains: present keyword fails', () => {
    const failures = checkAssertions({ output_not_contains: ['hello'] }, trace())
    expect(failures[0]).toContain("contains forbidden 'hello'")
  })

  it('output_matches: all regexes match', () => {
    expect(checkAssertions({ output_matches: ['hello', '^结果是', 'e.l'] }, trace())).toHaveLength(0)
  })

  it('output_matches: non-matching regex fails with pattern', () => {
    const failures = checkAssertions({ output_matches: ['hello', '^okay'] }, trace())
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBe('output_matches: final assistant text does not match /^okay/')
  })

  it('tool_args_contains: matching call passes', () => {
    expect(checkAssertions({ tool_args_contains: [{ name: 'tool_a', contains: '/tmp/a.txt' }] }, trace())).toHaveLength(0)
  })

  it('tool_args_contains: args miss fails with actual args listed', () => {
    const failures = checkAssertions({ tool_args_contains: [{ name: 'tool_a', contains: '/etc/passwd' }] }, trace())
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("no call to 'tool_a' with arguments containing '/etc/passwd'")
    expect(failures[0]).toContain('/tmp/a.txt')
  })

  it('tool_args_contains: tool never called fails distinctly', () => {
    const failures = checkAssertions({ tool_args_contains: [{ name: 'ghost', contains: 'x' }] }, trace())
    expect(failures[0]).toBe("tool_args_contains: tool 'ghost' was never called")
  })

  it('tool_result_contains: matching result passes', () => {
    expect(checkAssertions({ tool_result_contains: [{ name: 'tool_b', contains: '3 hits' }] }, trace())).toHaveLength(0)
  })

  it('tool_result_contains: text miss fails', () => {
    const failures = checkAssertions({ tool_result_contains: [{ name: 'tool_b', contains: '0 hits' }] }, trace())
    expect(failures[0]).toContain("no result of 'tool_b' containing '0 hits'")
  })

  it('tool_result_contains: tool never called fails distinctly', () => {
    const failures = checkAssertions({ tool_result_contains: [{ name: 'ghost', contains: 'x' }] }, trace())
    expect(failures[0]).toBe("tool_result_contains: tool 'ghost' was never called (no result recorded)")
  })
})
