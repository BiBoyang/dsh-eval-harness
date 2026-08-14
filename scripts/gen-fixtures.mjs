// 一次性脚本：从真实 dsh 落盘的 session.jsonl.zstd 里抽取代表性帧，
// 按 key 脱敏（结构/枚举保留，内容字符串替换为 <key> 占位；id/callId 等
// 保持相等关系映射为 call-N），生成 tests/fixtures/real-session.jsonl 与
// 其多帧 zstd 版本（帧布局与 dsh-session-persistence-jsonl 一致：首帧
// 恰为 header 行，后续每帧一个事件批，checksum 开启）。
//
// 用法：node scripts/gen-fixtures.mjs <真实 session.jsonl.zstd 路径>
// 产物：tests/fixtures/real-session.jsonl / real-session.jsonl.zstd

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ZSTD_MAGIC = 0xFD2FB528

function scanZstdFrames(buffer) {
  const frames = []
  let off = 0
  while (off < buffer.length) {
    const start = off
    if (buffer.length - off < 4) break
    if (buffer.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error(`bad zstd magic at byte ${off}`)
    off += 4
    const descriptor = buffer.readUInt8(off)
    off += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - off < remainingHeaderBytes) break
    off += remainingHeaderBytes
    for (;;) {
      if (buffer.length - off < 3) break
      const blockHeader = buffer.readUIntLE(off, 3)
      off += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - off < payloadBytes) break
      off += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - off < 4) break
      off += 4
    }
    frames.push({ start, end: off })
  }
  return frames
}

function decodeAll(buffer) {
  const lines = []
  for (const { start, end } of scanZstdFrames(buffer)) {
    const txt = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')
    for (const ln of txt.split('\n')) if (ln.trim()) lines.push(JSON.parse(ln))
  }
  return lines
}

const PRESERVE = new Set(['type', 'kind', 'role', 'name', 'model', 'provider', 'version', 'origin', 'op', 'surfaceOp'])
const ID_KEYS = new Set(['id', 'callId', 'toolCallId'])
const MAX_ARRAY = 4
const ids = new Map()
let idCounter = 0

function redact(value, key) {
  if (Array.isArray(value)) {
    const trimmed = value.slice(0, MAX_ARRAY)
    return trimmed.map((v) => redact(v, key))
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k)
    return out
  }
  if (typeof value === 'string') {
    if (PRESERVE.has(key)) return value
    if (ID_KEYS.has(key)) {
      if (!ids.has(value)) ids.set(value, `call-${idCounter++}`)
      return ids.get(value)
    }
    return `<${key}>`
  }
  return value
}

const byCallId = (l) => l.data?.message?.source?.callId ?? l.data?.callId

const srcs = process.argv.slice(2)
if (srcs.length === 0) throw new Error('missing source .zstd path(s)')

// 主源（结构/成功/带 error 身份的错误） + 次源（纯 isError、无 data.error 的 eval_run 错误）
const primary = decodeAll(readFileSync(srcs[0]))
const secondary = srcs.length > 1 ? decodeAll(readFileSync(srcs[1])) : []
const last = (type, pred) => [...primary].reverse().find((l) => l.type === type && (pred ? pred(l) : true))
const findResult = (lines, pred) => lines.find((l) => l.type === 'tool/result' && (pred ? pred(l) : true))
const findCall = (lines, callId) => lines.find((l) => l.type === 'tool/call' && l.data?.callId === callId)

const successCall = primary.find((l) => l.type === 'tool/call')
const successResult = primary.find((l) => l.type === 'tool/result' && byCallId(l) === successCall?.data?.callId)
const errWithIdentity = findResult(
  primary,
  (l) => l.data?.error && (l.data?.message?.content ?? []).some((b) => b.isError === true),
)
const errPureIsError = findResult(
  secondary,
  (l) => !l.data?.error && (l.data?.message?.content ?? []).some((b) => b.isError === true),
)

const pick = [
  primary.find((l) => l.type === 'session'),
  primary.find((l) => l.type === 'turn/start'),
  primary.find((l) => l.type === 'user/message'),
  primary.find((l) => l.type === 'assistant/message' && (l.data?.message?.content ?? []).some((b) => b.type === 'tool-call')),
  successCall,
  successResult,
  primary.find((l) => l.type === 'step/end'),
  primary.find((l) => l.type === 'text-chunks'),
  primary.find((l) => l.type === 'tool-call-chunks'),
  errWithIdentity && findCall(primary, errWithIdentity.data?.message?.source?.callId),
  errWithIdentity,
  errPureIsError && findCall(secondary, errPureIsError.data?.message?.source?.callId),
  errPureIsError,
  last('assistant/message', (l) => (l.data?.message?.content ?? []).some((b) => b.type === 'text')),
  last('turn/end'),
].filter(Boolean)

const records = pick.map((l) => redact(l))
const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n'

// 帧布局：首帧 header 行，事件按批分组（与 dsh-session-persistence-jsonl 一致）
const [header, ...rest] = records
const batchSize = Math.ceil(rest.length / 2)
const batches = []
for (let i = 0; i < rest.length; i += batchSize) batches.push(rest.slice(i, i + batchSize))
const compress = (s) => zstdCompressSync(Buffer.from(s), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
const zstd = Buffer.concat([
  compress(JSON.stringify(header) + '\n'),
  ...batches.map((b) => compress(b.map((r) => JSON.stringify(r)).join('\n') + '\n')),
])

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures')
mkdirSync(outDir, { recursive: true })
writeFileSync(resolve(outDir, 'real-session.jsonl'), jsonl)
writeFileSync(resolve(outDir, 'real-session.jsonl.zstd'), zstd)

console.log(`wrote ${records.length} records (${zstd.length} zstd bytes, ${scanZstdFrames(zstd).length} frames)`)
console.log('frame types:', records.map((r) => r.type).join(', '))
