import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startMockServer } from '../src/mock.ts'
import type { MockDeliveryProof, MockDeliveryWitnesses, MockEndpoint, MockFault, MockServer } from '../src/mock.ts'

// ---------------- 测试基础设施 ----------------

const activeServers: MockServer[] = []

async function start(opts: { fault?: MockFault; delay?: number; port?: number; logDir?: string } = {}): Promise<MockServer> {
  const server = await startMockServer({ delay: 0, ...opts })
  activeServers.push(server)
  return server
}

afterEach(async () => {
  while (activeServers.length > 0) {
    const s = activeServers.pop()
    if (s) await s.close()
  }
})

interface SseReply {
  status: number
  headers: Headers
  /** 成功读到的全部字节（fin 截断时为出错前已收到的部分） */
  text: string
  /** 读流被截断时的错误消息；正常完整读取为 undefined */
  readError: string | undefined
}

async function readBody(res: Response): Promise<{ text: string; error?: string }> {
  if (!res.body) return { text: '' }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out += dec.decode(value, { stream: true })
    }
    return { text: out + dec.decode() }
  } catch (e) {
    // TCP FIN 截断 chunked 流：undici 抛 TypeError: terminated——保留已收到的部分字节
    return { text: out, error: e instanceof Error ? e.message : String(e) }
  }
}

async function postSse(
  server: MockServer,
  path: string,
  init: { body?: Record<string, unknown>; faultQuery?: string; faultHeader?: MockFault; signal?: AbortSignal } = {},
): Promise<SseReply> {
  const url = `${server.baseUrl}${path}${init.faultQuery ? `?fault=${init.faultQuery}` : ''}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'mock-spec/1.0',
      ...(init.faultHeader ? { 'x-mock-fault': init.faultHeader } : {}),
    },
    body: JSON.stringify({ model: 'mock-model', stream: true, ...(init.body ?? {}) }),
    signal: init.signal ?? AbortSignal.timeout(15_000),
  })
  const { text, error } = await readBody(res)
  return { status: res.status, headers: res.headers, text, readError: error }
}

async function control(server: MockServer, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${server.baseUrl}/__control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met in time')
    await new Promise((r) => setTimeout(r, 15))
  }
}

// ---------------- 客户端侧 SSE 解析 ----------------

interface SseFrame {
  event?: string
  data: string
}

function parseSse(text: string): SseFrame[] {
  const frames: SseFrame[] = []
  for (const block of text.split('\n\n')) {
    if (block === '') continue
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length)
      else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length))
    }
    if (dataLines.length > 0 || event !== undefined) frames.push({ event, data: dataLines.join('\n') })
  }
  return frames
}

interface CcChunk {
  choices: { index: number; delta: { role?: string; content?: string | null; reasoning_content?: string }; finish_reason: string | null }[]
}

function ccChunks(reply: SseReply): CcChunk[] {
  return parseSse(reply.text)
    .filter((f) => f.data !== '[DONE]')
    .map((f) => JSON.parse(f.data) as CcChunk)
}

interface RsFrame {
  type: string
  delta?: string
  text?: string
  response?: { status?: string; incomplete_details?: { reason?: string }; output?: { content?: { text?: string }[] }[] }
}

function rsFrames(reply: SseReply): RsFrame[] {
  return parseSse(reply.text).map((f) => JSON.parse(f.data) as RsFrame)
}

interface AnFrame {
  type: string
  delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string | null }
}

function anFrames(reply: SseReply): AnFrame[] {
  return parseSse(reply.text).map((f) => JSON.parse(f.data) as AnFrame)
}

// ---------------- 事件序列快照基线 ----------------
// 基线出处：参照 mock.mjs（横评实测）+ 2026-09-26 真实 DeepSeek API 黄金样本校准
// （Responses 补 response.in_progress / response.content_part.done，见 tests/golden.spec.ts）。
// Responses F4/F5 末事件取方言修正后的 response.incomplete（真实截断样本已证实）。

const tags = (base: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${base}[${i}]`)

