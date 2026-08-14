/**
 * LLM-as-judge：用 OpenAI 兼容 chat completions 接口评最终 assistant 文本是否
 * 满足 rubric 的语义期望（表达不了正则/关键词的结构性期望，如「解释原因而非
 * 只给结论」）。
 *
 * 零依赖（Node 22 内置 fetch），不接 @deepseek-ai/dsh-llm——那是 cordis
 * Service 体系（Context + adapter 注册 + 流式 waterfall），judge 只是一次性
 * 短调用，为此拉起整套运行时不值得。
 *
 * 配置全走环境变量（工具层参数面无感）：
 * - EVAL_JUDGE_API_KEY：缺省回落 DEEPSEEK_API_KEY（评测环境通常已有）
 * - EVAL_JUDGE_BASE_URL：默认 https://api.deepseek.com
 * - EVAL_JUDGE_MODEL：默认 deepseek-chat
 */

/** judge 判定结果：pass 二元 + 简短理由（FAIL 理由进 failures，PASS 理由丢弃） */
export interface JudgeResult {
  pass: boolean
  reason: string
}

/** 单次 judge 调用超时：judge 只做一次短判定，卡死不该拖垮整个用例 */
const JUDGE_TIMEOUT_MS = 60_000

/** 要求 judge 以固定格式回答：首行 PASS/FAIL + 一行理由——格式越简单解析越稳 */
const JUDGE_SYSTEM_PROMPT = [
  'You are an evaluation judge for an AI agent task.',
  'Decide whether the answer below satisfies the rubric.',
  'Reply with exactly two lines: the first line must be PASS or FAIL,',
  'the second line a short reason for your verdict.',
].join(' ')

/** 从 judge 回复解析判定：取首个非空行判 PASS/FAIL，其余行拼作理由 */
export function parseJudgeReply(reply: string): JudgeResult {
  const lines = reply.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const verdict = lines[0] ?? ''
  const reason = lines.slice(1).join(' ')
  if (/^PASS\b/i.test(verdict)) return { pass: true, reason }
  if (/^FAIL\b/i.test(verdict)) return { pass: false, reason }
  throw new Error(`unparseable judge reply (first line must be PASS or FAIL): '${verdict.slice(0, 200)}'`)
}

/**
 * 真实 judge 实现：任何失败（无 key / HTTP 错误 / 超时 / 回复解析失败）直接
 * throw，由调用方（runAttempt）按 infra error 处理——infra 抖动不应被记成断言失败。
 */
export async function judgeOutput(input: { rubric: string; output: string }): Promise<JudgeResult> {
  // 用 || 而非 ??：CI 里变量置空串视为未设置，继续回落到评测主 key
  const apiKey = process.env.EVAL_JUDGE_API_KEY || process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('no judge API key: set EVAL_JUDGE_API_KEY or DEEPSEEK_API_KEY')
  }
  const baseUrl = (process.env.EVAL_JUDGE_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '')
  const model = process.env.EVAL_JUDGE_MODEL ?? 'deepseek-chat'

  let res: Response
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM_PROMPT },
          { role: 'user', content: `Rubric:\n${input.rubric}\n\nAnswer:\n${input.output}` },
        ],
        // 判定任务要稳定：温度 0，输出只要两行，不需要长生成
        temperature: 0,
        max_tokens: 200,
        stream: false,
      }),
      signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    })
  } catch (err) {
    throw new Error(`judge request failed: ${(err as Error).message}`)
  }
  const bodyText = await res.text()
  if (!res.ok) {
    throw new Error(`judge HTTP ${res.status}: ${bodyText.slice(-300)}`)
  }
  let content: unknown
  try {
    const data = JSON.parse(bodyText) as { choices?: { message?: { content?: unknown } }[] }
    content = data.choices?.[0]?.message?.content
  } catch {
    content = undefined
  }
  if (typeof content !== 'string') {
    throw new Error(`judge reply has no message content: ${bodyText.slice(0, 300)}`)
  }
  return parseJudgeReply(content)
}
