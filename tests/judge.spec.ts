import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { judgeOutput, parseJudgeReply, validateJudge } from '../src/judge.ts'

/** 构造 OpenAI 兼容 chat completions 的成功/失败 Response */
const completionResponse = (content: string, status = 200): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('parseJudgeReply', () => {
  it('parses the PASS/FAIL last line and joins the analysis before it as reason', () => {
    expect(parseJudgeReply('看起来满足了 rubric\nPASS')).toEqual({ pass: true, reason: '看起来满足了 rubric' })
    expect(parseJudgeReply('只给了结论，没解释原因\nFAIL')).toEqual({ pass: false, reason: '只给了结论，没解释原因' })
  })

  it('tolerates blank lines, padding and trailing punctuation on the verdict line', () => {
    expect(parseJudgeReply('第一行理由\n第二行理由\n\n  PASS  \n')).toEqual({ pass: true, reason: '第一行理由 第二行理由' })
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
    const fetchMock = vi.fn(async () => completionResponse('缺少解释\nFAIL'))
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
    const fetchMock = vi.fn(async () => completionResponse('ok\nPASS'))
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

describe('validateJudge', () => {
  const writeLabels = async (entries: unknown[]): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'judge-labels-'))
    const path = join(root, 'labels.jsonl')
    await writeFile(path, entries.map((e) => JSON.stringify(e)).join('\n'))
    return path
  }

  it('computes the confusion matrix with TPR/TNR separately and reports mismatches', async () => {
    // 假 judge：输出含 "good" 判 PASS，否则判 FAIL
    const fakeJudge = async (input: { rubric: string; output: string }) => ({
      pass: input.output.includes('good'),
      reason: 'fake',
    })
    const path = await writeLabels([
      { rubric: 'r', output: 'good answer', expect: 'pass' }, // tn：真通过，judge 也放行了
      { rubric: 'r', output: 'bad answer', expect: 'fail' }, // tp：真失败，judge 抓到了
      { rubric: 'r', output: 'good but wrong', expect: 'fail' }, // fn：真失败被 judge 漏掉（判了 PASS）
      { rubric: 'r', output: 'bad but fine', expect: 'pass' }, // fp：真通过被 judge 冤枉（判了 FAIL）
    ])

    const c = await validateJudge({ labelsPath: path, judge: fakeJudge })
    expect(c.total).toBe(4)
    expect({ tp: c.tp, fp: c.fp, tn: c.tn, fn: c.fn }).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 })
    expect(c.tpr).toBe(0.5)
    expect(c.tnr).toBe(0.5)
    expect(c.agreement).toBe(0.5)
    expect(c.calibrated).toBe(false)
    expect(c.mismatches).toHaveLength(2)
    expect(c.mismatches.map((m) => m.index)).toEqual([2, 3])
  })

  it('is calibrated only when both TPR and TNR meet the thresholds', async () => {
    const perfect = async () => ({ pass: true, reason: '' })
    const path = await writeLabels([
      { rubric: 'r', output: 'a', expect: 'pass' },
      { rubric: 'r', output: 'b', expect: 'pass' },
    ])
    // judge 全判 PASS：TNR 满分，但没有 fail 样本 → tpr 为 null → 不达标
    const c = await validateJudge({ labelsPath: path, judge: perfect })
    expect(c.tnr).toBe(1)
    expect(c.tpr).toBeNull()
    expect(c.calibrated).toBe(false)
  })

  it('rejects malformed label lines with the line number', async () => {
    const path = await writeLabels([{ rubric: 'r', output: 'o', expect: 'pass' }, { rubric: 'r', output: 'o' }])
    await expect(validateJudge({ labelsPath: path, judge: async () => ({ pass: true, reason: '' }) })).rejects.toThrow(
      /labels line 2/,
    )
  })

  it('throws on an empty or missing labels file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'judge-labels-'))
    const empty = join(root, 'empty.jsonl')
    await writeFile(empty, '')
    const judge = async () => ({ pass: true, reason: '' })
    await expect(validateJudge({ labelsPath: empty, judge })).rejects.toThrow(/no entries/)
    await expect(validateJudge({ labelsPath: join(root, 'missing.jsonl'), judge })).rejects.toThrow(/cannot read labels file/)
  })
})
