/**
 * 内置确定性 mock LLM provider（零依赖，仅 Node 内置模块）。
 *
 * 同一端口挂三协议流式端点 + 故障注入 F0-F5，把协议异常路径变成可离线回归的确定性断言：
 *   POST /v1/chat/completions   OpenAI Chat Completions（SSE）
 *   POST /v1/responses          OpenAI Responses API（SSE）
 *   POST /v1/messages           Anthropic Messages API（SSE）
 * 辅助端点：GET /health、GET /v1/models、POST /v1/messages/count_tokens、
 * GET|POST /__control（查询/切换故障，支持 once + match/avoid 子串条件）。
 *
 * 故障形态（取值优先级：URL ?fault= > 请求头 x-mock-fault > 控制面当前值（含 once）> 启动默认）：
 *   F0 正常完整流      全部终止证人送达，流正常关闭
 *   F1 中途干净关流    发若干事件后 TCP FIN，无终止证人
 *   F2 丢终止事件      内容全送、cc 的 [DONE] 照发，但携带 finish_reason 的末 chunk /
 *                      response.completed / message_stop 缺席，流正常关闭
 *   F3 半事件关流      发半个 SSE 事件（无结尾空行）后 FIN
 *   F4 length 截断     正文充足；Responses 方言是独立 response.incomplete 事件
 *                      （incomplete_details.reason="max_output_tokens"），不是 completed+status
 *   F5 think-only 截断 只有 reasoning/thinking，无正文，length/max_tokens 收尾（阳性对照）
 *
 * 送达证明：每个请求记录实际 write 的字节数、事件序列、终止证人送达情况、关流方式，
 * 存入返回值 MockServer.requests；opts.logDir 给定时同步追加 mock-YYYY-MM-DD.jsonl。
 * 协议事件骨架与横评项目验证过的参照实现（mock-provider/mock.mjs）逐事件对齐；
 * Responses 汇总文本（output_text.done / output_item.done 的 text）取 delta 流的严格拼接
 * （含段尾换行）——横评版曾在此与 delta 流不一致。
 *
 * @module dsh-eval-harness/mock
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

/** 故障形态编号（F0 正常，F1-F5 见模块头注释） */
export type MockFault = 'F0' | 'F1' | 'F2' | 'F3' | 'F4' | 'F5'

const VALID_FAULTS = new Set<string>(['F0', 'F1', 'F2', 'F3', 'F4', 'F5'])

/** 三个 LLM 协议端点标识 */
export type MockEndpoint = 'cc' | 'responses' | 'anthropic'

const ENDPOINTS: Record<string, MockEndpoint> = {
  '/v1/chat/completions': 'cc',
  '/v1/responses': 'responses',
  '/v1/messages': 'anthropic',
}

/** 送达证明里的终止证人送达情况（各协议互斥，只有本协议的证人可能为 true） */
export interface MockDeliveryWitnesses {
  /** cc：`[DONE]` 哨兵已送达 */
  ccDone: boolean
  /** cc：携带 finish_reason 的末 chunk 已送达 */
  ccFinishChunk: boolean
  /** responses：response.completed 已送达 */
  responsesCompleted: boolean
  /** responses：response.incomplete 已送达（F4/F5 的 length 截断方言） */
  responsesIncomplete: boolean
  /** anthropic：message_stop 已送达 */
  anthropicMessageStop: boolean
}

/** 流的收尾方式 */
export type MockEnding = 'clean' | 'fin' | 'client-abort'

/** 单个请求的送达证明（mock 侧实际写出了什么、怎么收的场） */
export interface MockDeliveryProof {
  /** 请求日志序号（server 实例内单调） */
  seq: number
  ts: string
  ip: string
  method: string
  path: string
  endpoint: MockEndpoint
  fault: MockFault
  model: string
  stream: boolean
  userAgent: string
  /** 实际 write 出去的字节总数 */
  bytesSent: number
  eventsCount: number
  /** 事件标签序列（含 [i] 下标；与协议事件名对应关系见 builder） */
  events: string[]
  witnesses: MockDeliveryWitnesses
  ending: MockEnding
  durationMs: number
  /** 请求体的 max_tokens / max_output_tokens（截断诱发参数观察） */
  reqMaxTokens: number | null
  reqBytes: number
  reqExcerpt: string
  reqTail: string
}

