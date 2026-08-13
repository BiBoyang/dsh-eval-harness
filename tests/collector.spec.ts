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

  it('aggregates usage fields across assistant messages (incl. cache/reasoning)', () => {
    expect(collectFromJsonl(FIXTURE).tokens).toEqual({
      input: 400,
      output: 70,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 470,
    })
  })

  it('prompt-cache regression: cacheRead/cacheWrite/reasoning are kept per-field; total excludes cache', () => {
    // 真实压测场景：第二次跑命中 prompt cache，inputTokens 只剩 28，真实输入在
    // cacheReadTokens 里。cacheRead 是多步会话里重复读回的缓存命中，全额累加会
    // 让 max_tokens 随步数膨胀——故 cacheRead/cacheWrite 只保留字段、不进 total。
    const t = collectFromJsonl(
      [
        frame('assistant/message', { message: 'a', usage: { inputTokens: 8000, outputTokens: 50 } }),
        frame('assistant/message', {
          message: 'b',
          usage: { inputTokens: 28, outputTokens: 90, cacheReadTokens: 8064, cacheWriteTokens: 120, reasoningTokens: 33 },
        }),
      ].join('\n'),
    )
    expect(t.tokens).toEqual({ input: 8028, output: 140, cacheRead: 8064, cacheWrite: 120, reasoning: 33, total: 8201 })
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
    expect(t.tokens).toEqual({ input: 5, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 5 })
  })

  it('empty input yields empty trace', () => {
    const t = collectFromJsonl('')
    expect(t).toMatchObject({ turnEnd: undefined, toolsCalled: [], finalText: '', steps: 0, toolErrors: [], events: 0 })
  })
})

describe('tool/result error extraction', () => {
  it('collects data.error objects, resolving tool name via callId', () => {
    const t = collectFromJsonl(
      [
        frame('tool/call', { callId: 'call-1', name: 'write' }),
        frame('tool/result', { callId: 'call-1', error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } }),
      ].join('\n'),
    )
    expect(t.toolErrors).toEqual([{ name: 'write', error: 'ToolOutcomeUnknownError: TOOL_OUTCOME_UNKNOWN' }])
  })

  it('collects isError results, using content text as summary', () => {
    const t = collectFromJsonl(
      [
        frame('tool/call', { callId: 'c2', name: 'bash' }),
        frame('tool/result', { callId: 'c2', isError: true, content: [{ type: 'text', text: 'exit code 1: permission denied' }] }),
      ].join('\n'),
    )
    expect(t.toolErrors).toEqual([{ name: 'bash', error: 'exit code 1: permission denied' }])
  })

  it('falls back to callId / <unknown> when name is unresolvable', () => {
    const t = collectFromJsonl(frame('tool/result', { callId: 'orphan', error: 'boom' }))
    expect(t.toolErrors).toEqual([{ name: 'orphan', error: 'boom' }])
    const t2 = collectFromJsonl(frame('tool/result', { error: 'boom' }))
    expect(t2.toolErrors).toEqual([{ name: '<unknown>', error: 'boom' }])
  })

  it('clean tool/result frames produce no toolErrors', () => {
    const t = collectFromJsonl(
      [
        frame('tool/call', { callId: 'c1', name: 'read' }),
        frame('tool/result', { callId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }] }),
      ].join('\n'),
    )
    expect(t.toolErrors).toEqual([])
  })

  it('collects isError from real persisted shape (message.content[].tool-result)', () => {
    // 真实落盘形状：tool/result 的 data 是 { message: { source:{callId}, content:[
    // { type:'tool-result', toolCallId, content:[...], isError } ] } }，不是顶层字段。
    const t = collectFromJsonl(
      [
        frame('tool/call', { callId: 'call-img', name: 'read_image' }),
        frame('tool/result', {
          message: {
            source: { kind: 'tool', callId: 'call-img' },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-img',
                content: [{ type: 'text', text: 'Error: cannot read "pixel.png" as an image: model does not declare image input' }],
                isError: true,
              },
            ],
          },
        }),
      ].join('\n'),
    )
    expect(t.toolErrors).toEqual([
      { name: 'read_image', error: 'Error: cannot read "pixel.png" as an image: model does not declare image input' },
    ])
  })
})

describe('toolCalls / toolResults records', () => {
  it('tool/call records arguments as JSON string (string args kept as-is)', () => {
    const t = collectFromJsonl(frame('tool/call', { callId: 'c1', name: 'write', arguments: '{"path":"/tmp/a.txt","content":"hi"}' }))
    expect(t.toolCalls).toEqual([{ name: 'write', callId: 'c1', argsJson: '{"path":"/tmp/a.txt","content":"hi"}' }])
    expect(t.toolsCalled).toEqual(['write'])
  })

  it('tool/call object arguments are JSON.stringified; missing arguments become empty string', () => {
    const t = collectFromJsonl(
      [
        frame('tool/call', { callId: 'c1', name: 'a', arguments: { path: '/x' } }),
        frame('tool/call', { name: 'b' }),
      ].join('\n'),
    )
    expect(t.toolCalls).toEqual([
      { name: 'a', callId: 'c1', argsJson: '{"path":"/x"}' },
      { name: 'b', callId: undefined, argsJson: '' },
    ])
  })

  it('tool/result text: real on-disk shape (message.content[] tool-result block)', () => {
    const t = collectFromJsonl(
      [
        frame('tool/call', { callId: 'c1', name: 'bash' }),
        frame('tool/result', {
          message: {
            source: { kind: 'tool', callId: 'c1' },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'c1',
                content: [{ type: 'text', text: 'total 42' }],
                isError: false,
              },
            ],
          },
        }),
      ].join('\n'),
    )
    expect(t.toolResults).toEqual([{ name: 'bash', callId: 'c1', text: 'total 42' }])
  })

  it('tool/result text: legacy top-level content shape', () => {
    const t = collectFromJsonl(
      [
        frame('tool/call', { callId: 'c9', name: 'read' }),
        frame('tool/result', { callId: 'c9', isError: false, content: [{ type: 'text', text: 'file body' }] }),
      ].join('\n'),
    )
    expect(t.toolResults).toEqual([{ name: 'read', callId: 'c9', text: 'file body' }])
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
