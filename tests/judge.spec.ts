import { afterEach, describe, expect, it, vi } from 'vitest'
import { judgeOutput, parseJudgeReply } from '../src/judge.ts'

/** 构造 OpenAI 兼容 chat completions 的成功/失败 Response */
const completionResponse = (content: string, status = 200): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('parseJudgeReply', () => {
  it('parses PASS/FAIL first line and joins the rest as reason', () => {
    expect(parseJudgeReply('PASS\n看起来满足了 rubric')).toEqual({ pass: true, reason: '看起来满足了 rubric' })
    expect(parseJudgeReply('FAIL\n只给了结论，没解释原因')).toEqual({ pass: false, reason: '只给了结论，没解释原因' })
  })

  it('tolerates blank lines, padding and trailing punctuation on the verdict line', () => {
    expect(parseJudgeReply('\n  PASS  \n第一行理由\n第二行理由')).toEqual({ pass: true, reason: '第一行理由 第二行理由' })
    expect(parseJudgeReply('FAIL.')).toEqual({ pass: false, reason: '' })
  })

  it('throws on replies without a parseable verdict line', () => {
    expect(() => parseJudgeReply('我觉得可以通过')).toThrow(/unparseable judge reply/)
    expect(() => parseJudgeReply('')).toThrow(/unparseable judge reply/)
  })
})

describe('judgeOutput', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('calls the OpenAI-compatible endpoint with env config and returns the parsed verdict', async () => {
    vi.stubEnv('EVAL_JUDGE_API_KEY', 'test-key')
    vi.stubEnv('EVAL_JUDGE_BASE_URL', 'https://judge.example.com/v1/')
    vi.stubEnv('EVAL_JUDGE_MODEL', 'judge-model')
    const fetchMock = vi.fn(async () => completionResponse('FAIL\n缺少解释'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await judgeOutput({ rubric: '回答应解释原因', output: '答案是 42' })
    expect(result).toEqual({ pass: false, reason: '缺少解释' })

    const call = fetchMock.mock.calls[0]
    if (!call) throw new Error('fetch not called')
    const [url, init] = call as unknown as [string, RequestInit]
    // base URL 尾斜杠被剥掉后拼 chat/completions
    expect(url).toBe('https://judge.example.com/v1/chat/completions')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer test-key')
    const body = JSON.parse(String(init.body)) as { model: string; messages: { role: string; content: string }[] }
    expect(body.model).toBe('judge-model')
    // rubric 与被评文本都要进 prompt
    expect(body.messages.some((m) => m.content.includes('回答应解释原因') && m.content.includes('答案是 42'))).toBe(true)
  })

  it('falls back to DEEPSEEK_API_KEY when EVAL_JUDGE_API_KEY is empty/unset', async () => {
    vi.stubEnv('EVAL_JUDGE_API_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', 'ds-key')
    const fetchMock = vi.fn(async () => completionResponse('PASS\nok'))
    vi.stubGlobal('fetch', fetchMock)

    const result = await judgeOutput({ rubric: 'r', output: 'o' })
    expect(result).toEqual({ pass: true, reason: 'ok' })
    const call = fetchMock.mock.calls[0]
    if (!call) throw new Error('fetch not called')
    const init = (call as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer ds-key')
  })

  it('throws a clear error when no API key is available at all', async () => {
    vi.stubEnv('EVAL_JUDGE_API_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    await expect(judgeOutput({ rubric: 'r', output: 'o' })).rejects.toThrow(/no judge API key/)
  })

  it('throws on non-2xx HTTP status with the body tail', async () => {
    vi.stubEnv('EVAL_JUDGE_API_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(async () => completionResponse('unused', 500)))
    await expect(judgeOutput({ rubric: 'r', output: 'o' })).rejects.toThrow(/judge HTTP 500/)
  })

  it('throws on network failure (wrapped, not the raw fetch error)', async () => {
    vi.stubEnv('EVAL_JUDGE_API_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('ECONNRESET'))))
    await expect(judgeOutput({ rubric: 'r', output: 'o' })).rejects.toThrow(/judge request failed: ECONNRESET/)
  })

  it('throws when the reply has no message content (unexpected response shape)', async () => {
    vi.stubEnv('EVAL_JUDGE_API_KEY', 'k')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 200, headers: { 'content-type': 'application/json' } })),
    )
    await expect(judgeOutput({ rubric: 'r', output: 'o' })).rejects.toThrow(/no message content/)
  })

  it('throws when the model ignores the PASS/FAIL format (infra error, not a verdict)', async () => {
    vi.stubEnv('EVAL_JUDGE_API_KEY', 'k')
    vi.stubGlobal('fetch', vi.fn(async () => completionResponse('我认为可以接受')))
    await expect(judgeOutput({ rubric: 'r', output: 'o' })).rejects.toThrow(/unparseable judge reply/)
  })
})