export interface MockServerOptions {
  /** 启动默认故障形态，默认 F0 */
  fault?: MockFault
  /** 监听端口，默认 0（ephemeral） */
  port?: number
  /** 每事件发送间隔 ms，默认 8；可被 URL ?delay= 覆盖 */
  delay?: number
  /** 给定时每个请求的送达证明同步追加 <logDir>/mock-YYYY-MM-DD.jsonl */
  logDir?: string
}

export interface MockServer {
  port: number
  baseUrl: string
  /** 送达证明数组（按请求顺序；含非流式请求） */
  requests: MockDeliveryProof[]
  /** 关闭 server 并断开全部连接（幂等安全：重复调用直接返回） */
  close(): Promise<void>
}

// ---------------- 确定性内容（段落带编号标记，截断点可观察） ----------------

const SECTIONS = [
  '【P01】第一节：问题定义。流式输出的完整性判定，本质上是一个"两个证人"问题：内容证人与终止证人。',
  '【P02】内容证人回答"这段话说到哪了"，终止证人回答"这次生成是否正常收场"。两者缺一不可。',
  '【P03】在 OpenAI Chat Completions 协议里，终止证人是末 chunk 的 finish_reason 与最后的 [DONE] 哨兵。',
  '【P04】在 OpenAI Responses 协议里，终止证人是 response.completed 事件本身，不存在 [DONE] 概念。',
  '【P05】在 Anthropic Messages 协议里，终止证人是 message_stop 事件与流的有序关闭。',
  '【P06】当两个证人同时缺席——例如连接中途断开——客户端面对的只是一段戛然而止的正文。',
  '【P07】检出率测评要回答的问题：各家 harness 在证人缺席时，能否发现自己拿到的是半截回答？',
  '【P08】本节完。以下进入第二节，讨论故障注入的工程实现。',
  '【P09】第二节：注入方法。确定性故障注入的首选是本地 mock provider，因为它控制发出的每一个字节。',
  '【P10】mock 侧日志天然构成送达证明：记录实际写出的字节数与事件序列，排除"故障没送达"的干扰。',
  '【P11】mitmproxy 手术是兜底方案：对不接受自定义 base_url 的工具，在真实响应流上做截断。',
  '【P12】手术包括三种刀法：直接断连接、删终止事件、削掉 SSE 帧结尾的空行。',
  '【P13】每种故障形态都必须配一个阳性对照，证明注入链路本身工作正常。',
  '【P14】没有阳性对照的"未检出"结论是不可靠的——可能只是手术刀没有碰到血管。',
  '【P15】本节完。以下进入第三节，讨论判定分级与记录方式。',
  '【P16】第三节：判定分级。L0 静默，半截回答当完整交付，是最危险的形态。',
  '【P17】L1 错对象，有信号但没有告诉用户回答不完整，或者把锅甩给了别的环节。',
  '【P18】L2 明确告知，工具直接说明回答被截断，用户不会被误导。检出线划在这里。',
  '【P19】L3 告知加恢复，在 L2 基础上自动重试或续写成功，是最理想的工程形态。',
  '【P20】除用户可见行为外，还要记录 transcript 打标维度：落盘会话里这条回复有没有被标记。',
  '【P21】用户可见性与机器可见性必须分开记录，二者不一致的案例恰恰是文章的好素材。',
  '【P22】每格故障跑三次取一致结果，不一致记为 flaky 并加注，不做平均主义处理。',
  '【P23】最终产出是一张工具乘以故障的检出率矩阵，外加一两个戏剧性案例的深挖。',
  '【P24】本报告完。三个证人齐了：内容完整、终止信号送达、流正常关闭。',
]
/** F4 第二遍内容（Q 标记，正文加长以诱发 length 截断） */
const SECTIONS_Q = SECTIONS.map((t) => t.replace(/P(\d\d)/g, 'Q$1'))
const REASONING_PARAS = [
  '【R01】让我想想这份报告的结构应该先搭骨架再填肉。',
  '【R02】骨架分两翼：内容证人一翼，终止证人一翼。',
  '【R03】填肉时注意每个段落都要带编号，方便事后定位截断点。',
  '【R04】再检查一下各协议的终止方言是否写对，不能一套字节打天下。',
  '【R05】最后确认阳性对照是否覆盖所有故障形态，防止假阴性。',
  '【R06】思考完毕，接下来本该输出正文——但本故障形态下正文永远不会到来。',
]

