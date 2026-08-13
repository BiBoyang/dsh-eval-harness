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
  /** 聚合 token（input+output）上限 */
  max_tokens?: number
}

/** 单条评测用例 */
export interface EvalCase {
  name: string
  prompt: string
  require_plugins?: string[]
  assert: EvalAssert
}

/** 聚合 token 用量 */
export interface TokenUsage {
  input: number
  output: number
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
  /** 累加 assistant/message 的 usage.inputTokens/outputTokens */
  tokens: TokenUsage
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
