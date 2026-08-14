import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { checkAssertions } from './assert.js'
import { collectFromFile, readSessionHeader } from './collector.js'
import { summarize } from './gate.js'
import { renderJson, renderMarkdown } from './report.js'
import { emptyTokenUsage } from './types.js'
import type { CaseResult, CollectedTrace, EvalAssert, EvalCase, RunReport } from './types.js'
import { parseYamlSubset } from './yaml-mini.js'

/** harness 自身版本（写进 report.json，与 package.json 保持同步）。 */
const harnessVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version

export interface RunOptions {
  casesDir: string
  outputDir: string
  /** 隔离 session 根目录（默认 <outputDir>/.sessions） */
  sessionRoot?: string
  /** dsh profile，默认 headless */
  profile?: string
  /** 单条用例子进程超时，默认 600000ms */
  timeoutMs?: number
  /** dsh 可执行命令（默认 env DSH_BIN 或 PATH 里的 dsh；支持 'npx -y @deepseek-ai/dsh' 带参数形式，按空白拆分） */
  dshBin?: string
}

const PREFIX = 'eval_run'

/** 解析并校验单条用例 yaml；失败 throw `eval_run:` 前缀错误 */
export function parseCase(text: string, file: string): EvalCase {
  let value: unknown
  try {
    value = parseYamlSubset(text)
  } catch (err) {
    throw new Error(`${PREFIX}: failed to parse case file '${file}': ${(err as Error).message}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${PREFIX}: failed to parse case file '${file}': top level must be a mapping`)
  }
  const raw = value as Record<string, unknown>
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new Error(`${PREFIX}: failed to parse case file '${file}': 'name' must be a non-empty string`)
  }
  if (typeof raw.prompt !== 'string' || raw.prompt === '') {
    throw new Error(`${PREFIX}: failed to parse case file '${file}': 'prompt' must be a non-empty string`)
  }
  if (raw.require_plugins !== undefined) {
    if (!Array.isArray(raw.require_plugins) || raw.require_plugins.some((p) => typeof p !== 'string')) {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'require_plugins' must be a list of strings`)
    }
  }
  if (!raw.assert || typeof raw.assert !== 'object' || Array.isArray(raw.assert)) {
    throw new Error(`${PREFIX}: failed to parse case file '${file}': 'assert' must be a mapping`)
  }
  const a = raw.assert as Record<string, unknown>
  const assert: EvalAssert = {}
  if (a.turn_end !== undefined) {
    if (typeof a.turn_end !== 'string') throw new Error(`${PREFIX}: failed to parse case file '${file}': 'assert.turn_end' must be a string`)
    assert.turn_end = a.turn_end
  }
  for (const key of ['tools_called', 'tools_exact', 'tools_not_called', 'output_contains', 'output_not_contains', 'output_matches'] as const) {
    if (a[key] !== undefined) {
      if (!Array.isArray(a[key]) || (a[key] as unknown[]).some((v) => typeof v !== 'string')) {
        throw new Error(`${PREFIX}: failed to parse case file '${file}': 'assert.${key}' must be a list of strings`)
      }
      assert[key] = a[key] as string[]
    }
  }
  // output_matches 的正则在解析阶段就编译验证，非法正则报带用例名的错
  for (const pattern of assert.output_matches ?? []) {
    try {
      new RegExp(pattern)
    } catch (err) {
      throw new Error(`${PREFIX}: failed to parse case file '${file}' (case '${raw.name}'): 'assert.output_matches' invalid regex '${pattern}': ${(err as Error).message}`)
    }
  }
  for (const key of ['tool_args_contains', 'tool_result_contains'] as const) {
    if (a[key] !== undefined) {
      const list = a[key]
      if (
        !Array.isArray(list) ||
        list.some(
          (v) => !v || typeof v !== 'object' || typeof (v as { name?: unknown }).name !== 'string' || typeof (v as { contains?: unknown }).contains !== 'string',
        )
      ) {
        throw new Error(`${PREFIX}: failed to parse case file '${file}': 'assert.${key}' must be a list of { name, contains } (both strings)`)
      }
      assert[key] = list as { name: string; contains: string }[]
    }
  }
  for (const key of ['max_steps', 'max_tokens'] as const) {
    if (a[key] !== undefined) {
      if (typeof a[key] !== 'number' || !Number.isInteger(a[key]) || (a[key] as number) < 0) {
        throw new Error(`${PREFIX}: failed to parse case file '${file}': 'assert.${key}' must be a non-negative integer`)
      }
      assert[key] = a[key] as number
    }
  }
  if (a.no_tool_errors !== undefined) {
    if (typeof a.no_tool_errors !== 'boolean') {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'assert.no_tool_errors' must be a boolean`)
    }
    assert.no_tool_errors = a.no_tool_errors
  }
  return { name: raw.name, prompt: raw.prompt, require_plugins: raw.require_plugins as string[] | undefined, assert }
}

