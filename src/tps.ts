import { randomInt, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { parseYamlSubset } from './yaml-mini.js'

/**
 * 长上下文 TPS 标定与横评（eval_tps_run）：受控台阶式请求直接打 OpenAI 兼容
 * streaming 端点，测「瞬时 decode TPS 随上下文长度的衰减曲线」。
 *
 * 与 eval_run 的分工：eval_run 驱动真实 agent 会话做行为回归；本模块不要 agent，
 * 要的是对「请求内容」的完全控制——上下文构成、输出长度、cache 命中全部钉死，
 * 换来跨模型/跨 provider 可比的衰减数据。
 *
 * 口径纪律（横评数据的可信度全在这里，改动前先想清楚）：
 * - 瞬时 TPS，不采均速：instantTps = completion_tokens / decode 时长（首个输出
 *   chunk 到末 chunk），均速会把 prefill 与早期快段摊进来，系统性高估长上下文端。
 * - context_len 以服务端 usage.prompt_tokens 为准——名义台阶只是目标，实际吃进
 *   多少 token 只有 provider 说了算；usage 缺失时按字符估算并把样本标
 *   estimatedTokens=true（降级口径，只能看形状不能看绝对值）。
 * - cache_bust 默认开：每请求前缀随机 nonce，强制 prefix cache miss——不同
 *   provider 的 cache 策略/TTL 不同，不强制 miss 等于每家各测各的口径。
 * - 输出侧钉死：固定 temperature 与 max_output_tokens 的重复词任务——decode TPS
 *   也是输出侧的函数，输出不固定则 b 参数跨模型不可比。
 * - 预算前置：budget_tokens 必填，计划估算超预算直接拒跑；跑中实际用量超预算
 *   停止发新请求并在报告标 truncated。
 * - 串行执行：并行请求会被 provider 侧 batch 与本地事件循环污染，永不并行。
 *
 * 数字只对当次部署（provider + endpoint + 测量日期）负责：服务端硬件、batch、
 * 限速不可见。横评表是部署结论，不是架构结论——引用时这句话必须跟着数据走。
 */

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface TpsModelConfig {
  /** 报告里的展示名（横评表行名） */
  name: string
  /** OpenAI 兼容 base URL（拼 /chat/completions） */
  baseUrl: string
  /** 读 key 的环境变量名（缺省 DEEPSEEK_API_KEY，与 judge 同口径） */
  apiKeyEnv: string
  /** API 模型名 */
  model: string
}

export interface TpsConfig {
  models: TpsModelConfig[]
  /** 名义上下文台阶（token），升序去重；实际以 usage.prompt_tokens 记录 */
  steps: number[]
  /** 每台阶独立重复次数（取中位数抗抖动） */
  repeats: number
  /** 输出侧钉死：每请求生成上限 */
  maxOutputTokens: number
  /** 输出侧钉死：温度 */
  temperature: number
  /** 每台阶每 repeat 追加一发锚点召回请求（针埋在填料 10% 处），测保真衰减 */
  anchors: boolean
  /** 请求前缀随机 nonce 强制 prefix cache miss（全曲线口径一致的前提） */
  cacheBust: boolean
  /** 预算前置声明：计划估算超了拒跑；跑中实际用量超了停止发新请求 */
  budgetTokens: number
  requestTimeoutMs: number
}

const ERR = 'eval_tps_run:'

function fail(msg: string): never {
  throw new Error(`${ERR} ${msg}`)
}

function asNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${path} 必须是有限数字`)
  return v
}

function asBool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(`${path} 必须是布尔`)
  return v
}

/** 解析并校验 tps 配置（yaml 子集）；所有格式错误带 eval_tps_run: 前缀 */
export function parseTpsConfig(src: string): TpsConfig {
  let raw: unknown
  try {
    raw = parseYamlSubset(src)
  } catch (err) {
    fail(`config 解析失败：${(err as Error).message}`)
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('config 顶层必须是 map')
  const cfg = raw as Record<string, unknown>

  const rawModels = cfg.models
  if (!Array.isArray(rawModels) || rawModels.length === 0) fail('models 必须是非空序列')
  const seenNames = new Set<string>()
  const models: TpsModelConfig[] = rawModels.map((m, i) => {
    if (typeof m !== 'object' || m === null || Array.isArray(m)) fail(`models[${i}] 必须是 map`)
    const r = m as Record<string, unknown>
    if (typeof r.name !== 'string' || r.name.trim() === '') fail(`models[${i}].name 必填`)
    if (seenNames.has(r.name)) fail(`models[${i}].name 重复：${r.name}`)
    seenNames.add(r.name)
    if (typeof r.base_url !== 'string' || !/^https?:\/\//.test(r.base_url)) fail(`models[${i}].base_url 必须是 http(s) URL`)
    if (typeof r.model !== 'string' || r.model.trim() === '') fail(`models[${i}].model 必填`)
    if (r.api_key_env !== undefined && typeof r.api_key_env !== 'string') fail(`models[${i}].api_key_env 必须是字符串`)
    return {
      name: r.name,
      baseUrl: r.base_url.replace(/\/+$/, ''),
      apiKeyEnv: (r.api_key_env as string | undefined) ?? 'DEEPSEEK_API_KEY',
      model: r.model,
    }
  })

  if (!Array.isArray(cfg.steps) || cfg.steps.length === 0) fail('steps 必须是非空序列')
  const steps = cfg.steps.map((s, i) => asNumber(s, `steps[${i}]`))
  for (const s of steps) {
    if (!Number.isInteger(s) || s < 1000) fail('steps 每项必须是 >= 1000 的整数（太小的台阶测不出衰减）')
  }
  if (new Set(steps).size !== steps.length) fail('steps 有重复值')
  for (let i = 1; i < steps.length; i++) {
    if (steps[i] <= steps[i - 1]) fail('steps 必须严格升序')
  }

  const repeats = cfg.repeats === undefined ? 3 : asNumber(cfg.repeats, 'repeats')
  if (!Number.isInteger(repeats) || repeats < 1) fail('repeats 必须是正整数')
  const maxOutputTokens = cfg.max_output_tokens === undefined ? 512 : asNumber(cfg.max_output_tokens, 'max_output_tokens')
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 64) fail('max_output_tokens 必须是 >= 64 的整数（太短测不出 decode 速度）')
  const temperature = cfg.temperature === undefined ? 0 : asNumber(cfg.temperature, 'temperature')
  if (temperature < 0 || temperature > 2) fail('temperature 必须在 [0, 2]')
  const anchors = cfg.anchors === undefined ? false : asBool(cfg.anchors, 'anchors')
  const cacheBust = cfg.cache_bust === undefined ? true : asBool(cfg.cache_bust, 'cache_bust')
  if (cfg.budget_tokens === undefined) fail('budget_tokens 必填——预算前置声明是硬约束，不接受事后补账')
  const budgetTokens = asNumber(cfg.budget_tokens, 'budget_tokens')
  if (!Number.isInteger(budgetTokens) || budgetTokens <= 0) fail('budget_tokens 必须是正整数')
  const requestTimeoutMs = cfg.request_timeout_ms === undefined ? 300_000 : asNumber(cfg.request_timeout_ms, 'request_timeout_ms')
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 5000) fail('request_timeout_ms 必须是 >= 5000 的整数')

  return { models, steps, repeats, maxOutputTokens, temperature, anchors, cacheBust, budgetTokens, requestTimeoutMs }
}

// ---------------------------------------------------------------------------
// 填料与 prompt 构造
// ---------------------------------------------------------------------------

/**
 * 英文技术散文的 token 密度经验值（chars/token）。只用于把填料造到名义台阶
 * 附近——实测 context_len 一律以 usage.prompt_tokens 为准，这个估值不进报告。
 */
const CHARS_PER_TOKEN = 3.5

const FILLER_PARAGRAPH =
  'The build system resolves the module graph before it schedules any compilation unit. ' +
  'Each target declares its sources, its headers, and the interfaces it imports from sibling targets. ' +
  'When a declaration changes, only the dependents of that interface are scheduled for recompilation, ' +
  'which keeps incremental builds proportional to the size of the change rather than the size of the tree. ' +
  'Cache entries are keyed by the digest of the compiler flags, the source content, and the resolved dependency set.'

/** 锚点针用词表：常见到模型一定认识、生僻到不会撞进填料散文 */
export const ANCHOR_WORDS = ['falcon', 'lattice', 'ember', 'quartz', 'harbor', 'willow', 'cinder', 'maple']

/**
 * 造填料：段落编号 + 固定语料重复到目标 token 附近（按段落边界截断，宁少不多）。
 * needle 给定时插到约 10% 深度处（模拟「早期信息」的召回场景）。
 * 输出确定（不依赖随机数），同一个调用参数永远得到同一段填料。
 */
export function buildFiller(targetTokens: number, needle?: string): string {
  const targetChars = Math.max(0, Math.floor(targetTokens * CHARS_PER_TOKEN))
  const paragraphs: string[] = []
  let chars = 0
  for (let i = 1; chars < targetChars; i++) {
    const p = `Paragraph ${i}. ${FILLER_PARAGRAPH}`
    paragraphs.push(p)
    chars += p.length + 2
  }
  if (needle !== undefined && paragraphs.length > 0) {
    const at = Math.min(paragraphs.length - 1, Math.floor(paragraphs.length * 0.1))
    paragraphs.splice(at, 0, needle)
  }
  return paragraphs.join('\n\n')
}

/** TPS 请求的用户消息：nonce（cache bust）+ 填料 + 钉死的重复词输出任务 */
export function buildTpsPrompt(filler: string, maxOutputTokens: number, cacheBust: boolean): string {
  const head = cacheBust ? `Request-Id: ${randomUUID()}\n\n` : ''
  return (
    `${head}${filler}\n\n---\nIgnore the text above. ` +
    `Reply with the word "ok" repeated ${maxOutputTokens} times, separated by single spaces. Output nothing else.`
  )
}

/** 锚点召回请求：与 TPS 请求同一份填料（同一条针），短答即可 */
export function buildAnchorPrompt(filler: string, cacheBust: boolean): string {
  const head = cacheBust ? `Request-Id: ${randomUUID()}\n\n` : ''
  return `${head}${filler}\n\n---\nThe text above contains a code word for this session. Reply with only the code word, nothing else.`
}

export function buildNeedle(word: string): string {
  return `Important note: the code word for this session is "${word}". Remember it exactly.`
}

// ---------------------------------------------------------------------------
// 流式测量
// ---------------------------------------------------------------------------

export interface TpsMeasurement {
  /** 服务端口径；usage 缺失时为字符估算值且 estimatedTokens=true */
  promptTokens: number | null
  completionTokens: number | null
  reasoningTokens: number | null
  /** true = provider 没回 usage，token 数是字符估算——只能看曲线形状，别看绝对值 */
  estimatedTokens: boolean
  /** 首个任意输出 chunk（含 reasoning）的到达时间；含网络 + prefill */
  ttftMs: number | null
  /** 首个正文 chunk 的到达时间（reasoning 模型两者会拉开） */
  ttftContentMs: number | null
  /** 首个输出 chunk 到末 chunk 的时长 */
  decodeMs: number | null
  /** completion_tokens / decode 秒数；decode 窗口过短（<3 chunk）时为 null */
  instantTps: number | null
  finishReason: string | null
  outputChars: number
  /** 原始 usage JSON 原样落盘（口径日后可重算） */
  usage: unknown
  /** [offsetMs, chars] 输出 chunk 序列（content + reasoning 合并计字符） */
  chunks: [number, number][]
  /** 完整输出文本的截断（前 300 字符，锚点判定与排障用） */
  answer: string
  /** 样本级错误（HTTP/超时/流解析失败）；不为 null 时该样本不进中位数与拟合 */
  error: string | null
}

/** chunk 序列的落盘上限：超长输出截断防报告膨胀（正常 512 token 输出约几百 chunk） */
const MAX_CHUNKS = 10_000

interface StreamChunk {
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null } | null
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  } | null
}

/**
 * 单发流式请求的测量。任何失败都收进 measurement.error，绝不 throw——
 * 样本级隔离：一家 provider 抽风不该炸掉整个横评（与 mock.plugins 安装失败
 * 记 error 同语义：失败是数据，不是事故）。
 *
 * now 可注入假时钟：测试用脚本化时间戳断言 TPS 计算，不碰真实墙钟。
 */
export async function measureRequest(options: {
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  maxTokens: number
  temperature: number
  timeoutMs: number
  now?: () => number
}): Promise<TpsMeasurement> {
  const now = options.now ?? (() => performance.now())
  const base: TpsMeasurement = {
    promptTokens: null,
    completionTokens: null,
    reasoningTokens: null,
    estimatedTokens: false,
    ttftMs: null,
    ttftContentMs: null,
    decodeMs: null,
    instantTps: null,
    finishReason: null,
    outputChars: 0,
    usage: null,
    chunks: [],
    answer: '',
    error: null,
  }

  const t0 = now()
  let res: Response
  try {
    res = await fetch(`${options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: options.prompt }],
        temperature: options.temperature,
        max_tokens: options.maxTokens,
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
    })
  } catch (err) {
    base.error = `request failed: ${(err as Error).message}`
    return base
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    base.error = `HTTP ${res.status}: ${text.slice(-300)}`
    return base
  }
  if (res.body === null) {
    base.error = 'response has no body (streaming expected)'
    return base
  }

  let firstAnyMs: number | null = null
  let lastChunkMs: number | null = null
  let answer = ''
  try {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // OpenAI 兼容流一事件一行 data:；按行处理即可（各家实际格式）
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') continue
        let chunk: StreamChunk
        try {
          chunk = JSON.parse(payload) as StreamChunk
        } catch {
          continue // 半事件/心跳：跳过，不判死整个样本
        }
        if (chunk.usage != null) base.usage = chunk.usage
        const choice = chunk.choices?.[0]
        if (choice === undefined || choice === null) continue
        if (typeof choice.finish_reason === 'string') base.finishReason = choice.finish_reason
        const delta = choice.delta
        const piece = (delta?.content ?? '') + (delta?.reasoning_content ?? '')
        if (piece === '') continue
        const ms = now() - t0
        if (firstAnyMs === null) {
          firstAnyMs = ms
          base.ttftMs = ms
        }
        if (base.ttftContentMs === null && (delta?.content ?? '') !== '') base.ttftContentMs = ms
        lastChunkMs = ms
        if (base.chunks.length < MAX_CHUNKS) base.chunks.push([Math.round(ms * 100) / 100, piece.length])
        base.outputChars += piece.length
        if ((delta?.content ?? '') !== '' && answer.length < 300) answer = (answer + delta?.content).slice(0, 300)
      }
    }
  } catch (err) {
    base.error = `stream read failed: ${(err as Error).message}`
    return base
  }
  base.answer = answer

  const usage = base.usage as StreamChunk['usage']
  if (usage !== null && usage !== undefined && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
    base.promptTokens = usage.prompt_tokens
    base.completionTokens = usage.completion_tokens
    base.reasoningTokens = typeof usage.completion_tokens_details?.reasoning_tokens === 'number' ? usage.completion_tokens_details.reasoning_tokens : null
  } else {
    // 降级口径：usage 缺失时按字符估算——形状可参考，绝对值不可信
    base.estimatedTokens = true
    base.promptTokens = Math.round(options.prompt.length / CHARS_PER_TOKEN)
    base.completionTokens = Math.round(base.outputChars / 4)
  }

  if (firstAnyMs !== null && lastChunkMs !== null && lastChunkMs > firstAnyMs && base.chunks.length >= 3) {
    base.decodeMs = Math.round((lastChunkMs - firstAnyMs) * 100) / 100
    if (base.completionTokens !== null && base.completionTokens > 0) {
      base.instantTps = Math.round((base.completionTokens / (base.decodeMs / 1000)) * 100) / 100
    }
  }
  return base
}

