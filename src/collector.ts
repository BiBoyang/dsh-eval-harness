import { readFile } from 'node:fs/promises'
import type { CollectedTrace } from './types.js'

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
 * 只提取四类帧：
 * - `turn/end`：data.reason.kind（取最后一帧）
 * - `tool/call`：data.name（按出现顺序）
 * - `assistant/message`：data.message 文本（取最后一帧）+ 累加 data.usage.inputTokens/outputTokens
 * - `step/end`：计数
 *
 * 不良行（非 JSON / 无 type）跳过并计数，不抛错——collector 对脏 trace 保持健壮。
 *
 * TODO(v0.2)：多帧 zstd（session.jsonl.zstd）解析。v0.1 要求评测时配置
 * compression: 'none' 让 DSH 落盘纯 JSONL；多帧 zstd 需按帧边界逐帧解压
 * （参考官方 dsh-session-persistence-jsonl 的 scanZstdFrames/createZstdFrameDecoder）。
 */
export function collectFromJsonl(text: string): CollectedTrace {
  const toolsCalled: string[] = []
  const tokens = { input: 0, output: 0 }
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
        if (typeof data.name === 'string') toolsCalled.push(data.name)
        break
      }
      case 'assistant/message': {
        const text = extractText(data.message)
        if (text !== undefined) finalText = text
        const usage = data.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined
        if (usage) {
          if (typeof usage.inputTokens === 'number') tokens.input += usage.inputTokens
          if (typeof usage.outputTokens === 'number') tokens.output += usage.outputTokens
        }
        break
      }
      case 'step/end': {
        steps++
        break
      }
    }
  }

  return { turnEnd, toolsCalled, finalText, steps, tokens, events, skippedLines }
}

/** 从落盘的 session.jsonl（纯 JSONL，compression: 'none'）采集观测结果 */
export async function collectFromFile(path: string): Promise<CollectedTrace> {
  return collectFromJsonl(await readFile(path, 'utf8'))
}