/** 非流式响应用的完整正文（段间换行，无段尾换行——与参照实现一致） */
function fullText(): string {
  return SECTIONS.join('\n')
}

/** 流式汇总文本：与 delta 流拼接严格一致（每段带段尾换行） */
function streamSummary(paras: string[]): string {
  return paras.map((p) => `${p}\n`).join('')
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ---------------- SSE 帧构造 ----------------

const sseEvent = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const sseData = (data: unknown): string => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`

// ---------------- 动作序列（fault → 逐协议帧序列） ----------------
// action: { k:'ev'|'raw', tag, frame } 写一个 SSE 帧（tag 进送达证明）
//         { k:'close', mode:'clean'|'fin' }  clean=res.end() 正常关流；fin=socket.end() 制造意外 EOF

type StreamAction =
  | { k: 'ev' | 'raw'; tag: string; frame: string }
  | { k: 'close'; mode: 'clean' | 'fin' }

function buildCcActions(model: string, fault: MockFault, nextSeq: () => number): StreamAction[] {
  const id = `chatcmpl-mock-${nextSeq()}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): string =>
    sseData({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] })
  const role: StreamAction = { k: 'ev', tag: 'cc.role', frame: chunk({ role: 'assistant', content: '' }) }
  const content = (paras: string[]): StreamAction[] =>
    paras.map((p, i) => ({ k: 'ev' as const, tag: `cc.content[${i}]`, frame: chunk({ content: `${p}\n` }) }))
  const finish = (reason: string): StreamAction => ({ k: 'ev', tag: `cc.finish(${reason})`, frame: chunk({}, reason) })
  const done: StreamAction = { k: 'raw', tag: 'cc.[DONE]', frame: sseData('[DONE]') }
  const half = SECTIONS.length >> 1
  switch (fault) {
    case 'F0':
      return [role, ...content(SECTIONS), finish('stop'), done, { k: 'close', mode: 'clean' }]
    case 'F1':
      return [role, ...content(SECTIONS.slice(0, half)), { k: 'close', mode: 'fin' }]
    case 'F2':
      // 内容全送、[DONE] 照发，但携带 finish_reason 的末 chunk 缺席
      return [role, ...content(SECTIONS), done, { k: 'close', mode: 'clean' }]
    case 'F3':
      return [
        role,
        ...content(SECTIONS.slice(0, half)),
        { k: 'raw', tag: 'cc.partial-event', frame: `data: {"id":"${id}","object":"chat.completion.chunk","cho` },
        { k: 'close', mode: 'fin' },
      ]
    case 'F4':
      return [role, ...content(SECTIONS), ...content(SECTIONS_Q), finish('length'), done, { k: 'close', mode: 'clean' }]
    case 'F5':
      return [
        { k: 'ev', tag: 'cc.role', frame: chunk({ role: 'assistant', content: null, reasoning_content: '' }) },
        ...REASONING_PARAS.map((p, i) => ({ k: 'ev' as const, tag: `cc.reasoning[${i}]`, frame: chunk({ reasoning_content: `${p}\n` }) })),
        finish('length'),
        done,
        { k: 'close', mode: 'clean' },
      ]
  }
}

