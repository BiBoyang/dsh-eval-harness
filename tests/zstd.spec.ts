import { describe, expect, it } from 'vitest'
import { constants, zstdCompressSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectFromFile } from '../src/collector.ts'
import { decodeZstdLog, scanZstdFrames } from '../src/zstd.ts'

/** 与 dsh-session-persistence-jsonl 一致的帧编码：单帧、checksum 开启。 */
const compressFrame = (s: string): Buffer =>
  zstdCompressSync(Buffer.from(s), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

describe('scanZstdFrames', () => {
  it('locates concatenated frame boundaries without decompressing', () => {
    const buf = Buffer.concat([compressFrame('a\n'), compressFrame('bb\n')])
    const { frames, tornStart } = scanZstdFrames(buf)
    expect(tornStart).toBeUndefined()
    expect(frames).toHaveLength(2)
    // 每帧都以 28 b5 2f fd 魔数开头
    expect(buf.subarray(frames[0]!.start, frames[0]!.start + 4).toString('hex')).toBe('28b52ffd')
    expect(buf.subarray(frames[1]!.start, frames[1]!.start + 4).toString('hex')).toBe('28b52ffd')
    // 第二帧紧接第一帧结束
    expect(frames[1]!.start).toBe(frames[0]!.end)
  })

  it('reports tornStart when EOF interrupts a frame', () => {
    const frame = compressFrame('hello\n')
    const torn = frame.subarray(0, frame.length - 2)
    expect(scanZstdFrames(torn)).toEqual({ frames: [], tornStart: 0 })
  })

  it('rejects non-zstd magic with the offending byte offset', () => {
    expect(() => scanZstdFrames(Buffer.from('not a zstd stream'))).toThrow(/invalid frame magic at byte 0/)
  })
})

describe('decodeZstdLog', () => {
  it('decodes a multi-frame zstd stream back to JSONL text', () => {
    const buf = Buffer.concat([
      compressFrame('{"type":"session","id":"s1"}\n'),
      compressFrame('{"type":"tool/call","name":"bash"}\n'),
      compressFrame('{"type":"turn/end"}\n'),
    ])
    expect(decodeZstdLog(buf)).toBe(
      '{"type":"session","id":"s1"}\n{"type":"tool/call","name":"bash"}\n{"type":"turn/end"}\n',
    )
  })

  it('recovers available plaintext from a torn final frame (finishFlush)', () => {
    const complete = compressFrame('{"type":"tool/call","name":"bash"}\n')
    const tornFrame = compressFrame('{"type":"turn/end","reason":{"kind":"completed"}}\n')
    // 尾帧截掉 checksum（4 字节）：完整帧须全量恢复，残缺帧用 finishFlush 尽力恢复
    const buf = Buffer.concat([complete, tornFrame.subarray(0, tornFrame.length - 4)])
    const text = decodeZstdLog(buf)
    expect(text).toContain('"type":"tool/call"')
    expect(text).toContain('"type":"turn/end"')
  })

  it('rejects empty/corrupt input with a clear error', () => {
    expect(() => decodeZstdLog(Buffer.alloc(0))).toThrow(/no complete frames/)
    expect(() => decodeZstdLog(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))).toThrow(/no complete frames/)
  })
})

describe('real on-disk contract fixture (P2)', () => {
  // tests/fixtures/real-session.jsonl(.zstd) 来自真实 dsh 落盘帧（脱敏），
  // 锁定 tool/result、assistant/message 等帧的真实形状，防止形状假设回归。
  const readZstd = () => collectFromFile(join(fixtureDir, 'real-session.jsonl.zstd'))

  it('zstd fixture decodes to the same trace as the plain JSONL fixture', async () => {
    const [fromZstd, fromPlain] = await Promise.all([
      collectFromFile(join(fixtureDir, 'real-session.jsonl.zstd')),
      collectFromFile(join(fixtureDir, 'real-session.jsonl')),
    ])
    expect(fromZstd).toEqual(fromPlain)
  })

  it('locks the collected trace contract as a snapshot', async () => {
    expect(await readZstd()).toMatchSnapshot()
  })

  it('extracts tool/call names in order from real frames', async () => {
    const t = await readZstd()
    expect(t.toolsCalled).toEqual(['bash', 'edit', 'eval_run'])
    expect(t.toolCalls.map((c) => c.name)).toEqual(['bash', 'edit', 'eval_run'])
    expect(t.toolCalls.map((c) => c.callId)).toEqual(['call-2', 'call-6', 'call-8'])
  })

  it('extracts tool/result text from the real message.content[] tool-result block shape', async () => {
    const t = await readZstd()
    expect(t.toolResults).toEqual([
      { name: 'bash', callId: 'call-2', text: '<text>' },
      { name: 'edit', callId: 'call-6', text: '<text>' },
      { name: 'eval_run', callId: 'call-8', text: '<text>' },
    ])
  })

  it('extracts both error shapes: data.error identity and pure isError block', async () => {
    const t = await readZstd()
    expect(t.toolErrors).toEqual([
      { name: 'edit', error: 'FsError: <code>' }, // data.error { name, code } 优先
      { name: 'eval_run', error: '<text>' }, // 无 data.error，回退 message.content[].isError 文本
    ])
  })

  it('aggregates usage and final text from real assistant/message frames', async () => {
    const t = await readZstd()
    expect(t.finalText).toBe('<text>')
    expect(t.tokens).toEqual({
      input: 742 + 328,
      output: 462 + 1673,
      cacheRead: 8064 + 62464,
      cacheWrite: 0,
      reasoning: 305 + 1172,
      total: (742 + 328) + (462 + 1673) + (305 + 1172),
    })
  })

  it('ignores packed chunk rows and counts all real frames as events', async () => {
    const t = await readZstd()
    expect(t.steps).toBe(1)
    expect(t.turnEnd).toBe('completed')
    expect(t.events).toBe(15)
    expect(t.skippedLines).toBe(0)
  })
})

describe('fixture integrity', () => {
  it('zstd fixture is multi-frame (header frame + event batches)', async () => {
    const bytes = await readFile(join(fixtureDir, 'real-session.jsonl.zstd'))
    const { frames } = scanZstdFrames(bytes)
    expect(frames.length).toBeGreaterThanOrEqual(3)
    // 首帧恰好是 header 行（session），后续帧为事件批
    expect(decodeZstdLog(bytes.subarray(frames[0]!.start, frames[0]!.end)).trim()).toMatch(/^\{.*"type":"session"/)
  })

  it('readSessionHeader reads only the header line from both encodings', async () => {
    const { readSessionHeader } = await import('../src/collector.ts')
    const expected = expect.objectContaining({ type: 'session', delegationDepth: 0 })
    expect(await readSessionHeader(join(fixtureDir, 'real-session.jsonl.zstd'))).toEqual(expected)
    expect(await readSessionHeader(join(fixtureDir, 'real-session.jsonl'))).toEqual(expected)
    expect(await readSessionHeader(join(fixtureDir, 'does-not-exist.jsonl'))).toBeNull()
  })
})
