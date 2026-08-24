import { readFile } from 'node:fs/promises'

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

/** 要求 judge 先简短分析再给判定（CoT 在前）：先下结论再补理由的格式会让理由沦为事后粉饰 */
const JUDGE_SYSTEM_PROMPT = [
  'You are an evaluation judge for an AI agent task.',
  'Decide whether the answer below satisfies the rubric.',
  'Reply with a brief analysis first, then the last line must be exactly PASS or FAIL.',
].join(' ')

/** 从 judge 回复解析判定：取最后一个非空行判 PASS/FAIL，前面的分析行拼作理由 */
export function parseJudgeReply(reply: string): JudgeResult {
  const lines = reply.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const verdict = lines[lines.length - 1] ?? ''
  const reason = lines.slice(0, -1).join(' ')
  if (/^PASS\b/i.test(verdict)) return { pass: true, reason }
  if (/^FAIL\b/i.test(verdict)) return { pass: false, reason }
  throw new Error(`unparseable judge reply (last line must be PASS or FAIL): '${verdict.slice(0, 200)}'`)
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

/** 一条人工标注：rubric + 被评输出 + 期望判定 */
export interface JudgeLabel {
  rubric: string
  output: string
  expect: 'pass' | 'fail'
}

/** judge 校准报告：混淆矩阵 + TPR/TNR + 是否达标 */
export interface JudgeCalibration {
  total: number
  tp: number
  fp: number
  tn: number
  fn: number
  /** 真失败被 judge 抓到的比例 = tp / (tp + fn)；标注集无 fail 样本时为 null */
  tpr: number | null
  /** 真通过没被冤枉的比例 = tn / (tn + fp)；标注集无 pass 样本时为 null */
  tnr: number | null
  agreement: number
  /** tpr 与 tnr 均达到阈值才 true（缺数据的维度视为不达标——没标 fail 样本就别说 judge 会抓失败） */
  calibrated: boolean
  /** 判定与标注不一致的条目（供人工 review judge 的错法） */
  mismatches: { index: number; expect: 'pass' | 'fail'; got: 'pass' | 'fail'; reason: string }[]
}

/**
 * 在人工标注集上校准 judge：逐条调 judge，对比期望判定。
 * 标注集是 JSONL，每行 {"rubric": "...", "output": "...", "expect": "pass"|"fail"}。
 * judge 的 infra 错误（HTTP/超时/解析失败）直接 throw——校准数据的每一票都不可让渡。
 */
export async function validateJudge(options: {
  labelsPath: string
  judge?: (input: { rubric: string; output: string }) => Promise<JudgeResult>
  tprThreshold?: number
  tnrThreshold?: number
}): Promise<JudgeCalibration> {
  const judge = options.judge ?? judgeOutput
  const tprThreshold = options.tprThreshold ?? 0.9
  const tnrThreshold = options.tnrThreshold ?? 0.9
  let text: string
  try {
    text = await readFile(options.labelsPath, 'utf8')
  } catch (err) {
    throw new Error(`eval_judge_validate: cannot read labels file '${options.labelsPath}': ${(err as Error).message}`)
  }
  const labels: JudgeLabel[] = []
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  lines.forEach((line, i) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch (err) {
      throw new Error(`eval_judge_validate: labels line ${i + 1} is not valid JSON: ${(err as Error).message}`)
    }
    const v = value as Partial<Record<keyof JudgeLabel, unknown>>
    if (typeof v?.rubric !== 'string' || typeof v.output !== 'string' || (v.expect !== 'pass' && v.expect !== 'fail')) {
      throw new Error(`eval_judge_validate: labels line ${i + 1} must be {"rubric": string, "output": string, "expect": "pass"|"fail"}`)
    }
    labels.push({ rubric: v.rubric, output: v.output, expect: v.expect })
  })
  if (labels.length === 0) {
    throw new Error(`eval_judge_validate: labels file '${options.labelsPath}' has no entries`)
  }

  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0
  const mismatches: JudgeCalibration['mismatches'] = []
  // 串行：校准集是几十条量级，且 judge 是外部 API，不抢并发额度
  for (const [index, label] of labels.entries()) {
    const verdict = await judge({ rubric: label.rubric, output: label.output })
    const got = verdict.pass ? 'pass' as const : 'fail' as const
    if (label.expect === 'fail' && got === 'fail') tp++
    else if (label.expect === 'pass' && got === 'fail') fp++
    else if (label.expect === 'pass' && got === 'pass') tn++
    else fn++
    if (got !== label.expect) mismatches.push({ index, expect: label.expect, got, reason: verdict.reason })
  }
  // 以 fail 为阳性：TPR 抓真失败，TNR 不冤枉真通过
  const tpr = tp + fn === 0 ? null : tp / (tp + fn)
  const tnr = tn + fp === 0 ? null : tn / (tn + fp)
  return {
    total: labels.length,
    tp,
    fp,
    tn,
    fn,
    tpr,
    tnr,
    agreement: (tp + tn) / labels.length,
    calibrated: tpr !== null && tnr !== null && tpr >= tprThreshold && tnr >= tnrThreshold,
    mismatches,
  }
}
