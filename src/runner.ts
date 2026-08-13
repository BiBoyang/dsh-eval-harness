import { spawn, spawnSync } from 'node:child_process'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { checkAssertions } from './assert.js'
import { collectFromFile } from './collector.js'
import { summarize } from './gate.js'
import { renderJson, renderMarkdown } from './report.js'
import type { CaseResult, EvalAssert, EvalCase, RunReport } from './types.js'
import { parseYamlSubset } from './yaml-mini.js'

export interface RunOptions {
  casesDir: string
  outputDir: string
  /** 隔离 session 根目录（默认 <outputDir>/.sessions） */
  sessionRoot?: string
  /** dsh profile，默认 headless */
  profile?: string
  /** 单条用例子进程超时，默认 600000ms */
  timeoutMs?: number
  /** dsh 可执行文件（默认 env DSH_BIN 或 PATH 里的 dsh） */
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
  for (const key of ['tools_called', 'output_contains'] as const) {
    if (a[key] !== undefined) {
      if (!Array.isArray(a[key]) || (a[key] as unknown[]).some((v) => typeof v !== 'string')) {
        throw new Error(`${PREFIX}: failed to parse case file '${file}': 'assert.${key}' must be a list of strings`)
      }
      assert[key] = a[key] as string[]
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

/** 定位 dsh 可执行文件；找不到 throw `eval_run:` 前缀错误 */
export function resolveDshBin(dshBin?: string): string {
  const bin = dshBin ?? process.env.DSH_BIN ?? 'dsh'
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 })
  if (probe.error) {
    throw new Error(
      `${PREFIX}: dsh executable not found ('${bin}'): ${probe.error.message}. Install dsh or set DSH_BIN / pass dsh_bin.`,
    )
  }
  return bin
}

function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'case'
}

/** 在 sessionRoot 下递归找最新落盘的 session.jsonl（compression: 'none' 产物） */
async function findSessionFile(dir: string): Promise<string | null> {
  let best: { path: string; mtime: number } | null = null
  let sawZstd = false
  async function walk(d: string): Promise<void> {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) await walk(p)
      else if (entry.name === 'session.jsonl') {
        const mtime = (await stat(p)).mtimeMs
        if (!best || mtime > best.mtime) best = { path: p, mtime }
      } else if (entry.name === 'session.jsonl.zstd') {
        sawZstd = true
      }
    }
  }
  await walk(dir)
  if (!best && sawZstd) {
    throw new Error(
      `${PREFIX}: only session.jsonl.zstd found under '${dir}'; multi-frame zstd parsing is not supported in v0.1 — configure session persistence with compression: 'none'`,
    )
  }
  return best ? (best as { path: string }).path : null
}

function runOne(
  bin: string,
  profile: string,
  prompt: string,
  cwd: string,
  sessionDir: string,
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean; stderrTail: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, ['--profile', profile, prompt], {
      cwd,
      env: {
        ...process.env,
        // 隔离 session 落盘根；要求纯 JSONL 便于 collector 解析
        DSH_SESSION_ROOT: sessionDir,
        DSH_SESSION_COMPRESSION: 'none',
      },
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

/**
 * 逐条跑用例：fork `dsh --profile <profile> <prompt>` 子进程（隔离 session_root/workspace），
 * 完成后 collector 解析 session.jsonl + 断言，写 report.json / report.md 到 outputDir。
 */
export async function runEval(options: RunOptions): Promise<RunReport> {
  const profile = options.profile ?? 'headless'
  const timeoutMs = options.timeoutMs ?? 600_000
  const casesDir = resolve(options.casesDir)
  const outputDir = resolve(options.outputDir)
  const sessionBase = resolve(options.sessionRoot ?? join(outputDir, '.sessions'))
  const workspaceBase = join(outputDir, '.workspace')

  const bin = resolveDshBin(options.dshBin)
  const cases = await loadCases(casesDir)
  await mkdir(outputDir, { recursive: true })

  const results: CaseResult[] = []
  for (const { evalCase } of cases) {
    const slug = slugify(evalCase.name)
    const sessionDir = join(sessionBase, slug)
    const workspace = join(workspaceBase, slug)
    await mkdir(sessionDir, { recursive: true })
    await mkdir(workspace, { recursive: true })

    const startedAt = Date.now()
    const base: Omit<CaseResult, 'status' | 'durationMs'> = {
      name: evalCase.name,
      failures: [],
      toolsCalled: [],
      finalText: '',
      steps: 0,
      tokens: { input: 0, output: 0 },
    }
    try {
      const proc = await runOne(bin, profile, evalCase.prompt, workspace, sessionDir, timeoutMs)
      if (proc.timedOut) {
        results.push({ ...base, status: 'error', error: `dsh subprocess timed out after ${timeoutMs}ms`, durationMs: Date.now() - startedAt })
        continue
      }
      const sessionFile = await findSessionFile(sessionDir)
      if (!sessionFile) {
        const detail = proc.code !== 0 ? ` (dsh exited ${proc.code}${proc.stderrTail ? `: ${proc.stderrTail}` : ''})` : ''
        results.push({ ...base, status: 'error', error: `no session.jsonl found under '${sessionDir}'${detail}`, durationMs: Date.now() - startedAt })
        continue
      }
      const trace = await collectFromFile(sessionFile)
      const failures = checkAssertions(evalCase.assert, trace)
      results.push({
        ...base,
        status: failures.length === 0 ? 'pass' : 'fail',
        failures,
        turnEnd: trace.turnEnd,
        toolsCalled: trace.toolsCalled,
        finalText: trace.finalText,
        steps: trace.steps,
        tokens: trace.tokens,
        durationMs: Date.now() - startedAt,
      })
    } catch (err) {
      results.push({ ...base, status: 'error', error: (err as Error).message, durationMs: Date.now() - startedAt })
    }
  }

  const report: RunReport = {
    tool: 'dsh-eval-harness',
    version: '0.1.0',
    startedAt: new Date().toISOString(),
    profile,
    cases: results,
    summary: summarize(results),
  }
  await writeFile(join(outputDir, 'report.json'), renderJson(report) + '\n')
  await writeFile(join(outputDir, 'report.md'), renderMarkdown(report))
  return report
}
