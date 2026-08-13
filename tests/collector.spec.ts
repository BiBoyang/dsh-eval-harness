import { describe, expect, it } from 'vitest'
import { collectFromJsonl, extractText } from '../src/collector.ts'

/** 自造 session.jsonl fixture（不读真实用户会话数据） */
function frame(type: string, data: unknown, seq = 0): string {
  return JSON.stringify({ type, seq, time: '2026-08-13T00:00:00.000Z', data })
}

const FIXTURE = [
  frame('turn/start', { turnId: 't1' }),
  frame('assistant/message', {
    message: { content: [{ type: 'text', text: '我先调用工具' }] },
    usage: { inputTokens: 100, outputTokens: 20 },
  }),
  frame('tool/call', { name: 'tool_a', callId: 'c1' }),
  frame('step/end', { step: 1 }),
  frame('tool/call', { name: 'tool_b', callId: 'c2' }),
  frame('assistant/message', {
    message: { content: [{ type: 'text', text: '最终答案：hello eval' }] },
    usage: { inputTokens: 300, outputTokens: 50 },
  }),
  frame('step/end', { step: 2 }),
  frame('turn/end', { reason: { kind: 'completed' } }),
  '', // 尾空行
].join('\n')

describe('collectFromJsonl', () => {
  it('extracts turn_end reason from the last turn/end frame', () => {
    const t = collectFromJsonl(FIXTURE)
    expect(t.turnEnd).toBe('completed')
  })

  it('collects tool/call names in order', () => {
    expect(collectFromJsonl(FIXTURE).toolsCalled).toEqual(['tool_a', 'tool_b'])
  })

  it('finalText is the last assistant/message text', () => {
    expect(collectFromJsonl(FIXTURE).finalText).toBe('最终答案：hello eval')
  })

  it('counts step/end frames', () => {
    expect(collectFromJsonl(FIXTURE).steps).toBe(2)
  })

  it('aggregates usage.inputTokens/outputTokens across assistant messages', () => {
    expect(collectFromJsonl(FIXTURE).tokens).toEqual({ input: 400, output: 70 })
  })

  it('ignores unrelated frame types', () => {
    const t = collectFromJsonl(FIXTURE)
    expect(t.events).toBe(8)
    expect(t.skippedLines).toBe(0)
  })

  it('skips malformed lines without throwing', () => {
    const t = collectFromJsonl(['not json', '{"no_type":1}', frame('step/end', {})].join('\n'))
    expect(t.skippedLines).toBe(2)
    expect(t.steps).toBe(1)
  })

  it('last turn/end wins', () => {
    const t = collectFromJsonl(
      [frame('turn/end', { reason: { kind: 'aborted' } }), frame('turn/end', { reason: { kind: 'completed' } })].join('\n'),
    )
    expect(t.turnEnd).toBe('completed')
  })

  it('tolerates frames without usage or message text', () => {
    const t = collectFromJsonl(frame('assistant/message', { usage: { inputTokens: 5 } }))
    expect(t.finalText).toBe('')
    expect(t.tokens).toEqual({ input: 5, output: 0 })
  })

  it('empty input yields empty trace', () => {
    const t = collectFromJsonl('')
    expect(t).toMatchObject({ turnEnd: undefined, toolsCalled: [], finalText: '', steps: 0, events: 0 })
  })
})

describe('extractText', () => {
  it('accepts a plain string message', () => {
    expect(extractText('hello')).toBe('hello')
  })
  it('joins text content blocks', () => {
    expect(
      extractText({ content: [{ type: 'text', text: 'a' }, { type: 'thinking', text: 'x' }, { type: 'text', text: 'b' }] }),
    ).toBe('ab')
  })
  it('accepts message.content as string', () => {
    expect(extractText({ content: 'direct' })).toBe('direct')
  })
  it('returns undefined for unusable shapes', () => {
    expect(extractText(undefined)).toBeUndefined()
    expect(extractText(42)).toBeUndefined()
    expect(extractText({})).toBeUndefined()
  })
})