/** 加载 cases 目录下全部 .yml/.yaml 用例（按文件名排序） */
export async function loadCases(casesDir: string): Promise<{ file: string; evalCase: EvalCase }[]> {
  let entries: string[]
  try {
    entries = await readdir(casesDir)
  } catch (err) {
    throw new Error(`${PREFIX}: cannot read cases_dir '${casesDir}': ${(err as Error).message}`)
  }
  const files = entries.filter((f) => /\.ya?ml$/.test(f)).sort()
  if (files.length === 0) {
    throw new Error(`${PREFIX}: no case files (*.yml/*.yaml) found in '${casesDir}'`)
  }
  const cases: { file: string; evalCase: EvalCase }[] = []
  for (const f of files) {
    const path = join(casesDir, f)
    cases.push({ file: f, evalCase: parseCase(await readFile(path, 'utf8'), f) })
  }
  return cases
}

/** dsh 调用命令：可执行文件 + 固定前缀参数（支持 `npx -y @deepseek-ai/dsh` 这类形式） */
export interface DshCommand {
  bin: string
  prefixArgs: string[]
}

/**
 * 把 dsh_bin 配置拆成 argv（按空白拆分，不走 shell，不支持引号——
 * 带空格的路径请改用 DSH_BIN 指向无空格路径或包装脚本）。
 */
export function splitDshBin(dshBin: string): DshCommand {
  const parts = dshBin.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) {
    throw new Error(`${PREFIX}: dsh_bin is empty`)
  }
  return { bin: parts[0], prefixArgs: parts.slice(1) }
}

/** 定位 dsh 可执行命令；找不到 throw `eval_run:` 前缀错误 */
export function resolveDshCommand(dshBin?: string): DshCommand {
  const configured = dshBin ?? process.env.DSH_BIN ?? 'dsh'
  const cmd = splitDshBin(configured)
  const probe = spawnSync(cmd.bin, [...cmd.prefixArgs, '--version'], { encoding: 'utf8', timeout: 60_000 })
  if (probe.error) {
    throw new Error(
      `${PREFIX}: dsh executable not found ('${configured}'): ${probe.error.message}. Install dsh or set DSH_BIN / pass dsh_bin (e.g. 'npx -y @deepseek-ai/dsh').`,
    )
  }
  return cmd
}

function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'case'
}

/**
 * 生成 --patch overlay：按 row id 整体替换 base bundle 的 session-persistence-jsonl
 * 配置（packages/bundle/base/cordis.patch.yml 的同名 row），把 session 落盘根切到
 * 隔离目录。不再强制 `compression: none`——v0.2 起 collector 直接读默认的
 * 多帧 zstd（session.jsonl.zstd），见 collector.collectFromFile。
 * root 用 JSON.stringify 转义为 YAML 双引号标量；name 含 @ 必须单引号包裹。
 */
export function buildOverlayYaml(root: string): string {
  return [
    '# generated by dsh-eval-harness eval_run — overlay for --patch (highest layer priority)',
    '- id: session-persistence-jsonl',
    "  name: '@deepseek-ai/dsh-session-persistence-jsonl'",
    '  config:',
    `    root: ${JSON.stringify(root)}`,
    '',
  ].join('\n')
}

/**
 * 拼接子进程参数：launcher flags（--profile/--patch）在前，prompt 是 app 位置参数放最后
 * （apps/cli/src/args.ts：`--patch <path>` 可重复、非 variadic；第一个无法识别的
 * token 起即 app 参数）。
 */
export function buildDshArgs(profile: string, overlayPath: string, prompt: string): string[] {
  return ['--profile', profile, '--patch', overlayPath, prompt]
}

/**
 * 在 sessionRoot 下递归找本次用例落盘的会话日志（session.jsonl 或默认的
 * session.jsonl.zstd，两者 collector 都能读）。多条用例共用一个 root、按 cwd
 * 编码目录分开；用例串行执行，取 mtime >= sinceMs 的候选。
 *
 * subagent/workflow 用例会在同一 root 额外落下 `delegationDepth > 0` 的子会话
 * （目录为裸 UUID，父会话目录带 `session-` 前缀）；纯 mtime 启发式可能错捡
 * 子会话（真机已观测到 2~3 个候选文件）。多候选时读 header 行的
 * `delegationDepth` 分档：父会话（0）> 不可解析 > 子会话（>0），同档取最新。
 */
export async function findSessionFile(dir: string, sinceMs: number): Promise<string | null> {
  async function walk(d: string): Promise<{ path: string; mtime: number }[]> {
    const found: { path: string; mtime: number }[] = []
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        found.push(...(await walk(p)))
      } else if (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd') {
        const mtime = (await stat(p)).mtimeMs
        if (mtime >= sinceMs) found.push({ path: p, mtime })
      }
    }
    return found
  }
  const candidates = await walk(dir)
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]!.path
  const ranked = await Promise.all(
    candidates.map(async (c) => {
      const header = await readSessionHeader(c.path)
      const depth = typeof header?.delegationDepth === 'number' ? header.delegationDepth : null
      return { ...c, rank: depth === 0 ? 0 : depth === null ? 1 : 2 }
    }),
  )
  ranked.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime)
  return ranked[0]!.path
}