function buildResponsesActions(model: string, fault: MockFault, nextSeq: () => number): StreamAction[] {
  const n = nextSeq()
  const respId = `resp_mock_${n}`
  const msgId = `msg_mock_${n}`
  const rsId = `rs_mock_${n}`
  const createdAt = Math.floor(Date.now() / 1000)
  const ev = (type: string, obj: Record<string, unknown>): StreamAction => ({ k: 'ev', tag: type, frame: sseEvent(type, { type, ...obj }) })
  // 汇总文本 = 实际发出的 delta 流严格拼接；F5 没有任何正文 delta，故为空串
  const textParas = fault === 'F4' ? [...SECTIONS, ...SECTIONS_Q] : fault === 'F5' ? [] : SECTIONS
  const text = streamSummary(textParas)
  const messageItem = { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] }
  const usage = { input_tokens: 42, output_tokens: 1024, total_tokens: 1066 }
  const respObj = (status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: respId,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output: status === 'completed' || status === 'incomplete' ? [messageItem] : [],
    usage,
    ...extra,
  })

  const created = ev('response.created', { response: respObj('in_progress') })
  // 2026-09-26 黄金样本校准（真实 DeepSeek /v1/responses 实测）：created 之后还有
  // response.in_progress；output_text.done 之后还有 response.content_part.done
  const inProgress = ev('response.in_progress', { response: respObj('in_progress') })
  const itemAdded = ev('response.output_item.added', { output_index: 0, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } })
  const partAdded = ev('response.content_part.added', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } })
  const mkDeltas = (paras: string[], pfx = ''): StreamAction[] =>
    paras.map((p, i) => ({ ...ev('response.output_text.delta', { item_id: msgId, output_index: 0, content_index: 0, delta: `${p}\n` }), tag: `${pfx}response.output_text.delta[${i}]` }))
  const deltas = mkDeltas(SECTIONS)
  const deltasQ = mkDeltas(SECTIONS_Q, 'Q.')
  const textDone = ev('response.output_text.done', { item_id: msgId, output_index: 0, content_index: 0, text })
  const partDone = ev('response.content_part.done', { item_id: msgId, output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } })
  const itemDone = ev('response.output_item.done', { output_index: 0, item: messageItem })
  const completed = ev('response.completed', { response: respObj('completed') })
  // 方言（2026-09-25 修正）：length 截断发独立事件 response.incomplete 携带 incomplete_details.reason，
  // 不是 response.completed 裹 status:"incomplete"——completed 分支不解析 status 会造成假阴性
  const completedIncomplete = ev('response.incomplete', { response: respObj('incomplete', { incomplete_details: { reason: 'max_output_tokens' } }) })

  const half = SECTIONS.length >> 1
  switch (fault) {
    case 'F0':
      return [created, inProgress, itemAdded, partAdded, ...deltas, textDone, partDone, itemDone, completed, { k: 'close', mode: 'clean' }]
    case 'F1':
      return [created, inProgress, itemAdded, partAdded, ...deltas.slice(0, half), { k: 'close', mode: 'fin' }]
    case 'F2':
      // 内容全送、汇总事件照发，但 response.completed 缺席，流正常关
      return [created, inProgress, itemAdded, partAdded, ...deltas, textDone, partDone, itemDone, { k: 'close', mode: 'clean' }]
    case 'F3':
      return [
        created,
        inProgress,
        itemAdded,
        partAdded,
        ...deltas.slice(0, half),
        { k: 'raw', tag: 'responses.partial-event', frame: 'data: {"type":"response.output_text.del' },
        { k: 'close', mode: 'fin' },
      ]
    case 'F4':
      return [created, inProgress, itemAdded, partAdded, ...deltas, ...deltasQ, textDone, partDone, itemDone, completedIncomplete, { k: 'close', mode: 'clean' }]
    case 'F5': {
      const rsn = streamSummary(REASONING_PARAS)
      return [
        created,
        inProgress,
        ev('response.output_item.added', { output_index: 0, item: { id: rsId, type: 'reasoning', summary: [] } }),
        ev('response.reasoning_summary_part.added', { item_id: rsId, output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } }),
        ...REASONING_PARAS.map((p, i) => ({
          ...ev('response.reasoning_summary_text.delta', { item_id: rsId, output_index: 0, summary_index: 0, delta: `${p}\n` }),
          tag: `reasoning_summary_text.delta[${i}]`,
        })),
        ev('response.reasoning_summary_text.done', { item_id: rsId, output_index: 0, summary_index: 0, text: rsn }),
        ev('response.output_item.done', { output_index: 0, item: { id: rsId, type: 'reasoning', summary: [{ type: 'summary_text', text: rsn }] } }),
        completedIncomplete,
        { k: 'close', mode: 'clean' },
      ]
    }
  }
}