const PATHS: Record<MockEndpoint, string> = {
  cc: '/v1/chat/completions',
  responses: '/v1/responses',
  anthropic: '/v1/messages',
}

const CC_EVENTS: Record<MockFault, string[]> = {
  F0: ['cc.role', ...tags('cc.content', 24), 'cc.finish(stop)', 'cc.[DONE]'],
  F1: ['cc.role', ...tags('cc.content', 12)],
  F2: ['cc.role', ...tags('cc.content', 24), 'cc.[DONE]'],
  F3: ['cc.role', ...tags('cc.content', 12), 'cc.partial-event'],
  F4: ['cc.role', ...tags('cc.content', 24), ...tags('cc.content', 24), 'cc.finish(length)', 'cc.[DONE]'],
  F5: ['cc.role', ...tags('cc.reasoning', 6), 'cc.finish(length)', 'cc.[DONE]'],
}

const RS_EVENTS: Record<MockFault, string[]> = {
  F0: ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', ...tags('response.output_text.delta', 24), 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.completed'],
  F1: ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', ...tags('response.output_text.delta', 12)],
  F2: ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', ...tags('response.output_text.delta', 24), 'response.output_text.done', 'response.content_part.done', 'response.output_item.done'],
  F3: ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', ...tags('response.output_text.delta', 12), 'responses.partial-event'],
  F4: ['response.created', 'response.in_progress', 'response.output_item.added', 'response.content_part.added', ...tags('response.output_text.delta', 24), ...tags('Q.response.output_text.delta', 24), 'response.output_text.done', 'response.content_part.done', 'response.output_item.done', 'response.incomplete'],
  F5: ['response.created', 'response.in_progress', 'response.output_item.added', 'response.reasoning_summary_part.added', ...tags('reasoning_summary_text.delta', 6), 'response.reasoning_summary_text.done', 'response.output_item.done', 'response.incomplete'],
}

const AN_EVENTS: Record<MockFault, string[]> = {
  F0: ['message_start', 'content_block_start', 'ping', ...tags('content_block_delta', 24), 'content_block_stop', 'message_delta', 'message_stop'],
  F1: ['message_start', 'content_block_start', ...tags('content_block_delta', 12)],
  F2: ['message_start', 'content_block_start', 'ping', ...tags('content_block_delta', 24), 'content_block_stop', 'message_delta'],
  F3: ['message_start', 'content_block_start', ...tags('content_block_delta', 12), 'anthropic.partial-event'],
  F4: ['message_start', 'content_block_start', 'ping', ...tags('content_block_delta', 24), ...tags('Q.content_block_delta', 24), 'content_block_stop', 'message_delta', 'message_stop'],
  F5: ['message_start', 'content_block_start', ...tags('thinking_delta', 6), 'content_block_stop', 'message_delta', 'message_stop'],
}

const NO_WITNESS: MockDeliveryWitnesses = { ccDone: false, ccFinishChunk: false, responsesCompleted: false, responsesIncomplete: false, anthropicMessageStop: false }

// ---------------- 快照：三协议 × F0/F4/F5 ----------------

