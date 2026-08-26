import type { ErrorSignatureGroup, RunReport } from './types.js'

/**
 * 从 dsh 子进程 stderr 提取错误签名：`<错误码>@<栈顶应用帧函数>`。
 *
 * 设计约束（为什么这么写，改动前先读）：
 * - 保守提取，宁缺毋滥：取不到 `Error: <code>` 行就返回 null，不参与聚合——
 *   签名是启发式诊断视图，错聚类比漏聚类危害大（会把不同根因揉成一团）。
 * - 栈帧取第一个非 `node:` 内部帧的函数名：内部帧（如 readlinkSync）是
 *   Node 实现细节，应用帧（如 ensureSymlink）才指向责任代码位置。
 * - 路径、行号、错误消息一律不进签名：同一根因在不同机器/版本上路径不同，
 *   进签名会把同类错误拆散。
 */
export function extractErrorSignature(stderr: string | undefined): string | null {
  if (!stderr) return null
  // 两种真实形状：`Error: ENOENT: <msg>`（系统错误，取错误码）与
  // `TypeError: <msg>`（JS 异常，取异常名）。可选组的 `: ` 边界防止把
  // 错误消息首词（如 "Cannot read ..."）误当错误码。
  const codeMatch = /^(\w*Error): (?:([A-Za-z_$][\w$]*): )?/m.exec(stderr)
  if (!codeMatch) return null
  const code = codeMatch[2] ?? codeMatch[1]
  if (code === undefined) return null
  const frameRegex = /^\s*at (?:async )?[\w$.<>]+ \(([^)]+)\)/gm
  const fnRegex = /^\s*at (?:async )?([\w$.<>]+) \(/
  for (const frameMatch of stderr.matchAll(frameRegex)) {
    const location = frameMatch[1]
    if (location === undefined || location.startsWith('node:')) continue
    const fn = fnRegex.exec(frameMatch[0])?.[1]
    if (fn) return `${code}@${fn}`
  }
  return code
}

/**
 * 聚合整次 run 的 stderr 错误签名（跨用例、跨 attempt）。
 * 只扫描失败 attempt（status !== 'pass'）——pass attempt 的 stderr 多为
 * 无害警告，聚进来只会制造噪音。返回按出现次数降序的分组。
 */
export function aggregateErrorSignatures(report: RunReport): ErrorSignatureGroup[] {
  const groups = new Map<string, { occurrences: number; cases: string[] }>()
  for (const c of report.cases) {
    for (const attempt of c.attemptResults) {
      if (attempt.status === 'pass') continue
      const signature = extractErrorSignature(attempt.stderrTail)
      if (signature === null) continue
      const group = groups.get(signature) ?? { occurrences: 0, cases: [] }
      group.occurrences += 1
      if (!group.cases.includes(c.name)) group.cases.push(c.name)
      groups.set(signature, group)
    }
  }
  return [...groups.entries()]
    .map(([signature, g]) => ({ signature, occurrences: g.occurrences, cases: g.cases }))
    .sort((a, b) => b.occurrences - a.occurrences || a.signature.localeCompare(b.signature))
}

/** 同一签名出现 >= 此次数即视为「崩在同一处」的共享态事故信号（门禁/报告采用） */
export const REPEATED_SIGNATURE_THRESHOLD = 2