function buildAnthropicActions(model: string, fault: MockFault, nextSeq: () => number): StreamAction[] {
  const msgId = `msg_mock_${nextSeq()}`
  const ev = (type: string, obj: Record<string, unknown>): StreamAction => ({ k: 'ev', tag: type, frame: sseEvent(type, { type, ...obj }) })
  const messageStart = ev('message_start', { message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 24, output_tokens: 1 } } })
  const blockStart = ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
  const ping = ev('ping', {})
  const mkDeltas = (paras: string[], pfx = ''): StreamAction[] =>
    paras.map((p, i) => ({ ...ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: `${p}\n` } }), tag: `${pfx}content_block_delta[${i}]` }))
  const deltas = mkDeltas(SECTIONS)
  const deltasQ = mkDeltas(SECTIONS_Q, 'Q.')
  const blockStop = ev('content_block_stop', { index: 0 })
  const msgDelta = (reason: string): StreamAction => ev('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1024 } })
  const msgStop = ev('message_stop', {})
  const half = SECTIONS.length >> 1
  switch (fault) {
    case 'F0':
      return [messageStart, blockStart, ping, ...deltas, blockStop, msgDelta('end_turn'), msgStop, { k: 'close', mode: 'clean' }]
    case 'F1':
      return [messageStart, blockStart, ...deltas.slice(0, half), { k: 'close', mode: 'fin' }]
    case 'F2':
      // 内容全送、message_delta 照发，但 message_stop 缺席，流正常关
      return [messageStart, blockStart, ping, ...deltas, blockStop, msgDelta('end_turn'), { k: 'close', mode: 'clean' }]
    case 'F3':
      return [
        messageStart,
        blockStart,
        ...deltas.slice(0, half),
        { k: 'raw', tag: 'anthropic.partial-event', frame: 'data: {"type":"content_block_del' },
        { k: 'close', mode: 'fin' },
      ]
    case 'F4':
      return [messageStart, blockStart, ping, ...deltas, ...deltasQ, blockStop, msgDelta('max_tokens'), msgStop, { k: 'close', mode: 'clean' }]
    case 'F5':
      return [
        messageStart,
        ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
        ...REASONING_PARAS.map((p, i) => ({ ...ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: `${p}\n` } }), tag: `thinking_delta[${i}]` })),
        ev('content_block_stop', { index: 0 }),
        msgDelta('max_tokens'),
        msgStop,
        { k: 'close', mode: 'clean' },
      ]
  }
}