describe('snapshots: F0 正常完整流', () => {
  it('cc: role + 24 content + finish(stop) + [DONE]，客户端拿到完整流', async () => {
    const server = await start({ fault: 'F0' })
    const reply = await postSse(server, PATHS.cc)
    const proof = server.requests[0]
    expect(proof.events).toEqual(CC_EVENTS.F0)
    expect(proof.ending).toBe('clean')
    expect(proof.witnesses).toEqual({ ...NO_WITNESS, ccDone: true, ccFinishChunk: true })
    expect(reply.readError).toBeUndefined()
    expect(reply.text.endsWith('data: [DONE]\n\n')).toBe(true)
    const chunks = ccChunks(reply)
    const finishReasons = chunks.map((c) => c.choices[0].finish_reason).filter((r) => r !== null)
    expect(finishReasons).toEqual(['stop'])
    const content = chunks.map((c) => c.choices[0].delta.content ?? '').join('')
    expect(content.startsWith('【P01】')).toBe(true)
    expect(content).toContain('【P24】')
    expect(content.endsWith('\n')).toBe(true)
  })

  it('responses: created..completed，汇总文本与 delta 流严格一致', async () => {
    const server = await start({ fault: 'F0' })
    const reply = await postSse(server, PATHS.responses)
    const proof = server.requests[0]
    expect(proof.events).toEqual(RS_EVENTS.F0)
    expect(proof.ending).toBe('clean')
    expect(proof.witnesses).toEqual({ ...NO_WITNESS, responsesCompleted: true })
    expect(reply.readError).toBeUndefined()
    const frames = rsFrames(reply)
    const types = frames.map((f) => f.type)
    expect(types).toContain('response.completed')
    expect(types).not.toContain('response.incomplete')
    const deltas = frames.filter((f) => f.type === 'response.output_text.delta').map((f) => f.delta ?? '').join('')
    expect(deltas).toContain('【P24】')
    expect(deltas.endsWith('\n')).toBe(true)
    expect(frames.find((f) => f.type === 'response.output_text.done')?.text).toBe(deltas)
  })

  it('anthropic: message_start..message_stop，stop_reason=end_turn', async () => {
    const server = await start({ fault: 'F0' })
    const reply = await postSse(server, PATHS.anthropic)
    const proof = server.requests[0]
    expect(proof.events).toEqual(AN_EVENTS.F0)
    expect(proof.ending).toBe('clean')
    expect(proof.witnesses).toEqual({ ...NO_WITNESS, anthropicMessageStop: true })
    expect(reply.readError).toBeUndefined()
    const frames = anFrames(reply)
    expect(frames.find((f) => f.type === 'message_delta')?.delta?.stop_reason).toBe('end_turn')
    const text = frames.filter((f) => f.type === 'content_block_delta').map((f) => f.delta?.text ?? '').join('')
    expect(text.startsWith('【P01】')).toBe(true)
    expect(text).toContain('【P24】')
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('snapshots: F4 length 截断', () => {
  it('cc: 双倍正文 + finish(length) + [DONE]', async () => {
    const server = await start({ fault: 'F4' })
    const reply = await postSse(server, PATHS.cc)
    const proof = server.requests[0]
    expect(proof.events).toEqual(CC_EVENTS.F4)
    expect(proof.ending).toBe('clean')
    expect(proof.witnesses).toEqual({ ...NO_WITNESS, ccDone: true, ccFinishChunk: true })
    const chunks = ccChunks(reply)
    const finishReasons = chunks.map((c) => c.choices[0].finish_reason).filter((r) => r !== null)
    expect(finishReasons).toEqual(['length'])
    const content = chunks.map((c) => c.choices[0].delta.content ?? '').join('')
    expect(content).toContain('【P24】')
    expect(content).toContain('【Q24】')
    expect(content.endsWith('\n')).toBe(true)
  })

  it('responses: 独立 response.incomplete 事件（方言），不是 completed+status；P+Q 汇总一致', async () => {
    const server = await start({ fault: 'F4' })
    const reply = await postSse(server, PATHS.responses)
    const proof = server.requests[0]
    expect(proof.events).toEqual(RS_EVENTS.F4)
    expect(proof.ending).toBe('clean')
    expect(proof.witnesses).toEqual({ ...NO_WITNESS, responsesIncomplete: true })
    const frames = rsFrames(reply)
    const types = frames.map((f) => f.type)
    expect(types).not.toContain('response.completed')
    const incomplete = frames.find((f) => f.type === 'response.incomplete')
    expect(incomplete?.response?.status).toBe('incomplete')
    expect(incomplete?.response?.incomplete_details?.reason).toBe('max_output_tokens')
    const deltas = frames.filter((f) => f.type === 'response.output_text.delta').map((f) => f.delta ?? '').join('')
    expect(deltas.startsWith('【P01】')).toBe(true)
    expect(deltas).toContain('【Q24】')
    expect(deltas.endsWith('\n')).toBe(true)
    expect(frames.find((f) => f.type === 'response.output_text.done')?.text).toBe(deltas)
    // item 汇总同样取 delta 流严格拼接
    const itemFrame = parseSse(reply.text).find((f) => f.event === 'response.output_item.done')
    expect(itemFrame).toBeDefined()
    const itemJson = JSON.parse(itemFrame?.data ?? '{}') as { item?: { content?: { text?: string }[] } }
    expect(itemJson.item?.content?.[0]?.text).toBe(deltas)
  })

  it('anthropic: 双倍正文 + message_delta stop_reason=max_tokens', async () => {
    const server = await start({ fault: 'F4' })
    const reply = await postSse(server, PATHS.anthropic)
    const proof = server.requests[0]
    expect(proof.events).toEqual(AN_EVENTS.F4)
    expect(proof.ending).toBe('clean')
    expect(proof.witnesses).toEqual({ ...NO_WITNESS, anthropicMessageStop: true })
    const frames = anFrames(reply)
    expect(frames.filter((f) => f.type === 'content_block_delta')).toHaveLength(48)
    expect(frames.find((f) => f.type === 'message_delta')?.delta?.stop_reason).toBe('max_tokens')
    const text = frames.filter((f) => f.type === 'content_block_delta').map((f) => f.delta?.text ?? '').join('')
    expect(text).toContain('【Q24】')
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('snapshots: F5 think-only 截断（阳性对照）', () => {
  it('cc: 只有 reasoning_content，无正文，finish(length)', async () => {
    const server = await start({ fault: 'F5' })
    const reply = await postSse(server, PATHS.cc)
    const proof = server.requests[0]
    expect(proof.events).toEqual(CC_EVENTS.F5)
    expect(proof.ending).toBe('clean')
    expect(proof.witnesses).toEqual({ ...NO_WITNESS, ccDone: true, ccFinishChunk: true })
    const chunks = ccChunks(reply)
    const content = chunks.map((c) => c.choices[0].delta.content ?? '').join('')
    expect(content).toBe('')
    const reasoning = chunks.map((c) => c.choices[0].delta.reasoning_content ?? '').join('')
    expect(reasoning.startsWith('【R01】')).toBe(true)
    expect(reasoning).toContain('【R06】')
    expect(reasoning.endsWith('\n')).toBe(true)
    expect(chunks.map((c) => c.choices[0].finish_reason).filter((r) => r !== null)).toEqual(['length'])
  })

  it('responses: 只有 reasoning_summary 事件，无正文 delta，收在 response.incomplete', async () => {
    const server = await start({ fault: 'F5' })
    const reply = await postSse(server, PATHS.responses)
    const proof = server.requests[0]
    expect(proof.events).toEqual(RS_EVENTS.F5)
    expect(proof.ending).toBe('clean')
    expect(proof.witnesses).toEqual({ ...NO_WITNESS, responsesIncomplete: true })
    const frames = rsFrames(reply)
    const types = frames.map((f) => f.type)
    expect(types).not.toContain('response.output_text.delta')
    expect(types).not.toContain('response.completed')
    const rDeltas = frames.filter((f) => f.type === 'response.reasoning_summary_text.delta').map((f) => f.delta ?? '').join('')
    expect(rDeltas).toContain('【R06】')
    expect(rDeltas.endsWith('\n')).toBe(true)
    expect(frames.find((f) => f.type === 'response.reasoning_summary_text.done')?.text).toBe(rDeltas)
    const incomplete = frames.find((f) => f.type === 'response.incomplete')
    expect(incomplete?.response?.incomplete_details?.reason).toBe('max_output_tokens')
    // 没有任何正文 delta → incomplete 里的 message 汇总为空串（与 delta 流严格一致）
    expect(incomplete?.response?.output?.[0]?.content?.[0]?.text).toBe('')
  })

  it('anthropic: 只有 thinking_delta，无 text_delta，stop_reason=max_tokens', async () => {
    const server = await start({ fault: 'F5' })
    const reply = await postSse(server, PATHS.anthropic)
    const proof = server.requests[0]
    expect(proof.events).toEqual(AN_EVENTS.F5)
    expect(proof.ending).toBe('clean')
    expect(proof.witnesses).toEqual({ ...NO_WITNESS, anthropicMessageStop: true })
    const frames = anFrames(reply)
    expect(frames.every((f) => f.type !== 'content_block_delta' || f.delta?.type === 'thinking_delta')).toBe(true)
    const thinking = frames.filter((f) => f.delta?.type === 'thinking_delta').map((f) => f.delta?.thinking ?? '').join('')
    expect(thinking).toContain('【R06】')
    expect(thinking.endsWith('\n')).toBe(true)
    expect(frames.find((f) => f.type === 'message_delta')?.delta?.stop_reason).toBe('max_tokens')
  })
})

// ---------------- 中途故障 F1/F2/F3：ending 与证人缺席 ----------------

describe('mid-stream faults F1/F2/F3', () => {
  const rows: {
    endpoint: MockEndpoint
    fault: MockFault
    ending: 'fin' | 'clean'
    events: string[]
    witnessAbsent: keyof MockDeliveryWitnesses
    absentInText: string
    presentInText: string
    halfEvent?: boolean
  }[] = [
    { endpoint: 'cc', fault: 'F1', ending: 'fin', events: CC_EVENTS.F1, witnessAbsent: 'ccDone', absentInText: 'data: [DONE]', presentInText: '【P12】' },
    { endpoint: 'cc', fault: 'F2', ending: 'clean', events: CC_EVENTS.F2, witnessAbsent: 'ccFinishChunk', absentInText: '"finish_reason":"stop"', presentInText: '【P24】' },
    { endpoint: 'cc', fault: 'F3', ending: 'fin', events: CC_EVENTS.F3, witnessAbsent: 'ccDone', absentInText: 'data: [DONE]', presentInText: '【P12】', halfEvent: true },
    { endpoint: 'responses', fault: 'F1', ending: 'fin', events: RS_EVENTS.F1, witnessAbsent: 'responsesCompleted', absentInText: 'event: response.completed', presentInText: '【P12】' },
    { endpoint: 'responses', fault: 'F2', ending: 'clean', events: RS_EVENTS.F2, witnessAbsent: 'responsesCompleted', absentInText: 'event: response.completed', presentInText: '【P24】' },
    { endpoint: 'responses', fault: 'F3', ending: 'fin', events: RS_EVENTS.F3, witnessAbsent: 'responsesCompleted', absentInText: 'event: response.completed', presentInText: '【P12】', halfEvent: true },
    { endpoint: 'anthropic', fault: 'F1', ending: 'fin', events: AN_EVENTS.F1, witnessAbsent: 'anthropicMessageStop', absentInText: 'event: message_stop', presentInText: '【P12】' },
    { endpoint: 'anthropic', fault: 'F2', ending: 'clean', events: AN_EVENTS.F2, witnessAbsent: 'anthropicMessageStop', absentInText: 'event: message_stop', presentInText: '【P24】' },
    { endpoint: 'anthropic', fault: 'F3', ending: 'fin', events: AN_EVENTS.F3, witnessAbsent: 'anthropicMessageStop', absentInText: 'event: message_stop', presentInText: '【P12】', halfEvent: true },
  ]

  for (const row of rows) {
    it(`${row.endpoint} ${row.fault}: ending=${row.ending}, 终止证人缺席`, async () => {
      const server = await start({ fault: row.fault })
      const reply = await postSse(server, PATHS[row.endpoint])
      const proof = server.requests[0]
      expect(proof.events).toEqual(row.events)
      expect(proof.ending).toBe(row.ending)
      expect(proof.witnesses[row.witnessAbsent]).toBe(false)
      expect(reply.text).not.toContain(row.absentInText)
      expect(reply.text).toContain(row.presentInText)
      if (row.ending === 'fin') {
        expect(reply.readError).toBeDefined()
      } else {
        expect(reply.readError).toBeUndefined()
      }
      if (row.halfEvent) {
        // 半个 SSE 事件：结尾没有空行分隔符
        expect(reply.text.endsWith('\n\n')).toBe(false)
      }
    })
  }

  it('F2 内容证人完整：cc 全部 24 段正文送达，仅缺携带 finish_reason 的末 chunk', async () => {
    const server = await start({ fault: 'F2' })
    const reply = await postSse(server, PATHS.cc)
    const chunks = ccChunks(reply)
    const content = chunks.map((c) => c.choices[0].delta.content ?? '').join('')
    expect(content).toContain('【P24】')
    expect(content.endsWith('\n')).toBe(true)
    expect(chunks.every((c) => c.choices[0].finish_reason === null)).toBe(true)
    expect(reply.text).toContain('data: [DONE]')
  })
})

// ---------------- once 语义 ----------------

describe('once fault semantics', () => {
  it('命中即失效：只作用于下一个 LLM 请求', async () => {
    const server = await start({ fault: 'F0' })
    await control(server, { fault: 'F2', once: true })
    await postSse(server, PATHS.cc)
    expect(server.requests[0].fault).toBe('F2')
    await postSse(server, PATHS.cc)
    expect(server.requests[1].fault).toBe('F0')
  })

  it('match 子串：请求体不含 match 的辅助请求不消耗 once', async () => {
    const server = await start({ fault: 'F0' })
    await control(server, { fault: 'F1', once: true, match: 'NEEDLE-42' })
    await postSse(server, PATHS.cc, { body: { messages: [{ role: 'user', content: 'aux request' }] } })
    expect(server.requests[0].fault).toBe('F0')
    await postSse(server, PATHS.cc, { body: { messages: [{ role: 'user', content: 'main NEEDLE-42 request' }] } })
    expect(server.requests[1].fault).toBe('F1')
    await postSse(server, PATHS.cc)
    expect(server.requests[2].fault).toBe('F0')
  })

  it('avoid 子串：带 avoid 的辅助请求被隔离，后续请求才命中', async () => {
    const server = await start({ fault: 'F0' })
    await control(server, { fault: 'F3', once: true, avoid: 'title-gen' })
    await postSse(server, PATHS.cc, { body: { messages: [{ role: 'user', content: 'title-gen aux' }] } })
    expect(server.requests[0].fault).toBe('F0')
    await postSse(server, PATHS.cc, { body: { messages: [{ role: 'user', content: 'real task' }] } })
    expect(server.requests[1].fault).toBe('F3')
    await postSse(server, PATHS.cc)
    expect(server.requests[2].fault).toBe('F0')
  })

  it('控制面拒绝非法 fault 值', async () => {
    const server = await start()
    const res = await fetch(`${server.baseUrl}/__control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fault: 'F9' }),
    })
    expect(res.status).toBe(400)
    expect(server.requests).toHaveLength(0)
  })
})

// ---------------- 故障参数优先级 ----------------

describe('fault priority: URL ?fault= > x-mock-fault 头 > 控制面 > 启动默认', () => {
  it('启动默认生效', async () => {
    const server = await start({ fault: 'F4' })
    await postSse(server, PATHS.anthropic)
    expect(server.requests[0].fault).toBe('F4')
  })

  it('控制面持久切换胜过启动默认', async () => {
    const server = await start({ fault: 'F0' })
    await control(server, { fault: 'F1' })
    await postSse(server, PATHS.anthropic)
    expect(server.requests[0].fault).toBe('F1')
  })

  it('请求头 x-mock-fault 胜过控制面', async () => {
    const server = await start({ fault: 'F0' })
    await control(server, { fault: 'F1' })
    await postSse(server, PATHS.anthropic, { faultHeader: 'F2' })
    expect(server.requests[0].fault).toBe('F2')
  })

  it('URL ?fault= 胜过请求头与控制面', async () => {
    const server = await start({ fault: 'F0' })
    await control(server, { fault: 'F1' })
    await postSse(server, PATHS.anthropic, { faultHeader: 'F2', faultQuery: 'F3' })
    expect(server.requests[0].fault).toBe('F3')
  })

  it('显式 URL fault 不消耗待命的 once', async () => {
    const server = await start({ fault: 'F0' })
    await control(server, { fault: 'F1', once: true })
    await postSse(server, PATHS.anthropic, { faultQuery: 'F2' })
    expect(server.requests[0].fault).toBe('F2')
    await postSse(server, PATHS.anthropic)
    expect(server.requests[1].fault).toBe('F1')
  })
})

// ---------------- 送达证明字段完整性 ----------------

describe('delivery proof', () => {
  it('字段完整且与客户端实际收到的字节一致', async () => {
    const server = await start({ fault: 'F0' })
    const reply = await postSse(server, PATHS.cc)
    const proof = server.requests[0]
    expect(proof.seq).toBe(1)
    expect(Number.isNaN(Date.parse(proof.ts))).toBe(false)
    expect(proof.method).toBe('POST')
    expect(proof.path).toBe(PATHS.cc)
    expect(proof.endpoint).toBe('cc')
    expect(proof.fault).toBe('F0')
    expect(proof.model).toBe('mock-model')
    expect(proof.stream).toBe(true)
    expect(proof.userAgent).toBe('mock-spec/1.0')
    // mock 写出的字节数 === 客户端收到的字节数（送达证明的核心不变量）
    expect(proof.bytesSent).toBe(Buffer.byteLength(reply.text))
    expect(proof.eventsCount).toBe(proof.events.length)
    expect(proof.witnesses).toEqual({ ...NO_WITNESS, ccDone: true, ccFinishChunk: true })
    expect(proof.ending).toBe('clean')
    expect(proof.durationMs).toBeGreaterThanOrEqual(0)
    expect(proof.reqMaxTokens).toBe(null)
    expect(proof.reqBytes).toBeGreaterThan(0)
    expect(proof.reqExcerpt).toContain('mock-model')
    expect(proof.reqTail.length).toBeGreaterThan(0)
    expect(reply.headers.get('content-type')).toContain('text/event-stream')
    expect(reply.headers.get('x-mock-fault')).toBe('F0')
  })

  it('reqMaxTokens 捕获 max_tokens / max_output_tokens', async () => {
    const server = await start()
    await postSse(server, PATHS.cc, { body: { max_tokens: 128 } })
    expect(server.requests[0].reqMaxTokens).toBe(128)
    await postSse(server, PATHS.responses, { body: { max_output_tokens: 256 } })
    expect(server.requests[1].reqMaxTokens).toBe(256)
  })

  it('非流式请求返回完整 JSON 且记录 stream=false', async () => {
    const server = await start({ fault: 'F4' })
    const res = await fetch(`${server.baseUrl}${PATHS.anthropic}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-model', stream: false }),
    })
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as { content: { text: string }[]; stop_reason: string }
    expect(body.content[0].text).toContain('【P24】')
    expect(body.stop_reason).toBe('end_turn')
    const proof = server.requests[0]
    expect(proof.stream).toBe(false)
    expect(proof.events).toEqual([])
    expect(proof.witnesses).toEqual(NO_WITNESS)
    expect(proof.bytesSent).toBeGreaterThan(0)
  })

  it('logDir 给定时逐请求追加 jsonl', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mock-spec-'))
    try {
      const server = await start({ fault: 'F0', logDir: dir })
      await postSse(server, PATHS.cc)
      await postSse(server, PATHS.responses)
      const file = join(dir, `mock-${new Date().toISOString().slice(0, 10)}.jsonl`)
      const lines = readFileSync(file, 'utf8').trim().split('\n')
      expect(lines).toHaveLength(2)
      const entries = lines.map((l) => JSON.parse(l) as MockDeliveryProof)
      expect(entries[0].events).toEqual(server.requests[0].events)
      expect(entries[1].endpoint).toBe('responses')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------- 客户端中断 ----------------

describe('client abort', () => {
  it('消费者中途断开时 ending=client-abort，未送达的证人如实记缺席', async () => {
    const server = await start({ fault: 'F0', delay: 10 })
    const controller = new AbortController()
    const promise = postSse(server, PATHS.cc, { signal: controller.signal })
    await new Promise((r) => setTimeout(r, 50))
    controller.abort()
    await promise
    await waitFor(() => server.requests.length === 1)
    const proof = server.requests[0]
    expect(proof.ending).toBe('client-abort')
    expect(proof.witnesses.ccDone).toBe(false)
    expect(proof.events.length).toBeGreaterThan(0)
    expect(proof.events.length).toBeLessThan(CC_EVENTS.F0.length)
  })
})

// ---------------- 辅助端点与生命周期 ----------------

describe('auxiliary endpoints', () => {
  it('/health 报告当前故障形态', async () => {
    const server = await start({ fault: 'F2' })
    const res = await fetch(`${server.baseUrl}/health`)
    expect(await res.json()).toEqual({ ok: true, fault: 'F2' })
  })

  it('GET /__control 反映状态', async () => {
    const server = await start({ fault: 'F0' })
    await control(server, { fault: 'F4' })
    const body = (await (await fetch(`${server.baseUrl}/__control`)).json()) as { ok: boolean; fault: MockFault; port: number; delay_ms: number }
    expect(body).toMatchObject({ ok: true, fault: 'F4', port: server.port })
    expect(body.delay_ms).toBe(0)
  })

  it('/v1/models 按 SDK 头区分 OpenAI / Anthropic 形态', async () => {
    const server = await start()
    const openai = (await (await fetch(`${server.baseUrl}/v1/models`)).json()) as { object: string }
    expect(openai.object).toBe('list')
    const anthropic = (await (await fetch(`${server.baseUrl}/v1/models`, { headers: { 'x-api-key': 'sk-test' } })).json()) as { data: { type: string }[] }
    expect(anthropic.data[0].type).toBe('model')
  })

  it('/v1/messages/count_tokens 返回计数', async () => {
    const server = await start()
    const res = await fetch(`${server.baseUrl}/v1/messages/count_tokens`, { method: 'POST', body: '{}' })
    expect(await res.json()).toEqual({ input_tokens: 100 })
  })

  it('未知端点 / 错误方法返回 404 JSON 且不计入送达证明', async () => {
    const server = await start()
    const res = await fetch(`${server.baseUrl}/v1/embeddings`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('/v1/embeddings')
    const get = await fetch(`${server.baseUrl}${PATHS.cc}`)
    expect(get.status).toBe(404)
    expect(server.requests).toHaveLength(0)
  })
})

describe('lifecycle', () => {
  it('默认绑定 127.0.0.1 ephemeral 端口', async () => {
    const server = await start()
    expect(server.port).toBeGreaterThan(0)
    expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`)
    expect((await fetch(`${server.baseUrl}/health`)).status).toBe(200)
  })

  it('启动时拒绝非法 fault', async () => {
    await expect(startMockServer({ fault: 'F9' as MockFault })).rejects.toThrow('F0-F5')
  })

  it('close() 关停监听且可重复调用', async () => {
    const server = await start()
    const { baseUrl } = server
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200)
    await server.close()
    await server.close()
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow()
  })
})
