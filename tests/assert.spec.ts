import { describe, expect, it } from 'vitest'
import { checkAssertions, isSubsequence } from '../src/assert.ts'
import type { CollectedTrace } from '../src/types.ts'

function trace(overrides: Partial<CollectedTrace> = {}): CollectedTrace {
  return {
    turnEnd: 'completed',
    toolsCalled: ['tool_a', 'tool_b', 'tool_c'],
    finalText: '结果是 hello eval，已完成',
    steps: 3,
    tokens: { input: 1000, output: 500 },
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

  it('max_tokens aggregates input+output', () => {
    expect(checkAssertions({ max_tokens: 1500 }, trace())).toHaveLength(0)
    const failures = checkAssertions({ max_tokens: 1499 }, trace())
    expect(failures[0]).toContain('1500')
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