/** 非流式响应（调试/curl 用；正文与参照实现一致） */
function nonStreamResponse(endpoint: MockEndpoint, model: string, nextSeq: () => number): Record<string, unknown> {
  const n = nextSeq()
  const ts = Math.floor(Date.now() / 1000)
  if (endpoint === 'cc') {
    return {
      id: `chatcmpl-mock-${n}`,
      object: 'chat.completion',
      created: ts,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: fullText() }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 1024, total_tokens: 1044 },
    }
  }
  if (endpoint === 'responses') {
    return {
      id: `resp_mock_${n}`,
      object: 'response',
      created_at: ts,
      status: 'completed',
      model,
      output: [{ id: `msg_mock_${n}`, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: fullText(), annotations: [] }] }],
      usage: { input_tokens: 42, output_tokens: 1024, total_tokens: 1066 },
    }
  }
  return {
    id: `msg_mock_${n}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: fullText() }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 24, output_tokens: 1024 },
  }
}

function witnessesOf(events: string[]): MockDeliveryWitnesses {
  return {
    ccDone: events.includes('cc.[DONE]'),
    ccFinishChunk: events.some((t) => t.startsWith('cc.finish(')),
    responsesCompleted: events.includes('response.completed'),
    responsesIncomplete: events.includes('response.incomplete'),
    anthropicMessageStop: events.includes('message_stop'),
  }
}

const emptyWitnesses = (): MockDeliveryWitnesses => ({ ccDone: false, ccFinishChunk: false, responsesCompleted: false, responsesIncomplete: false, anthropicMessageStop: false })

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c: Buffer) => {
      data += c
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(data))
  })
}

const firstHeader = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''))

/**
 * 启动 mock server。监听 127.0.0.1（不对外），返回端口、baseUrl、送达证明数组与 close()。
 * close() 会先断开全部 keep-alive 连接再关 listener，保证进程能干净退出。
 */
export async function startMockServer(opts: MockServerOptions = {}): Promise<MockServer> {
  const defaultFault = opts.fault ?? 'F0'
  if (!VALID_FAULTS.has(defaultFault)) {
    throw new Error(`startMockServer: 非法故障形态 ${defaultFault}（合法值 F0-F5）`)
  }
  const defaultDelay = opts.delay ?? 8
  if (typeof defaultDelay !== 'number' || Number.isNaN(defaultDelay) || defaultDelay < 0) {
    throw new Error(`startMockServer: 非法 delay ${String(opts.delay)}`)
  }

  let currentFault: MockFault = defaultFault
  let onceFault: MockFault | null = null
  // 一次性故障的子串条件：match=请求体须包含才命中；avoid=请求体含则不命中（隔离辅助请求）
  let onceMatch: string | null = null
  let onceAvoid: string | null = null
  let seq = 0
  let reqSeq = 0
  const requests: MockDeliveryProof[] = []
  if (opts.logDir) mkdirSync(opts.logDir, { recursive: true })

  const record = (entry: MockDeliveryProof): void => {
    requests.push(entry)
    if (opts.logDir) {
      appendFileSync(join(opts.logDir, `mock-${entry.ts.slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`)
    }
  }

  interface StreamMeta {
    seq: number
    path: string
    endpoint: MockEndpoint
    fault: MockFault
    model: string
    ua: string
    delay: number
    reqMaxTokens: number | null
    reqBytes: number
    reqExcerpt: string
    reqTail: string
  }

  async function runStream(req: IncomingMessage, res: ServerResponse, actions: StreamAction[], meta: StreamMeta): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-mock-fault': meta.fault,
    })
    const events: string[] = []
    let bytes = 0
    let ending: MockEnding = 'clean'
    let aborted = false
    // 客户端中途断开检测：req 的 close 在请求体读完即触发（早于本监听器挂载），须监听 res——
    // 连接在响应写完前被断开时 res.writableEnded 仍为 false
    res.on('close', () => {
      if (!res.writableEnded) aborted = true
    })
    // 写已销毁连接会异步抛 ERR_STREAM_DESTROYED；吞掉以免击穿测试进程
    res.on('error', () => {})
    const t0 = Date.now()
    for (const a of actions) {
      if (aborted || res.destroyed) {
        ending = 'client-abort'
        break
      }
      if (a.k === 'close') {
        ending = a.mode
        if (a.mode === 'clean') res.end()
        else res.socket?.end() // TCP FIN：HTTP chunked 流不终止，制造"意外 EOF"
        break
      }
      res.write(a.frame)
      bytes += Buffer.byteLength(a.frame)
      events.push(a.tag)
      if (meta.delay > 0) await sleep(meta.delay)
    }
    record({
      seq: meta.seq,
      ts: new Date().toISOString(),
      ip: req.socket.remoteAddress ?? '',
      method: req.method ?? '',
      path: meta.path,
      endpoint: meta.endpoint,
      fault: meta.fault,
      model: meta.model,
      stream: true,
      userAgent: meta.ua,
      bytesSent: bytes,
      eventsCount: events.length,
      events,
      witnesses: witnessesOf(events),
      ending,
      durationMs: Date.now() - t0,
      reqMaxTokens: meta.reqMaxTokens,
      reqBytes: meta.reqBytes,
      reqExcerpt: meta.reqExcerpt,
      reqTail: meta.reqTail,
    })
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const p = url.pathname
    const ua = firstHeader(req.headers['user-agent'])

    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (p === '/health') {
      return json(200, { ok: true, fault: currentFault })
    }

    if (p === '/__control') {
      if (req.method === 'POST') {
        let body: { fault?: unknown; once?: unknown; match?: unknown; avoid?: unknown }
        try {
          body = JSON.parse((await readBody(req)) || '{}') as typeof body
        } catch {
          return json(400, { ok: false, error: 'invalid JSON body' })
        }
        const f = String(body.fault ?? '').toUpperCase()
        if (!VALID_FAULTS.has(f)) {
          return json(400, { ok: false, error: 'fault must be F0-F5' })
        }
        if (body.once === true) {
          onceFault = f as MockFault
          onceMatch = typeof body.match === 'string' && body.match !== '' ? body.match : null
          onceAvoid = typeof body.avoid === 'string' && body.avoid !== '' ? body.avoid : null
        } else {
          currentFault = f as MockFault
          onceFault = null
          onceMatch = null
          onceAvoid = null
        }
        return json(200, { ok: true, fault: currentFault, once: onceFault })
      }
      return json(200, { ok: true, fault: currentFault, port: (server.address() as AddressInfo).port, delay_ms: defaultDelay })
    }

    if (p === '/v1/models' && req.method === 'GET') {
      // Anthropic SDK 带 x-api-key / anthropic-version 头；其余按 OpenAI 形态返回
      const anthropic = 'x-api-key' in req.headers || 'anthropic-version' in req.headers
      const body = anthropic
        ? { data: [{ id: 'mock-model', type: 'model', display_name: 'Mock Model', created_at: new Date().toISOString() }], has_more: false, first_id: 'mock-model', last_id: 'mock-model' }
        : { object: 'list', data: [{ id: 'mock-model', object: 'model', created: 1700000000, owned_by: 'mock' }] }
      return json(200, body)
    }

    if (p === '/v1/messages/count_tokens' && req.method === 'POST') {
      await readBody(req)
      return json(200, { input_tokens: 100 })
    }

    const endpoint = ENDPOINTS[p]
    if (!endpoint || req.method !== 'POST') {
      return json(404, { error: `unknown endpoint: ${req.method ?? ''} ${p}`, endpoints: Object.keys(ENDPOINTS) })
    }

    const rawBody = await readBody(req)
    let body: { model?: unknown; stream?: unknown; max_tokens?: unknown; max_output_tokens?: unknown }
    try {
      body = JSON.parse(rawBody || '{}') as typeof body
    } catch {
      return json(400, { ok: false, error: 'invalid JSON body' })
    }

    // 故障形态优先级：?fault= > x-mock-fault 头 > once（含 match/avoid）> 控制面当前值 > 启动默认
    const explicit = (url.searchParams.get('fault') ?? firstHeader(req.headers['x-mock-fault']) ?? '').toUpperCase()
    let fault: MockFault
    if (VALID_FAULTS.has(explicit)) {
      fault = explicit as MockFault
    } else if (
      onceFault !== null &&
      (onceMatch === null || rawBody.includes(onceMatch)) &&
      (onceAvoid === null || !rawBody.includes(onceAvoid))
    ) {
      fault = onceFault
      onceFault = null
      onceMatch = null
      onceAvoid = null
    } else {
      fault = currentFault
    }

    const model = typeof body.model === 'string' && body.model !== '' ? body.model : 'mock-model'
    const delay = url.searchParams.has('delay') ? Number(url.searchParams.get('delay')) : defaultDelay
    const reqMaxTokensRaw = body.max_tokens ?? body.max_output_tokens
    const flat = rawBody.replace(/\s+/g, ' ')
    const meta: StreamMeta = {
      seq: ++reqSeq,
      path: p,
      endpoint,
      fault,
      model,
      ua,
      delay,
      reqMaxTokens: typeof reqMaxTokensRaw === 'number' ? reqMaxTokensRaw : null,
      reqBytes: Buffer.byteLength(rawBody),
      reqExcerpt: flat.slice(0, 160),
      reqTail: flat.slice(-300),
    }

    if (body.stream === false) {
      const obj = nonStreamResponse(endpoint, model, () => ++seq)
      const str = JSON.stringify(obj)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(str)
      record({
        seq: meta.seq,
        ts: new Date().toISOString(),
        ip: req.socket.remoteAddress ?? '',
        method: req.method ?? '',
        path: p,
        endpoint,
        fault,
        model,
        stream: false,
        userAgent: ua,
        bytesSent: Buffer.byteLength(str),
        eventsCount: 0,
        events: [],
        witnesses: emptyWitnesses(),
        ending: 'clean',
        durationMs: 0,
        reqMaxTokens: meta.reqMaxTokens,
        reqBytes: meta.reqBytes,
        reqExcerpt: meta.reqExcerpt,
        reqTail: meta.reqTail,
      })
      return
    }

    const nextSeq = (): number => ++seq
    const actions =
      endpoint === 'cc'
        ? buildCcActions(model, fault, nextSeq)
        : endpoint === 'responses'
          ? buildResponsesActions(model, fault, nextSeq)
          : buildAnthropicActions(model, fault, nextSeq)
    await runStream(req, res, actions, meta)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: `mock handler failure: ${err instanceof Error ? err.message : String(err)}` }))
      } else {
        res.destroy()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const port = (server.address() as AddressInfo).port

  let closed = false
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      if (closed) return
      closed = true
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
