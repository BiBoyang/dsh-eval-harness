import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { startMockServer } from '../src/mock.ts'
import type { MockFault, MockServer } from '../src/mock.ts'

/**
 * mock 方言保真：与真实 DeepSeek API 黄金样本（scripts/capture-golden.mjs 抓取，
 * tests/fixtures/golden/）做事件骨架比对，离线可跑、进 CI。
 *
 * 比对口径（DoD：事件名序列 + 终态事件关键字段路径）：
 * - F0：mock 与黄金样本的**折叠事件名序列**一致（连续同名事件折叠为 `name×N`，
 *   内容长度天然不同，帧的"形状"必须同构）；
 * - F4/F5：mock 的 length 截断终态与黄金样本的**真实截断终态**在事件名与关键字段
 *   路径/值上一致（cc finish_reason=length、responses 独立 response.incomplete 事件
 *   且 incomplete_details.reason=max_output_tokens、anthropic stop_reason=max_tokens）——
 *   真实截断由极小 max_tokens 诱发，正文长度与 mock 不同属预期，不比序列只比终态。
 *
 * 黄金样本若缺失或形状变化（上游漂移），本 spec 直接红——不许静默跳过。
 */

const GOLDEN_DIR = fileURLToPath(new URL('./fixtures/golden', import.meta.url))

async function golden(name: string): Promise<string> {
  return readFile(`${GOLDEN_DIR}/${name}.sse.txt`, 'utf8')
}

interface GoldenManifestEntry {
  file: string
  capturedAt: string
  endpoint: string
  request: Record<string, unknown>
}

async function manifest(): Promise<GoldenManifestEntry[]> {
  return JSON.parse(await readFile(`${GOLDEN_DIR}/manifest.json`, 'utf8')) as GoldenManifestEntry[]
}

// ---------------- SSE 解析与骨架提取 ----------------

interface Frame {
  event?: string
  data: string
}