// ---------------------------------------------------------------------------
// 聚合与拟合
// ---------------------------------------------------------------------------

/** 中位数：偶数个取中间两值平均 */
export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export interface TpsFit {
  /** tps(n) = 1/(a + b·n) 的 a（毫秒口径：秒/token 的固定项；1/a = 速度地板 tok/s） */
  a: number
  /** b：每 token 上下文的 decode 秒数增量——KV 搬运效率，跨模型比较的核心量 */
  b: number
  /** 基准速度 1/a（n=0 处的拟合值） */
  baselineTps: number
  /** 半速点：瞬时 TPS 掉到基准一半的上下文长度 = a/b；b<=0（未观测到衰减）时 null */
  halfSpeedContext: number | null
  /** z=1/tps 尺度上的 R²；<0.9 时 note 提示按实测点读、别硬信拟合 */
  r2: number
  /** 参与拟合的点数 */
  points: number
  /** 拟合数据源：usage（服务端口径）/ estimated（字符估算，降级） */
  source: 'usage' | 'estimated'
  note: string | null
}

/**
 * 衰减拟合：对 z = 1/tps 关于 n 做最小二乘（tps(n) = 1/(a+b·n) 的线性化）。
 * 少于 3 个点返回 null——两点必共线，拟合不出任何信息。
 */
