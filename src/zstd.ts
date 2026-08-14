/**
 * 多帧 Zstandard 直读：解析 DSH 默认落盘的 `session.jsonl.zstd`。
 *
 * dsh-session-persistence-jsonl 把会话日志写成一个**拼接帧容器**：首帧恰为
 * header 行，后续每帧一个事件批，帧与帧之间彼此独立可解压（checksum 开启）。
 * 本模块按帧边界结构扫描 + 逐帧解压（Node 公共 API `zstdDecompressSync`），
 * 拼接出与 `compression: none` 落盘字节一致的 JSONL 文本，再交给 collector。
 *
 * 结构扫描参考官方 `@deepseek-ai/dsh-session-persistence-jsonl` 的
 * `scanZstdFrames`（同款 magic/描述符/块头解析），但只依赖 Node 内置 zlib，
 * 零外部依赖。尾帧结构性不完整（进程被杀/断电）时，用 `finishFlush` 尽力
 * 恢复可用明文；恢复失败只丢弃尾帧，不丢掉已完成的帧。
 *
 * @module dsh-eval-harness/zstd
 */

import { constants, zstdDecompressSync } from 'node:zlib'

/** Zstandard 帧魔数（little-endian 0xFD2FB528，文件头 4 字节 `28 b5 2f fd`）。 */
const ZSTD_MAGIC = 0xFD2FB528

/** 一个结构完整 Zstandard 帧占用的字节区间。 */
export interface ZstdFrameRange {
  /** 帧起始（含）。 */
  start: number
  /** 帧结束（不含）。 */
  end: number
}

/** 拼接 Zstandard 流的结构扫描结果。 */
export interface ZstdFrameScan {
  /** 按文件顺序排列的完整帧。 */
  frames: ZstdFrameRange[]
  /** EOF 打断最后一个帧时的帧起始；无残缺尾帧时缺省。 */
  tornStart?: number
}

/**
 * 定位完整帧边界，不解压块内容。结构非法的完整帧直接抛错；EOF 落在最后一帧
 * 内部时返回其起始（供修复/前缀恢复）。
 */
export function scanZstdFrames(buffer: Buffer): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt zstd session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt zstd session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt zstd session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }

  return { frames }
}

/**
 * 只解压首个完整帧（读 header 行等场景，避免全量解码）。无完整帧返回 null。
 */
export function decodeZstdFirstFrame(buffer: Buffer): Buffer | null {
  const { frames } = scanZstdFrames(buffer)
  if (frames.length === 0) return null
  return zstdDecompressSync(buffer.subarray(frames[0]!.start, frames[0]!.end))
}

/**
 * 把拼接 zstd 帧解码为 JSONL 文本。完整帧逐帧解压后拼接；残缺尾帧尽力用
 * `finishFlush` 恢复可用明文（失败则丢弃，不影响已完成的帧）。
 */
export function decodeZstdLog(buffer: Buffer): string {
  const { frames, tornStart } = scanZstdFrames(buffer)
  if (frames.length === 0) {
    throw new Error('corrupt zstd session log: no complete frames')
  }
  const parts: Buffer[] = []
  for (const { start, end } of frames) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)))
    } catch (error) {
      throw new Error(`corrupt zstd session log: frame at byte ${start} failed validation`, { cause: error })
    }
  }
  if (tornStart !== undefined) {
    try {
      parts.push(zstdDecompressSync(buffer.subarray(tornStart), { finishFlush: constants.ZSTD_e_flush }))
    } catch {
      // 结构不完整的尾帧可能解不出任何明文；完整帧已恢复，忽略即可。
    }
  }
  return Buffer.concat(parts).toString('utf8')
}