function runOne(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean; stderrTail: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let killedByTimeout = false
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 8192) stderr = stderr.slice(-8192)
    })
    const timer = setTimeout(() => {
      killedByTimeout = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${PREFIX}: failed to spawn dsh: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, timedOut: killedByTimeout, stderrTail: stderr.trim() })
    })
  })
}

/** 从采集结果提取 report 用例字段（超时部分 trace 与正常路径共用）。 */
function traceFields(trace: CollectedTrace): Partial<Omit<CaseResult, 'status' | 'durationMs'>> {
  return {
    turnEnd: trace.turnEnd,
    toolsCalled: trace.toolsCalled,
    toolCalls: trace.toolCalls,
    toolResults: trace.toolResults,
    finalText: trace.finalText,
    steps: trace.steps,
    tokens: trace.tokens,
    toolErrors: trace.toolErrors,
  }
}

/** 超时/被杀后尽力采集部分 trace；任何失败返回 null（不掩盖超时本身）。 */
async function tryCollectTrace(sessionBase: string, sinceMs: number): Promise<CollectedTrace | null> {
  try {
    const sessionFile = await findSessionFile(sessionBase, sinceMs)
    return sessionFile ? await collectFromFile(sessionFile) : null
  } catch {
    return null
  }
}

/**
 * 逐条跑用例：fork `dsh --profile <profile> --patch <overlay> <prompt>` 子进程。
 * overlay（<outputDir>/eval-overlay.patch.yml）把 session-persistence-jsonl 的 root 切到
 * 隔离目录；每条用例另有独立 workspace 作 cwd（session 按 cwd 编码分目录）。
 * 完成后 collector 解析落盘日志（session.jsonl 或默认 zstd，见 collectFromFile）
 * + 断言，写 report.json / report.md。超时（SIGKILL）的用例也尽力采集部分
 * trace 进 report（残缺尾帧由 decodeZstdLog 恢复），供排查超时原因。
 */
export async function runEval(options: RunOptions): Promise<RunReport> {
  const profile = options.profile ?? 'headless'
  const timeoutMs = options.timeoutMs ?? 600_000
  const casesDir = resolve(options.casesDir)
  const outputDir = resolve(options.outputDir)
  const sessionBase = resolve(options.sessionRoot ?? join(outputDir, '.sessions'))
  const workspaceBase = join(outputDir, '.workspace')

  const dsh = resolveDshCommand(options.dshBin)
  const cases = await loadCases(casesDir)
  await mkdir(outputDir, { recursive: true })
  await mkdir(sessionBase, { recursive: true })
  const overlayPath = join(outputDir, 'eval-overlay.patch.yml')
  await writeFile(overlayPath, buildOverlayYaml(sessionBase))

  const results: CaseResult[] = []
  for (const { evalCase } of cases) {
    const slug = slugify(evalCase.name)
    const workspace = join(workspaceBase, slug)
    await mkdir(workspace, { recursive: true })

    const startedAt = Date.now()
    const base: Omit<CaseResult, 'status' | 'durationMs'> = {
      name: evalCase.name,
      failures: [],
      toolsCalled: [],
      toolCalls: [],
      toolResults: [],
      finalText: '',
      steps: 0,
      tokens: emptyTokenUsage(),
      toolErrors: [],
    }
    try {
      const proc = await runOne(dsh.bin, [...dsh.prefixArgs, ...buildDshArgs(profile, overlayPath, evalCase.prompt)], workspace, timeoutMs)
      if (proc.timedOut) {
        const partial = await tryCollectTrace(sessionBase, startedAt)
        results.push({
          ...base,
          ...(partial ? traceFields(partial) : {}),
          status: 'error',
          error: `dsh subprocess timed out after ${timeoutMs}ms`,
          durationMs: Date.now() - startedAt,
        })
        continue
      }
      const sessionFile = await findSessionFile(sessionBase, startedAt)
      if (!sessionFile) {
        const detail = proc.code !== 0 ? ` (dsh exited ${proc.code}${proc.stderrTail ? `: ${proc.stderrTail}` : ''})` : ''
        results.push({ ...base, status: 'error', error: `no session log (session.jsonl / session.jsonl.zstd) found under '${sessionBase}'${detail}`, durationMs: Date.now() - startedAt })
        continue
      }
      const trace = await collectFromFile(sessionFile)
      const failures = checkAssertions(evalCase.assert, trace)
      results.push({
        ...base,
        ...traceFields(trace),
        status: failures.length === 0 ? 'pass' : 'fail',
        failures,
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      results.push({ ...base, status: 'error', error: (err as Error).message, durationMs: Date.now() - startedAt })
    }
  }

  const report: RunReport = {
    tool: 'dsh-eval-harness',
    version: harnessVersion,
    startedAt: new Date().toISOString(),
    profile,
    cases: results,
    summary: summarize(results),
  }
  await writeFile(join(outputDir, 'report.json'), renderJson(report) + '\n')
  await writeFile(join(outputDir, 'report.md'), renderMarkdown(report))
  return report
}
