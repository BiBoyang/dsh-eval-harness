import { readFile } from 'node:fs/promises'
import { decodeZstdFirstFrame, decodeZstdLog } from './zstd.js'
import { emptyTokenUsage } from './types.js'
import type { CollectedTrace, ToolCallRecord, ToolError, ToolResultRecord } from './types.js'

/**
 * 从 assistant/message 的 data.message 提取纯文本。
 * 兼容三种形态：string / ContentBlock[] / { content: string | ContentBlock[] }。
 * 返回 undefined 表示该帧无可用文本（不覆盖已记录的 finalText）。
 */
export function extractText(message: unknown): string | undefined {
  if (typeof message === 'string') return message
  if (Array.isArray(message)) return joinTextBlocks(message)
  if (message && typeof message === 'object') {
    const content = (message as { content?: unknown }).content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return joinTextBlocks(content)
  }
  return undefined
}

function joinTextBlocks(blocks: unknown[]): string {
  return blocks
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
    )
    .map((b) => b.text)
    .join('')
}

/**
 * 解析纯 JSONL session trace（每行一帧信封 `{ type, seq, time, data }`）→ 观测结果。
 *
 * 只提取五类帧：
 * - `turn/end`：data.reason.kind（取最后一帧）
 * - `tool/call`：data.name（按出现顺序），并记录 callId → name 映射
 * - `tool/result`：data.error / data.isError 硬错误（经 callId 关联工具名）
 * - `assistant/message`：data.message 文本（取最后一帧）+ 累加 data.usage
 *   各字段（inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens/reasoningTokens，互斥计数）
 * - `step/end`：计数
 *
 * 不良行（非 JSON / 无 type）跳过并计数，不抛错——collector 对脏 trace 保持健壮。
 *
 * 多帧 zstd（session.jsonl.zstd）的解码在 {@link collectFromFile} 里按魔数
 * 自动识别（见 `./zstd.ts` 的 decodeZstdLog），本函数只吃纯 JSONL 文本。
 */
export function collectFromJsonl(text: string): CollectedTrace {
  const toolsCalled: string[] = []
  const toolCalls: ToolCallRecord[] = []
  const toolResults: ToolResultRecord[] = []
  const tokens = emptyTokenUsage()
  const toolErrors: ToolError[] = []
  const callNames = new Map<string, string>() // tool/call 的 callId → name，供 tool/result 关联
  let turnEnd: string | undefined
  let finalText = ''
  let steps = 0
  let events = 0
  let skippedLines = 0

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let frame: { type?: unknown; data?: Record<string, unknown> }
    try {
      frame = JSON.parse(line)
    } catch {
      skippedLines++
      continue
    }
    if (!frame || typeof frame.type !== 'string') {
      skippedLines++
      continue
    }
    events++
    const data = frame.data ?? {}
    switch (frame.type) {
      case 'turn/end': {
        const kind = (data.reason as { kind?: unknown } | undefined)?.kind
        if (typeof kind === 'string') turnEnd = kind
        break
      }
      case 'tool/call': {
        if (typeof data.name !== 'string') break
        toolsCalled.push(data.name)
        const callId = typeof data.callId === 'string' && data.callId !== '' ? data.callId : undefined
        if (callId) callNames.set(callId, data.name)
        // arguments 统一序列化为 JSON 字符串（真实落盘是 string；对象形态兜底 JSON.stringify）
        const rawArgs = data.arguments
        const argsJson = typeof rawArgs === 'string' ? rawArgs : rawArgs === undefined || rawArgs === null ? '' : safeJson(rawArgs)
        toolCalls.push({ name: data.name, callId, argsJson })
        break
      }
      case 'tool/result': {
        const callId = extractToolCallId(data)
        const name = (typeof data.name === 'string' && data.name) || (callId && callNames.get(callId)) || callId || '<unknown>'
        // 结果文本：真实落盘形状 data.message.content[] 的 tool-result 块（content[] 内 text），
        // 兼容顶层 data.content 旧形状。
        toolResults.push({ name, callId, text: extractToolResultText(data) })
        // 硬错误三态：顶层 data.error（合成）/ 顶层 data.isError（旧形状）/
        // data.message.content[] 里的 tool-result 块 isError=true（真实落盘形状）。
        const error = extractToolError(data)
        if (error !== null) {
          toolErrors.push({ name, error })
        }
        break
      }
      case 'assistant/message': {
        const text = extractText(data.message)
        if (text !== undefined) finalText = text
        const usage = data.usage as
          | { inputTokens?: unknown; outputTokens?: unknown; cacheReadTokens?: unknown; cacheWriteTokens?: unknown; reasoningTokens?: unknown }
          | undefined
        if (usage) {
          if (typeof usage.inputTokens === 'number') tokens.input += usage.inputTokens
          if (typeof usage.outputTokens === 'number') tokens.output += usage.outputTokens
          if (typeof usage.cacheReadTokens === 'number') tokens.cacheRead += usage.cacheReadTokens
          if (typeof usage.cacheWriteTokens === 'number') tokens.cacheWrite += usage.cacheWriteTokens
          if (typeof usage.reasoningTokens === 'number') tokens.reasoning += usage.reasoningTokens
        }
        break
      }
      case 'step/end': {
        steps++
        break
      }
    }
  }

  // total 口径 = input + output + reasoning：cacheRead 是多步会话里重复读回的缓存命中
  // （同一段系统提示/历史每步重读），全额累加会让 max_tokens 随步数膨胀；
  // cacheRead/cacheWrite 仍单独保留在报告字段里供观察。
  tokens.total = tokens.input + tokens.output + tokens.reasoning
  return { turnEnd, toolsCalled, toolCalls, toolResults, finalText, steps, tokens, toolErrors, events, skippedLines }
}