function parseFrames(text: string): Frame[] {
  const frames: Frame[] = []
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

/**
 * 连续同名事件归一为 `name*`：内容长度（delta/chunk 切分粒度）不是方言属性，
 * 帧的形状（事件名顺序与分档）必须同构。
 */
function collapse(names: string[]): string[] {
  const out: string[] = []
  for (const n of names) {
    const last = out[out.length - 1]
    if (last !== undefined && (last === n || (last.endsWith('*') && last.slice(0, -1) === n))) continue
    out.push(`${n}*`)
  }
  return out
}

/** cc 帧无名可依，从载荷派生伪事件名 */
function ccNames(text: string): string[] {
  return parseFrames(text).map((f) => {
    if (f.data === '[DONE]') return '[DONE]'
    const c = JSON.parse(f.data) as { choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[] }
    const ch = c.choices?.[0]
    if (ch === undefined) return 'no-choices'
    if (ch.finish_reason !== null && ch.finish_reason !== undefined) return `finish:${String(ch.finish_reason)}`
    const d = ch.delta ?? {}
    if ('role' in d) return 'role'
    if ('reasoning_content' in d) return 'reasoning'
    return 'content'
  })
}

function eventNames(text: string): string[] {
  return parseFrames(text).map((f) => f.event ?? '<no-event>')
}

function findEvent(text: string, name: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined
  for (const f of parseFrames(text)) {
    if (f.event === name) found = JSON.parse(f.data) as Record<string, unknown>
  }
  return found
}

/** 按点路径取嵌套值（关键字段路径锚定用） */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

// ---------------- mock 侧取样 ----------------

const PROTO_PATHS: Record<'cc' | 'responses' | 'anthropic', string> = {
  cc: '/v1/chat/completions',
  responses: '/v1/responses',
  anthropic: '/v1/messages',
}

async function mockStream(fault: MockFault, proto: keyof typeof PROTO_PATHS): Promise<string> {
  const server: MockServer = await startMockServer({ fault, port: 0, delay: 0 })
  try {
    const res = await fetch(`${server.baseUrl}${PROTO_PATHS[proto]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'golden-spec' },
      body: JSON.stringify({ model: 'mock-model', stream: true }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`mock ${proto} HTTP ${res.status}`)
    return await res.text()
  } finally {
    await server.close()
  }
}

// ---------------- 黄金样本自身完整性 ----------------

describe('golden fixtures integrity', () => {
  it('manifest covers all six captures with source annotations', async () => {
    const m = await manifest()
    expect(m.map((e) => e.file).sort()).toEqual([
      'anthropic-f0.sse.txt',
      'anthropic-truncated.sse.txt',
      'cc-f0.sse.txt',
      'cc-truncated.sse.txt',
      'responses-f0.sse.txt',
      'responses-truncated.sse.txt',
    ])
    for (const e of m) {
      expect(e.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(e.endpoint).toMatch(/^https:\/\/api\.deepseek\.com\//)
      expect(e.request.stream).toBe(true)
    }
  })

  it('fixtures contain no credentials', async () => {
    const m = await manifest()
    for (const e of m) {
      const text = await readFile(`${GOLDEN_DIR}/${e.file}`, 'utf8')
      expect(text).not.toMatch(/sk-[A-Za-z0-9]{20,}/)
      expect(text).not.toMatch(/Bearer /)
    }
    expect(JSON.stringify(m)).not.toMatch(/sk-[A-Za-z0-9]{20,}/)
  })
})

// ---------------- F0：折叠事件名序列同构 ----------------

describe('mock F0 skeleton vs golden F0 (collapsed event-name sequence)', () => {
  it('chat completions: role → content×N → finish:stop → [DONE]', async () => {
    const [mock, real] = await Promise.all([mockStream('F0', 'cc'), golden('cc-f0')])
    expect(collapse(ccNames(mock))).toEqual(collapse(ccNames(real)))
  })

  it('responses: created → in_progress → item/part added → delta×N → text/part/item done → completed', async () => {
    const [mock, real] = await Promise.all([mockStream('F0', 'responses'), golden('responses-f0')])
    expect(collapse(eventNames(mock))).toEqual(collapse(eventNames(real)))
  })

  it('anthropic: message_start → content_block_start → ping → delta×N → block_stop → message_delta → message_stop', async () => {
    const [mock, real] = await Promise.all([mockStream('F0', 'anthropic'), golden('anthropic-f0')])
    expect(collapse(eventNames(mock))).toEqual(collapse(eventNames(real)))
  })
})

// ---------------- 截断终态：事件名 + 关键字段路径/值锚定 ----------------

describe('mock F4/F5 terminal shape vs golden real truncation', () => {
  it('cc: finish chunk carries finish_reason="length", stream closes with [DONE]', async () => {
    const [mockF4, mockF5, real] = await Promise.all([mockStream('F4', 'cc'), mockStream('F5', 'cc'), golden('cc-truncated')])
    for (const [label, text] of [['F4', mockF4], ['F5', mockF5], ['golden', real]] as const) {
      const finish = ccNames(text).find((n) => n.startsWith('finish:'))
      expect(finish, `${label} finish chunk`).toBe('finish:length')
      expect(text.trimEnd().endsWith('data: [DONE]'), `${label} [DONE] sentinel`).toBe(true)
    }
    // 真实截断样本的 finish chunk 关键字段路径
    const finishFrame = parseFrames(real)
      .filter((f) => f.data !== '[DONE]')
      .map((f) => JSON.parse(f.data) as { choices?: { finish_reason?: string | null }[] })
      .find((c) => c.choices?.[0]?.finish_reason !== null && c.choices?.[0]?.finish_reason !== undefined)
    expect(getPath(finishFrame, 'choices.0.finish_reason')).toBe('length')
  })

  it('responses: 独立 response.incomplete 事件（不是 completed+status）携带 incomplete_details.reason', async () => {
    const [mockF4, mockF5, real] = await Promise.all([mockStream('F4', 'responses'), mockStream('F5', 'responses'), golden('responses-truncated')])
    // 真实样本：截断终态是独立事件 response.incomplete；response.completed 不得出现
    expect(eventNames(real)).toContain('response.incomplete')
    expect(eventNames(real)).not.toContain('response.completed')
    expect(getPath(findEvent(real, 'response.incomplete'), 'response.incomplete_details.reason')).toBe('max_output_tokens')
    expect(getPath(findEvent(real, 'response.incomplete'), 'response.status')).toBe('incomplete')
    // mock F4/F5 终态与真实样本同形
    for (const [label, text] of [['F4', mockF4], ['F5', mockF5]] as const) {
      expect(eventNames(text)).toContain('response.incomplete')
      expect(eventNames(text)).not.toContain('response.completed')
      expect(getPath(findEvent(text, 'response.incomplete'), 'response.incomplete_details.reason'), `${label} reason`).toBe('max_output_tokens')
      expect(getPath(findEvent(text, 'response.incomplete'), 'response.status'), `${label} status`).toBe('incomplete')
    }
  })

  it('anthropic: message_delta carries stop_reason="max_tokens"，随后 message_stop', async () => {
    const [mockF4, mockF5, real] = await Promise.all([mockStream('F4', 'anthropic'), mockStream('F5', 'anthropic'), golden('anthropic-truncated')])
    for (const [label, text] of [['F4', mockF4], ['F5', mockF5], ['golden', real]] as const) {
      const delta = findEvent(text, 'message_delta')
      expect(getPath(delta, 'delta.stop_reason'), `${label} stop_reason`).toBe('max_tokens')
      expect(eventNames(text)).toContain('message_stop')
    }
  })
})
