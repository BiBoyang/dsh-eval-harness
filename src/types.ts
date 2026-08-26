/** 评测用例断言（cases/*.yml 的 assert 段） */
export interface EvalAssert {
  /** 对应 turn/end 事件 data.reason.kind */
  turn_end?: string
  /** tool/call 名称序列须按序包含（保序子序列匹配） */
  tools_called?: string[]
  /** tool/call 名称序列完全相等（长度+顺序+内容），表达"恰好调用这些" */
  tools_exact?: string[]
  /** 这些工具一次都不许出现 */
  tools_not_called?: string[]
  /** 最终 assistant 文本须包含全部关键词 */
  output_contains?: string[]
  /** 最终 assistant 文本不得包含任一关键词 */
  output_not_contains?: string[]
  /** 最终 assistant 文本须匹配全部正则（字符串形式，非法正则在用例解析阶段报错） */
  output_matches?: string[]
  /** 至少存在一次对 name 的调用，其 arguments 序列化后包含 contains */
  tool_args_contains?: ToolPattern[]
  /** 至少存在一次 name 的结果，其结果文本包含 contains */
  tool_result_contains?: ToolPattern[]
  /** step/end 事件数上限 */
  max_steps?: number
  /** 聚合 token 上限（input+output+reasoning；缓存命中 cacheRead 不计入） */
  max_tokens?: number
  /** true 时任何工具硬错误（tool/result 带 error 或 isError）即 fail */
  no_tool_errors?: boolean
  /** LLM-as-judge 语义断言（结构断言全过后才调；判 FAIL 的理由只进 failures 消息） */
  output_judge?: OutputJudgeAssert
}

/** output_judge 的判定标准（rubric 须可判定、避免主观词，judge 按二元 PASS/FAIL 评） */
export interface OutputJudgeAssert {
  rubric: string
}

/** tool_args_contains / tool_result_contains 的匹配模式 */
export interface ToolPattern {
  name: string
  contains: string
}

/** 一次 tool/call 的记录（arguments 统一序列化为 JSON 字符串） */
export interface ToolCallRecord {
  name: string
  callId?: string
  argsJson: string
}

/** 一次 tool/result 的记录（text 为结果纯文本，兼容真实落盘与旧形状） */
export interface ToolResultRecord {
  name: string
  callId?: string
  text: string
}

/** 单条评测用例 */
export interface EvalCase {
  name: string
  prompt: string
  require_plugins?: string[]
  /** 用例标签（元信息；eval_run 的 tags 筛选按任一命中匹配） */
  tags?: string[]
  /** 失败重跑次数（非负整数；缺省用 eval_run 的全局 retries，最终至少跑一次） */
  retries?: number
  /** 可靠性测量的独立 trial 次数（正整数；缺省用 eval_run 的全局 trials，默认 1 单次）。trials > 1 时忽略 retries——测量必须是没有重试干预的原始单次成功率 */
  trials?: number
  assert: EvalAssert
}

/**
 * 聚合 token 用量（分字段；与 DSH TokenUsage 对齐，计数互斥：
 * inputTokens 仅未缓存输入，缓存部分单独计入 cacheRead/cacheWrite）。
 * total = input + output + reasoning——cacheRead 是缓存命中读回，多步会话里
 * 同一段缓存每步重复读，全额累加会让 max_tokens 随步数膨胀；故不进 total，
 * 但 cacheRead/cacheWrite 仍单独保留供观察。
 */
export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
}

/** 工具硬错误（tool/result 的 data.error 或 isError） */
export interface ToolError {
  /** 工具名（经 tool/call 的 callId 关联；拿不到则为 callId 或 '<unknown>'） */
  name: string
  /** 错误摘要（截断到 200 字符） */
  error: string
}

export function emptyTokenUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }
}