export function fitDecay(points: { n: number; tps: number }[], source: 'usage' | 'estimated'): TpsFit | null {
  const valid = points.filter((p) => p.n > 0 && p.tps > 0).map((p) => ({ n: p.n, z: 1 / p.tps }))
  if (valid.length < 3) return null
  const meanN = valid.reduce((s, p) => s + p.n, 0) / valid.length
  const meanZ = valid.reduce((s, p) => s + p.z, 0) / valid.length
  let sxx = 0
  let sxy = 0
  for (const p of valid) {
    sxx += (p.n - meanN) ** 2
    sxy += (p.n - meanN) * (p.z - meanZ)
  }
  if (sxx === 0) return null
  const b = sxy / sxx
  const a = meanZ - b * meanN
  if (a <= 0) return null // 物理上无意义（速度地板为负）：数据太噪，宁可不报
  let ssRes = 0
  let ssTot = 0
  for (const p of valid) {
    const zHat = a + b * p.n
    ssRes += (p.z - zHat) ** 2
    ssTot += (p.z - meanZ) ** 2
  }
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot)
  // 4 位有效数字舍入：b 是 1e-8 量级，定点小数舍入会把它直接抹成 0
  const sig4 = (v: number): number => {
    if (v === 0) return 0
    const exp = Math.floor(Math.log10(Math.abs(v)))
    const f = 10 ** (exp - 3)
    return Math.round(v / f) * f
  }
  const notes: string[] = []
  if (r2 < 0.9) notes.push('残差偏大：曲线可能有膝盖（如 KV 换页、限速切换）——按实测点读曲线，别硬信拟合外推')
  if (b <= 0) notes.push('未观测到衰减（拟合 b<=0）：曲线平或上升——若这是已知陡衰减的阳性对照模型，先怀疑测量通道，再相信数据')
  return {
    a: sig4(a),
    b: b > 0 ? sig4(b) : 0,
    baselineTps: Math.round((1 / a) * 100) / 100,
    halfSpeedContext: b > 0 ? Math.round(a / b) : null,
    r2: Math.round(r2 * 1000) / 1000,
    points: valid.length,
    source,
    note: notes.length > 0 ? notes.join('；') : null,
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

export interface TpsSample extends TpsMeasurement {
  repeat: number
  nominalStep: number
  /** 锚点召回（anchors: true 时由同 (step, repeat) 的追加请求填） */
  anchor: { word: string; hit: boolean; answer: string; ttftMs: number | null } | null
}

export interface TpsStepResult {
  nominal: number
  samples: TpsSample[]
  /** 以下聚合只用 error==null 且非估算口径的样本；估算样本只在样本层可见 */
  medianPromptTokens: number | null
  medianInstantTps: number | null
  medianTtftMs: number | null
  anchorHitRate: number | null
}

export interface TpsModelResult {
  name: string
  model: string
  baseUrl: string
  steps: TpsStepResult[]
  fit: TpsFit | null
  /** fit 为 null 时的原因（点不足 / 衰减比双曲模型还陡）；fit 存在时为 null */
  fitNote: string | null
}

export interface TpsReport {
  schemaVersion: 1
  kind: 'tps-report'
  startedAt: string
  finishedAt: string
  durationMs: number
  config: Omit<TpsConfig, 'models'>
  models: TpsModelResult[]
  budget: { declared: number; planned: number; actualUsed: number; truncated: boolean }
}

/** 计划估算（token）：名义台阶 ×（1+估算余量）+ 输出上限，按 repeats/anchors 展开 */
export function estimatePlannedTokens(cfg: TpsConfig): number {
  const MARGIN = 1.15 // 填料字符→token 的估算误差余量
  const perRequest = (step: number): number => step * MARGIN + cfg.maxOutputTokens
  const perAnchor = (step: number): number => step * MARGIN + 64
  let total = 0
  for (const _m of cfg.models) {
    for (const step of cfg.steps) {
      total += cfg.repeats * perRequest(step)
      if (cfg.anchors) total += cfg.repeats * perAnchor(step)
    }
  }
  return Math.round(total)
}

function mdNum(v: number | null, digits = 1): string {
  return v === null ? '—' : v.toFixed(digits)
}

function mdInt(v: number | null): string {
  return v === null ? '—' : String(Math.round(v))
}

/** Markdown 报告：口径警示句必须跟着数据走（横评数字是部署结论，不是架构结论） */
export function renderTpsMarkdown(report: TpsReport): string {
  const lines: string[] = [
    '# 长上下文 TPS 评测报告（tps-report）',
    '',
    `- 开始时间：${report.startedAt}`,
    `- 结束时间：${report.finishedAt}`,
    `- 总耗时：${report.durationMs} ms`,
    `- 配置：steps=${report.config.steps.join('/')}，repeats=${report.config.repeats}，max_output_tokens=${report.config.maxOutputTokens}，temperature=${report.config.temperature}，cache_bust=${report.config.cacheBust ? 'on' : 'off'}，anchors=${report.config.anchors ? 'on' : 'off'}`,
    `- 预算：声明 ${report.budget.declared} / 计划估算 ${report.budget.planned} / 实际 ${report.budget.actualUsed}${report.budget.truncated ? '（**超预算截断**，曲线不完整）' : ''}`,
    '',
    '> **口径警示**：瞬时 TPS = completion_tokens / decode 时长，context_len 取服务端 usage.prompt_tokens。数字只对当次部署（provider + endpoint + 测量日期）负责——服务端硬件、batch、限速不可见。**横评表是部署结论，不是架构结论。**',
    '',
  ]

  for (const m of report.models) {
    lines.push(`## ${m.name}`, '')
    lines.push(`- model：\`${m.model}\`　base_url：\`${m.baseUrl}\``)
    if (m.fit !== null) {
      const f = m.fit
      lines.push(
        `- 拟合 tps(n) = 1/(a + b·n)：a=${f.a}，b=${f.b}，基准 ${f.baselineTps} tok/s，半速点 n½=${f.halfSpeedContext === null ? '未观测到衰减' : `${f.halfSpeedContext} tokens`}，R²=${f.r2}（z 尺度，${f.points} 点${f.source === 'estimated' ? '，**字符估算口径**' : ''}）`,
      )
      if (f.note !== null) lines.push(`- ⚠ ${f.note}`)
    } else {
      lines.push(`- 拟合：${m.fitNote ?? '无'}`)
    }
    lines.push('')
    lines.push('| 名义台阶 | 实测 context（中位） | 瞬时 TPS（中位） | TTFT ms（中位） | 锚点命中 | 样本（有效/总数） |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const s of m.steps) {
      const valid = s.samples.filter((x) => x.error === null && x.instantTps !== null && !x.estimatedTokens).length
      lines.push(
        `| ${s.nominal} | ${mdInt(s.medianPromptTokens)} | ${mdNum(s.medianInstantTps)} | ${mdInt(s.medianTtftMs)} | ${s.anchorHitRate === null ? '—' : `${Math.round(s.anchorHitRate * 100)}%`} | ${valid}/${s.samples.length} |`,
      )
    }
    lines.push('')
  }

  lines.push('## 横评汇总', '')
  lines.push('| 模型 | 基准 tok/s (1/a) | b (s/token) | 半速点 n½ | R² |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const m of report.models) {
    if (m.fit === null) {
      lines.push(`| ${m.name} | — | — | — | — |`)
    } else {
      lines.push(
        `| ${m.name} | ${m.fit.baselineTps} | ${m.fit.b} | ${m.fit.halfSpeedContext === null ? '未衰减' : m.fit.halfSpeedContext} | ${m.fit.r2} |`,
      )
    }
  }
  lines.push('')
  lines.push('注：b 越小曲线越平（KV 搬运效率越高）；n½ 越大越能扛长上下文。拟合点不足 3 的模型不进汇总解读。建议每次横评带一个已知陡衰减的模型作阳性对照——测不出衰减时先怀疑测量通道，再相信架构。')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export interface RunTpsEvalOptions {
  configPath: string
  outputDir: string
  /** 只出计划与预算估算，不发请求、不写文件 */
  dryRun?: boolean
  /** 只跑这些展示名（精确匹配） */
  only?: string[]
  /** 测试注入点：替换底层测量（默认真实 HTTP） */
  measure?: typeof measureRequest
  now?: () => number
}

export interface RunTpsEvalResult {
  report: TpsReport | null
  plannedTokens: number
  requestCount: number
  reportJsonPath: string
  reportMdPath: string
}

export async function runTpsEval(options: RunTpsEvalOptions): Promise<RunTpsEvalResult> {
  let src: string
  try {
    src = await readFile(options.configPath, 'utf8')
  } catch (err) {
    fail(`cannot read config '${options.configPath}': ${(err as Error).message}`)
  }
  const cfg = parseTpsConfig(src)
  const models = options.only === undefined ? cfg.models : cfg.models.filter((m) => options.only?.includes(m.name))
  if (options.only !== undefined && models.length === 0) fail(`only 筛选后无命中模型（可选：${cfg.models.map((m) => m.name).join(', ')}）`)
  const effective: TpsConfig = { ...cfg, models }

  const planned = estimatePlannedTokens(effective)
  const requestCount =
    effective.models.length * effective.steps.length * effective.repeats * (effective.anchors ? 2 : 1)
  const reportJsonPath = join(options.outputDir, 'tps-report.json')
  const reportMdPath = join(options.outputDir, 'tps-report.md')

  if (options.dryRun === true) {
    return { report: null, plannedTokens: planned, requestCount, reportJsonPath, reportMdPath }
  }
  if (planned > cfg.budgetTokens) {
    fail(`计划估算 ${planned} tokens 超出 budget_tokens=${cfg.budgetTokens}——砍台阶/降 repeats/提预算，三选一，不接受裸跑`)
  }

  // key 检查前置：宁可启动即死，不要跑到一半才发现缺 key
  for (const m of effective.models) {
    if (!process.env[m.apiKeyEnv]) fail(`模型 ${m.name} 缺 API key：环境变量 ${m.apiKeyEnv} 未设置`)
  }

  const measure = options.measure ?? measureRequest
  const now = options.now ?? (() => performance.now())
  const startedAt = new Date()
  const t0 = now()
  let actualUsed = 0
  let truncated = false

  const results: TpsModelResult[] = []
  for (const m of effective.models) {
    const stepResults: TpsStepResult[] = []
    for (const step of effective.steps) {
      const samples: TpsSample[] = []
      for (let r = 0; r < effective.repeats; r++) {
        if (truncated) break
        // 预算截断：实际用量超声明预算就停止发新请求（已完成的样本保留）
        if (actualUsed >= cfg.budgetTokens) {
          truncated = true
          break
        }
        const word = effective.anchors ? ANCHOR_WORDS[randomInt(ANCHOR_WORDS.length)] : undefined
        const needle = word === undefined ? undefined : buildNeedle(word)
        // 填料按「名义台阶 - 输出预留」造，让 prompt tokens 落在台阶附近
        const filler = buildFiller(step - effective.maxOutputTokens, needle)
        const prompt = buildTpsPrompt(filler, effective.maxOutputTokens, effective.cacheBust)
        const measurement = await measure({
          baseUrl: m.baseUrl,
          apiKey: String(process.env[m.apiKeyEnv]),
          model: m.model,
          prompt,
          maxTokens: effective.maxOutputTokens,
          temperature: effective.temperature,
          timeoutMs: effective.requestTimeoutMs,
        })
        actualUsed += (measurement.promptTokens ?? 0) + (measurement.completionTokens ?? 0)
        const sample: TpsSample = { ...measurement, repeat: r, nominalStep: step, anchor: null }

        if (word !== undefined) {
          const anchorMeasurement = await measure({
            baseUrl: m.baseUrl,
            apiKey: String(process.env[m.apiKeyEnv]),
            model: m.model,
            prompt: buildAnchorPrompt(filler, effective.cacheBust),
            maxTokens: 64,
            temperature: effective.temperature,
            timeoutMs: effective.requestTimeoutMs,
          })
          actualUsed += (anchorMeasurement.promptTokens ?? 0) + (anchorMeasurement.completionTokens ?? 0)
          sample.anchor = {
            word,
            hit: anchorMeasurement.answer.toLowerCase().includes(word.toLowerCase()),
            answer: anchorMeasurement.answer,
            ttftMs: anchorMeasurement.ttftMs,
          }
        }
        samples.push(sample)
      }
      const usable = samples.filter((s) => s.error === null && s.instantTps !== null && !s.estimatedTokens)
      const anchorSamples = samples.filter((s) => s.anchor !== null)
      stepResults.push({
        nominal: step,
        samples,
        medianPromptTokens: median(usable.map((s) => s.promptTokens).filter((v): v is number => v !== null)),
        medianInstantTps: median(usable.map((s) => s.instantTps).filter((v): v is number => v !== null)),
        medianTtftMs: median(usable.map((s) => s.ttftMs).filter((v): v is number => v !== null)),
        anchorHitRate:
          anchorSamples.length === 0 ? null : anchorSamples.filter((s) => s.anchor?.hit === true).length / anchorSamples.length,
      })
    }
    // 拟合数据源：优先服务端 usage 口径；usage 样本不足 3 才降级用估算样本（报告注明）
    const usagePoints = stepResults.flatMap((s) =>
      s.samples
        .filter((x) => x.error === null && x.instantTps !== null && !x.estimatedTokens && x.promptTokens !== null)
        .map((x) => ({ n: x.promptTokens as number, tps: x.instantTps as number })),
    )
    const estimatedPoints = stepResults.flatMap((s) =>
      s.samples
        .filter((x) => x.error === null && x.instantTps !== null && x.estimatedTokens && x.promptTokens !== null)
        .map((x) => ({ n: x.promptTokens as number, tps: x.instantTps as number })),
    )
    const fitSource: 'usage' | 'estimated' = usagePoints.length >= 3 ? 'usage' : 'estimated'
    const fitPoints = fitSource === 'usage' ? usagePoints : estimatedPoints
    const fit = fitDecay(fitPoints, fitSource)
    // fit 为 null 的两种情形要分清：点真的不够，或点够但衰减比 1/(a+b·n) 还陡
    // （a<=0，双曲模型兜不住——这本身就是「有膝盖」的信号，不是拟合失败）
    const fitNote =
      fit !== null
        ? null
        : fitPoints.length < 3
          ? `有效拟合点不足（${fitPoints.length}/3），看实测表`
          : '衰减比 1/(a+b·n) 模型还陡（拟合 a<=0）——曲线有膝盖或前段有额外热源，按实测点读，不做外推'
    results.push({ name: m.name, model: m.model, baseUrl: m.baseUrl, steps: stepResults, fit, fitNote })
  }

  const finishedAt = new Date()
  const { models: _models, ...configEcho } = effective
  const report: TpsReport = {
    schemaVersion: 1,
    kind: 'tps-report',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.round(now() - t0),
    config: configEcho,
    models: results,
    budget: { declared: cfg.budgetTokens, planned, actualUsed, truncated },
  }

  await mkdir(options.outputDir, { recursive: true })
  await writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await writeFile(reportMdPath, renderTpsMarkdown(report), 'utf8')
  return { report, plannedTokens: planned, requestCount, reportJsonPath, reportMdPath }
}