const TOOL_ERROR_MAX = 200

/** 从 tool/result data 提取错误摘要；无错误返回 null */
export function extractToolError(data: Record<string, unknown>): string | null {
  // 1) 合成错误形状：顶层 data.error = { name, code, message } 或字符串
  if (data.error !== undefined && data.error !== null) {
    return truncate(formatErrorValue(data.error))
  }
  // 2) 旧/简单形状：顶层 data.isError + data.content
  if (data.isError === true) {
    const text = extractText({ content: data.content })
    return truncate(text && text !== '' ? text : 'tool returned error (isError)')
  }
  // 3) 真实落盘形状：data.message.content[] 里的 tool-result 块（isError=true）
  const message = data.message as { content?: unknown } | undefined
  if (message && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: unknown; isError?: unknown; content?: unknown }
      if (b.type !== 'tool-result' || b.isError !== true) continue
      const text = extractText({ content: b.content })
      return truncate(text && text !== '' ? text : 'tool returned error (isError)')
    }
  }
  return null
}

/** 从 tool/result data 提取 callId（顶层 / message.source.callId / message.content[].toolCallId） */
function extractToolCallId(data: Record<string, unknown>): string | undefined {
  if (typeof data.callId === 'string' && data.callId !== '') return data.callId
  const message = data.message as { source?: { callId?: unknown }; content?: unknown } | undefined
  if (message?.source && typeof message.source.callId === 'string' && message.source.callId !== '') {
    return message.source.callId
  }
  if (Array.isArray(message?.content)) {
    for (const block of message.content) {
      if (block && typeof block === 'object') {
        const id = (block as { toolCallId?: unknown }).toolCallId
        if (typeof id === 'string' && id !== '') return id
      }
    }
  }
  return undefined
}

/** 提取 tool/result 的结果纯文本：真实落盘形状（message.content[] 的 tool-result 块）+ 顶层 content 旧形状 */
export function extractToolResultText(data: Record<string, unknown>): string {
  const message = data.message as { content?: unknown } | undefined
  if (message && Array.isArray(message.content)) {
    const texts: string[] = []
    for (const block of message.content) {
      if (!block || typeof block !== 'object') continue
      const b = block as { type?: unknown; content?: unknown }
      if (b.type !== 'tool-result') continue
      const text = extractText({ content: b.content })
      if (text !== undefined) texts.push(text)
    }
    return texts.join('')
  }
  const text = extractText({ content: data.content })
  return text ?? ''
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function formatErrorValue(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const e = error as { name?: unknown; code?: unknown; message?: unknown }
    const parts = [e.name, e.code, e.message].filter((p) => typeof p === 'string' && p !== '') as string[]
    if (parts.length > 0) return parts.join(': ')
    try {
      return JSON.stringify(error)
    } catch {
      return String(error)
    }
  }
  return String(error)
}

function truncate(s: string): string {
  return s.length > TOOL_ERROR_MAX ? s.slice(0, TOOL_ERROR_MAX) + '…' : s
}

/** zstd 帧魔数的字节形态（little-endian 0xFD2FB528 → `28 b5 2f fd`）。 */
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 从落盘会话日志采集观测结果。按文件头魔数自动识别编码：
 * `session.jsonl.zstd`（多帧 Zstandard）走 {@link decodeZstdLog} 直读，
 * `session.jsonl`（compression: 'none'）走 UTF-8 纯文本。v0.2 起两者都支持，
 * eval_run 不再依赖 overlay 强制 `compression: none`。
 */
export async function collectFromFile(path: string): Promise<CollectedTrace> {
  const bytes = await readFile(path)
  const isZstd = bytes.length >= 4 && bytes.subarray(0, 4).equals(ZSTD_MAGIC_BYTES)
  return collectFromJsonl(isZstd ? decodeZstdLog(bytes) : bytes.toString('utf8'))
}

/**
 * 读会话日志的 header 行（`session` 帧）。zstd 只解压首帧，纯文本只取首行；
 * 任何失败返回 null（调用方回退 mtime 启发式，不阻断采集）。runner 用
 * header 的 `delegationDepth` 区分父会话与 subagent/workflow 子会话。
 */
export async function readSessionHeader(path: string): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await readFile(path)
    const isZstd = bytes.length >= 4 && bytes.subarray(0, 4).equals(ZSTD_MAGIC_BYTES)
    const firstLine = isZstd
      ? decodeZstdFirstFrame(bytes)?.toString('utf8').split('\n', 1)[0]
      : bytes.toString('utf8').split('\n', 1)[0]
    if (!firstLine) return null
    const parsed: unknown = JSON.parse(firstLine)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