/** collector 从 session.jsonl 提取的观测结果 */
export interface CollectedTrace {
  /** 最后一个 turn/end 的 reason.kind */
  turnEnd?: string
  /** tool/call 名称序列（按出现顺序）——保留旧字段兼容旧报告 */
  toolsCalled: string[]
  /** tool/call 完整记录（含 arguments 序列化串） */
  toolCalls: ToolCallRecord[]
  /** tool/result 完整记录（含结果文本） */
  toolResults: ToolResultRecord[]
  /** 最后一条 assistant/message 的文本 */
  finalText: string
  /** step/end 事件数 */
  steps: number
  /** 累加 assistant/message 的 usage 各字段（含 cacheRead/cacheWrite/reasoning） */
  tokens: TokenUsage
  /** tool/result 的硬错误列表（无则为空数组） */
  toolErrors: ToolError[]
  /** 成功解析的事件帧数 */
  events: number
  /** 跳过的不良行数 */
  skippedLines: number
}

export type CaseStatus = 'pass' | 'fail' | 'error'

/** 当前 report.json 数据结构版本；schema 0 表示无 schemaVersion 的 legacy 报告。 */
export const CURRENT_REPORT_SCHEMA_VERSION = 1
export type ReportSchemaVersion = 0 | 1

/** 单次 attempt 的完整结果；CaseResult 顶层字段是最后一次 attempt 的兼容投影。 */
export interface AttemptResult {
  index: number
  status: CaseStatus
  failures: string[]
  error?: string
  turnEnd?: string
  toolsCalled: string[]
  toolCalls: ToolCallRecord[]
  toolResults: ToolResultRecord[]
  finalText: string
  steps: number
  tokens: TokenUsage
  toolErrors: ToolError[]
  events: number
  skippedLines: number
  exitCode?: number | null
  timedOut?: boolean
  stderrTail?: string
  durationMs: number
}

/** 每条用例的可靠性测量（trials > 1 时写入；trials = 1 时省略） */
export interface CaseReliability {
  /** 独立 trial 次数 */
  trials: number
  /** 通过的 trial 数 */
  passes: number
  /** 单次成功率 passes/trials */
  successRate: number
  /** 无偏估计：k 次独立尝试至少一次通过的概率（1 - C(n-c,k)/C(n,k)） */
  passAtK: number
  /** k 次独立尝试全部通过的概率（(c/n)^k） */
  passPowK: number
  /** passAtK/passPowK 使用的 k（约束 k ≤ trials） */
  k: number
}

/** 单条用例运行结果 */
export interface CaseResult {
  name: string
  status: CaseStatus
  /** 断言失败消息列表（status=fail 时非空） */
  failures: string[]
  /** 运行/采集层错误（status=error 时存在） */
  error?: string
  turnEnd?: string
  toolsCalled: string[]
  /** tool/call 完整记录（含 arguments 序列化串） */
  toolCalls: ToolCallRecord[]
  /** tool/result 完整记录（含结果文本） */
  toolResults: ToolResultRecord[]
  finalText: string
  steps: number
  tokens: TokenUsage
  /** tool/result 的硬错误列表（无则为空数组） */
  toolErrors: ToolError[]
  /** 成功解析的 session trace 事件帧数 */
  events: number
  /** collector 跳过的不良 JSONL 行数 */
  skippedLines: number
  /** dsh 子进程退出码；被信号终止时为 null，spawn 前失败时省略 */
  exitCode?: number | null
  /** dsh 子进程是否由单条用例 timeout 触发强制终止 */
  timedOut?: boolean
  /** dsh stderr 尾部（最多 8192 字符；空时省略） */
  stderrTail?: string
  durationMs: number
  /** 实际执行的 attempt 次数（失败重跑生效时最多 retries+1；首跑即过为 1） */
  attempts: number
  /** 每次 attempt 的完整结果，按执行顺序排列；schema 0/旧 schema 1 由 loader 合成单项历史。 */
  attemptResults: AttemptResult[]
  /** 最终 pass 但中途有失败 attempt 时为 true（flaky 标记；其余情况省略） */
  flaky?: boolean
  /** trials > 1 时的可靠性测量；单次运行的用例省略 */
  reliability?: CaseReliability
}

