/** 评测用例断言（cases/*.yml 的 assert 段） */
export interface EvalAssert {
  /** 对应 turn/end 事件 data.reason.kind */
  turn_end?: string
  /** tool/call 名称序列须按序包含（保序子序列匹配） */
  tools_called?: string[]
  /** 最终 assistant 文本须包含全部关键词 */
  output_contains?: string[]
  /** step/end 事件数上限 */
  max_steps?: number
  /** 聚合 token 上限（input+output+reasoning；缓存命中 cacheRead 不计入） */
  max_tokens?: number
  /** true 时任何工具硬错误（tool/result 带 error 或 isError）即 fail */
  no_tool_errors?: boolean
}

/** 单条评测用例 */
export interface EvalCase {
  name: string
  prompt: string
  require_plugins?: string[]
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
  /** tool/call 名称序列（按出现顺序） */
  toolsCalled: string[]
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
  finalText: string
  steps: number
  tokens: TokenUsage
  /** tool/result 的硬错误列表（无则为空数组） */
  toolErrors: ToolError[]
  durationMs: number
}

/** eval_run 产出的报告（写 <output_dir>/report.json） */
export interface RunReport {
  tool: 'dsh-eval-harness'
  version: string
  startedAt: string
  profile: string
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
}