/** eval_run 产出的报告（写 <output_dir>/report.json） */
export interface RunReport {
  schemaVersion: ReportSchemaVersion
  tool: 'dsh-eval-harness'
  version: string
  startedAt: string
  finishedAt: string
  /** 整次 runEval 墙钟耗时（含 dsh 探针、用例加载、执行与报告生成前处理） */
  durationMs: number
  profile: string
  /** dsh --version 探针 stdout（首行）；schema 0/旧报告缺省 */
  dshVersion?: string
  cases: CaseResult[]
  summary: {
    total: number
    passed: number
    failed: number
    errored: number
  }
}

export type GateVerdict = 'PASS' | 'WARN' | 'FAIL' | 'N/A'

/** 单条用例的前后状态对比 */
export interface GateDiff {
  name: string
  before: CaseStatus | 'absent'
  after: CaseStatus | 'absent'
}

/** eval_gate 产出的门禁报告 */
export interface GateReport {
  verdict: GateVerdict
  /** PASS=0，FAIL=1，N/A=2，WARN=0（strict 时 2） */
  exitCode: number
  strict: boolean
  reasons: string[]
  /** PASS → FAIL/error */
  regressions: GateDiff[]
  /** baseline 不存在且本次 FAIL/error 的新增用例 */
  newFailures: GateDiff[]
  /** FAIL/error → PASS */
  improvements: GateDiff[]
  /** 本次新增的通过用例名 */
  added: string[]
  /** baseline 有而本次没有的用例名 */
  removed: string[]
  /** 状态不变但 token total 涨幅超阈值的用例（before/after 为 total 值） */
  tokenRegressions: GateTokenDiff[]
  /** 状态不变但 skippedLines 增长的用例（trace 解析漏帧增多，断言可能基于残缺数据） */
  skippedLineIncreases: GateSkippedLinesDiff[]
  /** 本次新增 flaky（重跑后才过）的用例名；baseline 中已 flaky 的不重复计（防告警疲劳） */
  flakyCases: string[]
  /** baseline 里仍带 flaky 标记的用例名（baseline hygiene 提示，不影响判定） */
  baselineFlakyCases: string[]
  /** pass 但 toolErrors 非空（agent 自我纠正了工具错误）且较 baseline 新增的用例名 */
  toolErrorRecoveries: string[]
  /** 同一 stderr 错误签名出现 >= 2 次的聚合（「崩在同一处」的共享态事故信号） */
  repeatedErrorSignatures: ErrorSignatureGroup[]
  /** dsh 版本较 baseline 变化（informational：跨版本结果不可直接比，但不影响判定） */
  dshVersionChange?: { before: string; after: string }
  /** 可靠性不达标的 trials 用例（仅当 gate 开启 minTrialSuccessRate 时产生） */
  unreliableCases: GateUnreliableCase[]
}

/** stderr 错误签名聚合分组（extractErrorSignature 的产物，跨用例/跨 attempt） */
export interface ErrorSignatureGroup {
  /** `<错误码>@<栈顶应用帧函数>` */
  signature: string
  /** 出现总次数 */
  occurrences: number
  /** 涉及的用例名（去重，按报告顺序） */
  cases: string[]
}

/** skippedLines 增长明细（before/after 为跳过的不良 JSONL 行数） */
export interface GateSkippedLinesDiff {
  name: string
  before: number
  after: number
}

/** token 回归明细（total = input+output+reasoning，与 max_tokens 同口径） */
export interface GateTokenDiff {
  name: string
  before: number
  after: number
  /** 涨幅百分比（(after-before)/before*100，取整） */
  increasePct: number
}

/** trials 可靠性不达标的用例（successRate 的单侧 95% Wilson 下界低于阈值） */
export interface GateUnreliableCase {
  name: string
  /** 观测单次成功率 passes/trials */
  successRate: number
  /** 单侧 95% Wilson 下置信界——门禁判的是它，不是点估计 */
  lowerBound: number
  trials: number
}
