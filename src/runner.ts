import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { checkAssertions } from './assert.js'
import { collectFromFile, readSessionHeader } from './collector.js'
import { summarize } from './gate.js'
import { judgeOutput } from './judge.js'
import { startMockServer } from './mock.js'
import type { MockFault, MockServer } from './mock.js'
import { renderJson, renderMarkdown } from './report.js'
import { CURRENT_REPORT_SCHEMA_VERSION, emptyTokenUsage } from './types.js'
import type { AttemptResult, CaseResult, CollectedTrace, EvalAssert, EvalCase, MockApi, MockCaseConfig, MockDeliverySummary, RunReport } from './types.js'
import { parseYamlSubset } from './yaml-mini.js'
import { buildReliability } from './reliability.js'

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
  /** 并行跑用例的并发数，默认 1（串行）。每条用例有独立 session 根与 workspace，互不干扰 */
  concurrency?: number
  /** 失败重跑的全局默认次数（非负整数，默认 0 不重跑）；用例 yaml 的 retries 优先于此值 */
  retries?: number
  /** 可靠性测量的独立 trial 次数（正整数，默认 1 单次）；用例 yaml 的 trials 优先于此值。trials > 1 时忽略 retries */
  trials?: number
  /** pass@k / pass^k 的 k（正整数，默认 2）；任何 trials > 1 的用例要求 k ≤ trials，否则报错 */
  passK?: number
  /**
   * output_judge 的判定函数注入口（测试用；缺省用 src/judge.ts 的真实实现，
   * 配置走环境变量）。不进 eval_run 工具的 parameters schema——工具层无感。
   */
  judge?: (input: { rubric: string; output: string }) => Promise<{ pass: boolean; reason: string }>
  /** 只跑命中任一标签的用例（用例 yaml 的 tags 字段） */
  tags?: string[]
  /** 只跑这些名字（精确匹配）的用例 */
  only?: string[]
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
  if (raw.tags !== undefined) {
    if (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== 'string')) {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'tags' must be a list of strings`)
    }
  }
  if (raw.retries !== undefined) {
    if (typeof raw.retries !== 'number' || !Number.isInteger(raw.retries) || raw.retries < 0) {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'retries' must be a non-negative integer`)
    }
  }
  if (raw.trials !== undefined) {
    if (typeof raw.trials !== 'number' || !Number.isInteger(raw.trials) || raw.trials < 1) {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'trials' must be a positive integer`)
    }
  }
  const MOCK_APIS: MockApi[] = ['openai-completions', 'openai-responses', 'anthropic-messages']
  let mock: MockCaseConfig | undefined
  if (raw.mock !== undefined) {
    if (!raw.mock || typeof raw.mock !== 'object' || Array.isArray(raw.mock)) {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'mock' must be a mapping`)
    }
    const m = raw.mock as Record<string, unknown>
    if (m.fault !== undefined && (typeof m.fault !== 'string' || !/^F[0-5]$/.test(m.fault))) {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'mock.fault' must be one of F0-F5`)
    }
    if (m.api !== undefined && (typeof m.api !== 'string' || !MOCK_APIS.includes(m.api as MockApi))) {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'mock.api' must be one of ${MOCK_APIS.join(', ')}`)
    }
    if (m.once !== undefined && typeof m.once !== 'boolean') {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'mock.once' must be a boolean`)
    }
    if (m.plugins !== undefined) {
      if (!Array.isArray(m.plugins) || m.plugins.some((p) => typeof p !== 'string' || p.trim() === '')) {
        throw new Error(`${PREFIX}: failed to parse case file '${file}': 'mock.plugins' must be a list of non-empty strings`)
      }
    }
    mock = {
      ...(m.fault === undefined ? {} : { fault: m.fault as MockFault }),
      ...(m.api === undefined ? {} : { api: m.api as MockApi }),
      ...(m.once === undefined ? {} : { once: m.once }),
      ...(m.plugins === undefined ? {} : { plugins: m.plugins as string[] }),
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
  if (a.exit_code !== undefined) {
    if (typeof a.exit_code !== 'number' || !Number.isInteger(a.exit_code) || a.exit_code < 0) {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'assert.exit_code' must be a non-negative integer`)
    }
    assert.exit_code = a.exit_code
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
  if (a.output_judge !== undefined) {
    const judge = a.output_judge as { rubric?: unknown } | null
    if (!judge || typeof judge !== 'object' || Array.isArray(judge) || typeof judge.rubric !== 'string' || judge.rubric === '') {
      throw new Error(`${PREFIX}: failed to parse case file '${file}': 'assert.output_judge' must be a mapping with a non-empty string 'rubric'`)
    }
    assert.output_judge = { rubric: judge.rubric }
  }
  return { name: raw.name, prompt: raw.prompt, require_plugins: raw.require_plugins as string[] | undefined, tags: raw.tags as string[] | undefined, retries: raw.retries as number | undefined, trials: raw.trials as number | undefined, mock, assert }
}

/**
 * 用例筛选：only（用例名精确匹配）与 tags（用例 tags 任一命中）同时给时取交集。
 * 两个条件都缺省/为空数组 → 不筛选。
 */
export function filterCases<T extends { evalCase: EvalCase }>(cases: T[], filter: { tags?: string[]; only?: string[] }): T[] {
  const only = filter.only?.filter((n) => n !== '') ?? []
  const tags = filter.tags?.filter((t) => t !== '') ?? []
  if (only.length === 0 && tags.length === 0) return cases
  return cases.filter(({ evalCase: c }) => {
    if (only.length > 0 && !only.includes(c.name)) return false
    if (tags.length > 0 && !(c.tags ?? []).some((t) => tags.includes(t))) return false
    return true
  })
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
  // gate 按 name 对比 baseline，重名会让对比失真；slugify 也非唯一键，直接拒绝
  const seen = new Map<string, string>()
  for (const { file, evalCase } of cases) {
    const prev = seen.get(evalCase.name)
    if (prev !== undefined) {
      throw new Error(`${PREFIX}: duplicate case name '${evalCase.name}' in '${prev}' and '${file}': gate compares baseline by name`)
    }
    seen.set(evalCase.name, file)
  }
  return cases
}

/** dsh 调用命令：可执行文件 + 固定前缀参数（支持 `npx -y @deepseek-ai/dsh` 这类形式） */
export interface DshCommand {
  bin: string
  prefixArgs: string[]
  /** --version 探针 stdout 首行；仅 resolveDshCommand 成功时带，splitDshBin 不含 */
  version?: string
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
  const stderrTail = typeof probe.stderr === 'string' ? probe.stderr.trim().slice(-8192) : ''
  if (probe.signal) {
    throw new Error(
      `${PREFIX}: dsh version probe was terminated by signal ${probe.signal}${stderrTail ? `: ${stderrTail}` : ''}`,
    )
  }
  if (probe.status !== 0) {
    throw new Error(
      `${PREFIX}: dsh version probe exited ${probe.status ?? '<unknown>'}${stderrTail ? `: ${stderrTail}` : ''}`,
    )
  }
  // 探针 stdout 首行即 dsh 版本（写进 report，供排障时定位「dsh 变了还是模型变了」）
  const version = typeof probe.stdout === 'string' ? probe.stdout.trim().split('\n')[0]?.trim() : ''
  return version ? { ...cmd, version } : cmd
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
 * mock 模式的隔离 DSH_HOME settings.yaml：agent 默认模型指向 mock provider。
 * 结构锚点：dsh 0.1.7-rc.2（与横评实测跑通的 settings.yaml.imported 同构）。
 */
export function buildMockSettingsYaml(baseURL: string, api: MockApi): string {
  return [
    '# generated by dsh-eval-harness eval_run mock mode — provider points at the per-case ephemeral mock',
    'agent-default-model:',
    '  provider: mock',
    '  model: mock-model',
    'permission:',
    '  defaultPreset: danger-full-access',
    'llm-pi-ai:',
    '  providers:',
    '    mock:',
    '      apiKeyEnv: MOCK_API_KEY',
    `      api: ${api}`,
    `      baseURL: ${baseURL}`,
    '      models:',
    '        - id: mock-model',
    '',
  ].join('\n')
}

/**
 * 生成隔离 DSH_HOME：settings.yaml + profiles/<profile> 三件套。结构照抄横评实测
 * 跑通的 dsh-home（mock-provider/run/dsh-home）：dsh 首次运行会把 settings.yaml
 * import 进 profile 并改名 .imported——这里同时给出两处且值一致，import 幂等。
 * 不碰用户真实 ~/.dsh；dsh 版本锚点 0.1.7-rc.2。
 */
export async function writeMockHome(home: string, profile: string, baseURL: string, api: MockApi): Promise<void> {
  await mkdir(join(home, 'profiles', profile), { recursive: true })
  await writeFile(join(home, 'settings.yaml'), buildMockSettingsYaml(baseURL, api))
  await writeFile(
    join(home, 'profiles', profile, 'package.json'),
    `${JSON.stringify(
      {
        name: `dsh-profile-${profile}-eval-mock`,
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'], patchReload: 'startup' } },
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(home, 'profiles', profile, 'cordis.yml'),
    ['# dsh profile root — empty entry list; config lives in cordis.patch.yml', '[]', ''].join('\n'),
  )
  await writeFile(
    join(home, 'profiles', profile, 'cordis.patch.yml'),
    [
      '# generated by dsh-eval-harness eval_run mock mode (structure mirrors the cross-eval verified dsh-home)',
      '- id: agent-default-model',
      "  name: '@deepseek-ai/dsh-agent-default-model'",
      '  config:',
      '    provider: mock',
      '    model: mock-model',
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '  config:',
      '    presets:',
      '      read-only:',
      '        sandbox: read-only',
      '        approval: ask',
      '      workspace-write:',
      '        sandbox: workspace-write',
      '        approval: ask',
      '      danger-full-access:',
      '        sandbox: danger-full-access',
      '        approval: never',
      '    defaultPreset: danger-full-access',
      '- id: llm-pi-ai',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      mock:',
      '        apiKeyEnv: MOCK_API_KEY',
      `        api: ${api}`,
      `        baseURL: ${baseURL}`,
      '        models:',
      '          - id: mock-model',
      '',
    ].join('\n'),
  )
}

const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'] as const

/**
 * mock 模式子进程 env：现有透传基础上覆盖 DSH_HOME / MOCK_API_KEY，另给
 * DEEPSEEK_API_KEY 一个 dummy 值（dsh 0.1.7-rc.2 启动校验 deepseek-official 路由
 * 凭据，实际请求走 mock 路由），并清掉代理变量（横评实测：代理 env 会劫持
 * 127.0.0.1 上的 mock 连接，f0-dsh.sh 为此先 unset）。
 */
function buildMockEnv(mockHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: mockHome, MOCK_API_KEY: 'mock', DEEPSEEK_API_KEY: 'mock' }
  for (const key of PROXY_ENV_KEYS) delete env[key]
  return env
}

/** dsh 安装器子进程参数：`plugin --profile <profile> add <spec>`（转发给 profile 目录内的 pnpm） */
export function buildPluginInstallArgs(profile: string, spec: string): string[] {
  return ['plugin', '--profile', profile, 'add', spec]
}

/**
 * 终结以 child 为根的整棵子进程树（POSIX 进程组杀）。
 *
 * 为什么需要：只 SIGKILL 直接子进程时，包装器形态（`pnpm -C … dsh`、`bash -c …`）
 * 的孙进程孤儿化并继续握住 stdio 管道，'close' 事件等不到 EOF，runner 永挂
 * （实战挂死 34 分钟，见 .eval/plugin-check-2026-09-26/SUMMARY.md 环境节 4）。
 *
 * 负 pid 杀组的前提与安全性：child 必须是 `detached: true` spawn 的——POSIX 下
 * Node 对其调 setsid(2)，子进程自立会话与进程组且 pgid == child.pid。发 SIGKILL
 * 前先用信号 0 探测 `-pid`：pgid 是组长的 pid，拥有该 pid 的进程只有 child 自己，
 * 故探测成功 ⟺ 「组 id == 该子进程 pid」的组确实存在；此时 kill(-pid) 命中的必然
 * 是这棵树的组，绝不可能误杀 harness 自身所在的组（harness 的 pgid 继承自父
 * shell，不等于任何后代 pid；且本函数只在 'close' 触发前的超时路径被调用，pid
 * 不会被回收重用——组内只要有成员存活，该 pgid 就仍被占用）。非 detached spawn
 * 的子进程禁止传入：那时子进程与 harness 同组，-pid 语义不再成立。
 *
 * Windows 退化：无 POSIX 进程组语义，Node 的 detached 含义不同且不支持负 pid
 * 杀组，退回只杀直接子进程（孙进程可能孤儿化）；等价语义候选
 * `taskkill /pid <pid> /T /F`——按任务契约为非目标，不在此实现。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (typeof pid !== 'number') return
  if (process.platform === 'win32') {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已退出：忽略
    }
    return
  }
  try {
    process.kill(-pid, 0)
  } catch {
    // 组已随整棵树终结而消失（正常竞态）——直接子进程此时也必然已死
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // 探测与发信号之间树已退出：退回只杀直接子进程兜底，不掩盖主流程
    try {
      child.kill('SIGKILL')
    } catch {
      // 已退出：忽略
    }
  }
}

/**
 * 用 dsh 自己的安装器把一个插件 spec 装进隔离 DSH_HOME 的 profile（env 与评测
 * 子进程同构）。失败/超时 throw `eval_run:` 前缀错误——调用点在 runAttemptInner
 * 的 try 内，天然落成该用例的 attempt error（消息含 spec 与安装器输出尾部），
 * 不中断整个 run。安装需要网络属预期；pnpm 经 PATH 解析（dsh 侧行为）。
 */
async function installMockPlugin(
  dsh: DshCommand,
  profile: string,
  spec: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const args = [...dsh.prefixArgs, ...buildPluginInstallArgs(profile, spec)]
  const command = [dsh.bin, ...args].join(' ')
  await new Promise<void>((resolvePromise, reject) => {
    // detached（POSIX 限定）：安装器自立进程组（pgid == 自身 pid），超时由 killProcessTree
    // 终结整棵树——pnpm 包装器的孙进程孤儿化会握住管道让 'close' 永不触发（Windows 退化见上）
    const child = spawn(dsh.bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let output = ''
    const take = (chunk: Buffer): void => {
      output += chunk.toString()
      if (output.length > 8192) output = output.slice(-8192)
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    let killedByTimeout = false
    const timer = setTimeout(() => {
      killedByTimeout = true
      killProcessTree(child)
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`${PREFIX}: mock.plugins: install of '${spec}' failed to spawn '${command}': ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolvePromise()
        return
      }
      const status = killedByTimeout ? `timed out after ${timeoutMs}ms` : `exited ${code ?? 'without an exit code'}`
      const tail = output.trim().slice(-2000)
      reject(new Error(`${PREFIX}: mock.plugins: install of '${spec}' failed ('${command}' ${status})${tail ? `: ${tail}` : ''}`))
    })
  })
}

/**
 * 在 sessionRoot 下递归找本次用例落盘的会话日志，文件名匹配
 * `session[.vN].jsonl[.zstd]`（dsh 的代际命名：旧版 session.jsonl(.zstd)，
 * 0.1.7-rc.2 起当前代写 session.v4.jsonl.zstd——session-format/filename.ts 的
 * `session.v${generation}.jsonl`），collector 对两种压缩形态都能读。每条用例独占
 * 一个 session 根（runEval 按用例生成 per-case overlay），并行跑时天然隔离；
 * 取 mtime >= sinceMs 的候选。
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
      } else if (/^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(entry.name)) {
        const mtime = (await stat(p)).mtimeMs
        if (mtime >= sinceMs) found.push({ path: p, mtime })
      }
    }
    return found
  }
  const candidates = await walk(dir)
  if (candidates.length === 0) return null
  if (candidates.length === 1) {
    const only = candidates[0]
    return only?.path ?? null
  }
  const ranked = await Promise.all(
    candidates.map(async (c) => {
      const header = await readSessionHeader(c.path)
      const depth = typeof header?.delegationDepth === 'number' ? header.delegationDepth : null
      return { ...c, rank: depth === 0 ? 0 : depth === null ? 1 : 2 }
    }),
  )
  ranked.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime)
  const best = ranked[0]
  return best?.path ?? null
}

function runOne(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = { ...process.env },
): Promise<{ code: number | null; timedOut: boolean; stderrTail: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
      // detached（POSIX 限定）：子进程自立进程组（pgid == 自身 pid），超时由 killProcessTree
      // 终结整棵树；正常路径（无超时）语义不变，Windows 退化见 killProcessTree 注释
      detached: process.platform !== 'win32',
    })
    let stderr = ''
    let killedByTimeout = false
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 8192) stderr = stderr.slice(-8192)
    })
    const timer = setTimeout(() => {
      killedByTimeout = true
      killProcessTree(child)
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
    events: trace.events,
    skippedLines: trace.skippedLines,
  }
}

/** dsh 子进程结果写入 report 的诊断字段（stderr 为空时不写，避免报告噪声）。 */
function processFields(proc: { code: number | null; timedOut: boolean; stderrTail: string }): Pick<CaseResult, 'exitCode' | 'timedOut'> & Partial<Pick<CaseResult, 'stderrTail'>> {
  return {
    exitCode: proc.code,
    timedOut: proc.timedOut,
    ...(proc.stderrTail ? { stderrTail: proc.stderrTail } : {}),
  }
}

function processExitError(proc: { code: number | null; stderrTail: string }): string {
  const status = proc.code === null ? 'terminated without an exit code' : `exited with code ${proc.code}`
  return `dsh subprocess ${status}${proc.stderrTail ? `: ${proc.stderrTail}` : ''}`
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
 * 跑用例：fork `dsh --profile <profile> --patch <overlay> <prompt>` 子进程。
 * 每条用例独占一份 overlay（<outputDir>/eval-overlay-<序号>-<slug>.patch.yml），把
 * session-persistence-jsonl 的 root 切到该用例的隔离目录（<sessionBase>/<序号>-<slug>，
 * 序号是加载序——slugify 不是唯一键），
 * 另有独立 workspace 作 cwd——并行跑（concurrency > 1）时各用例互不干扰。
 * 完成后 collector 解析落盘日志（session.jsonl 或默认 zstd，见 collectFromFile）
 * + 断言，写 report.json / report.md。超时（SIGKILL）的用例也尽力采集部分
 * trace 进 report（残缺尾帧由 decodeZstdLog 恢复），供排查超时原因。
 *
 * tags / only 筛选后无命中用例会直接报错（防止 CI 里筛选条件笔误导致空跑假绿）。
 */
export async function runEval(options: RunOptions): Promise<RunReport> {
  const runStartedAtMs = Date.now()
  const runStartedAt = new Date(runStartedAtMs).toISOString()
  const profile = options.profile ?? 'headless'
  const timeoutMs = options.timeoutMs ?? 600_000
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1))
  const retriesDefault = Math.max(0, Math.floor(options.retries ?? 0))
  const trialsDefault = Math.max(1, Math.floor(options.trials ?? 1))
  const passK = Math.max(1, Math.floor(options.passK ?? 2))
  // judge 缺省用真实实现（env 配置）；测试经 RunOptions.judge 注入假实现
  const judgeFn = options.judge ?? judgeOutput
  const casesDir = resolve(options.casesDir)
  const outputDir = resolve(options.outputDir)
  const sessionBase = resolve(options.sessionRoot ?? join(outputDir, '.sessions'))
  const workspaceBase = join(outputDir, '.workspace')

  const dsh = resolveDshCommand(options.dshBin)
  const allCases = await loadCases(casesDir)
  // 带原始加载序号过滤：隔离目录用加载序（而非筛选后的运行序），
  // 同一条用例全量跑 / only 单跑时 artifact 路径稳定
  const cases = filterCases(
    allCases.map((entry, loadIndex) => ({ ...entry, loadIndex })),
    { tags: options.tags, only: options.only },
  )
  if (cases.length === 0) {
    throw new Error(`${PREFIX}: no cases matched filter (tags=${JSON.stringify(options.tags ?? [])} only=${JSON.stringify(options.only ?? [])}) in '${casesDir}'`)
  }
  // pass@k 的 k 不能超出任何用例的有效 trials：小样本外推会给出虚假精确的数
  for (const { evalCase } of cases) {
    const trials = evalCase.trials ?? trialsDefault
    if (trials > 1 && passK > trials) {
      throw new Error(`${PREFIX}: pass_k (${passK}) must not exceed trials (${trials}) of case '${evalCase.name}'`)
    }
  }
  await mkdir(outputDir, { recursive: true })
  await mkdir(sessionBase, { recursive: true })

  const runCase = async (evalCase: EvalCase, index: number): Promise<CaseResult> => {
    // 隔离目录带加载序号：slugify 不是唯一键（"read image" 与 "read-image" 同 slug），
    // 并发共享根会让 findSessionFile 错捡别的用例的 session
    const dirName = `${String(index).padStart(3, '0')}-${slugify(evalCase.name)}`
    const workspace = join(workspaceBase, dirName)
    await mkdir(workspace, { recursive: true })

    /** 单次 attempt 的主体（mock 为 null 走真实 API 路径）；失败/错误（含超时）返回非 pass 状态，由外层决定是否重跑 */
    const runAttemptInner = async (
      attemptIndex: number,
      mock: { server: MockServer; api: MockApi } | null,
    ): Promise<Omit<AttemptResult, 'index'>> => {
      // 每次 attempt 前清空重建 workspace：上一次 attempt 的 fs 副作用（agent 落的
      // 文件、缓存）会让重跑假通过。session 根与 overlay 也按 attempt 独立——不再靠
      // wall-clock 时间窗隔离不同 attempt 的 trace（被 kill 的进程延迟落盘可能越过
      // 时间窗边界）；sinceMs 保留为第二道防线，但隔离不再依赖它
      await rm(workspace, { recursive: true, force: true })
      await mkdir(workspace, { recursive: true })
      const sessionRoot = join(sessionBase, dirName, `attempt-${String(attemptIndex)}`)
      const overlayPath = join(outputDir, `eval-overlay-${dirName}-a${String(attemptIndex)}.patch.yml`)
      await mkdir(sessionRoot, { recursive: true })
      await writeFile(overlayPath, buildOverlayYaml(sessionRoot))
      const startedAt = Date.now()
      const base: Omit<AttemptResult, 'index' | 'status' | 'durationMs'> = {
        failures: [],
        toolsCalled: [],
        toolCalls: [],
        toolResults: [],
        finalText: '',
        steps: 0,
        tokens: emptyTokenUsage(),
        toolErrors: [],
        events: 0,
        skippedLines: 0,
      }
      try {
        // mock 模式：per-attempt 生成隔离 DSH_HOME（settings + profile patch 指向
        // ephemeral mock），子进程 env 覆盖 DSH_HOME / 凭据并清代理
        let childEnv: NodeJS.ProcessEnv | undefined
        if (mock) {
          const mockHome = join(outputDir, '.mock-home', dirName, `attempt-${String(attemptIndex)}`)
          await writeMockHome(mockHome, profile, `${mock.server.baseUrl}/v1`, mock.api)
          childEnv = buildMockEnv(mockHome)
          // mock.plugins：写完 home、起子进程前，逐 spec 用 dsh 安装器把被测插件
          // 装进 profile。spike 实测（dsh 0.1.7-rc.2）：安装器只做 profile 目录内的
          // pnpm add，不要求 settings.yaml import / 首次初始化完成——「安装在 import
          // 之前」可行且即本实现所选顺序（import 由随后的子进程首次启动完成）。
          // 失败 throw → 本 attempt 记 error（含 spec 与安装器输出尾部），run 不中断
          for (const spec of evalCase.mock?.plugins ?? []) {
            await installMockPlugin(dsh, profile, spec, workspace, timeoutMs, childEnv)
          }
        }
        const proc = await runOne(dsh.bin, [...dsh.prefixArgs, ...buildDshArgs(profile, overlayPath, evalCase.prompt)], workspace, timeoutMs, childEnv)
        const procFields = processFields(proc)
        if (proc.timedOut) {
          const partial = await tryCollectTrace(sessionRoot, startedAt)
          return {
            ...base,
            ...(partial ? traceFields(partial) : {}),
            ...procFields,
            status: 'error',
            error: `dsh subprocess timed out after ${timeoutMs}ms`,
            durationMs: Date.now() - startedAt,
          }
        }
        const sessionFile = await findSessionFile(sessionRoot, startedAt)
        if (!sessionFile) {
          const detail = proc.code !== 0 ? ` (${processExitError(proc)})` : ''
          return {
            ...base,
            ...procFields,
            status: 'error',
            error: `no session log (session[.vN].jsonl[.zstd]) found under '${sessionRoot}'${detail}`,
            durationMs: Date.now() - startedAt,
          }
        }
        const trace = await collectFromFile(sessionFile)
        // 非零退出仅在「用例没有把它声明为预期」（assert.exit_code）时才是 error；
        // 声明了（chaos 用例钉 exit 1）则落到断言层比对
        if (proc.code !== 0 && evalCase.assert.exit_code !== proc.code) {
          return {
            ...base,
            ...traceFields(trace),
            ...procFields,
            status: 'error',
            error: processExitError(proc),
            durationMs: Date.now() - startedAt,
          }
        }
        const failures = checkAssertions(evalCase.assert, trace, { exitCode: proc.code })
        // judge 兜语义：仅当结构性断言全过且用例带 output_judge 才调——
        // 结构已失败的 attempt 重跑也过不了，不白烧 judge token
        if (failures.length === 0 && evalCase.assert.output_judge !== undefined) {
          try {
            const verdict = await judgeFn({ rubric: evalCase.assert.output_judge.rubric, output: trace.finalText })
            if (!verdict.pass) {
              failures.push(`output_judge: ${verdict.reason}`)
            }
            // 判 PASS 时理由丢弃：report 不新增字段，pass 用例不留 judge 痕迹
          } catch (err) {
            // infra 抖动（HTTP 错误/超时/解析失败/无 key）记 error 而非 fail，
            // 可被 retries 覆盖——不应被记成断言失败
            return {
              ...base,
              ...traceFields(trace),
              ...procFields,
              status: 'error',
              error: `${PREFIX}: output_judge: judge call failed: ${(err as Error).message}`,
              failures: [],
              durationMs: Date.now() - startedAt,
            }
          }
        }
        return {
          ...base,
          ...traceFields(trace),
          ...procFields,
          status: failures.length === 0 ? 'pass' : 'fail',
          failures,
          durationMs: Date.now() - startedAt,
        }
      } catch (err) {
        return { ...base, status: 'error', error: (err as Error).message, durationMs: Date.now() - startedAt }
      }
    }

    /**
     * 单次 attempt 入口：mock 用例在此起 per-attempt ephemeral mock server（port 0），
     * try/finally 保证异常路径也回收端口；送达证明摘要（每 LLM 请求一条）附进
     * attempt 结果——空数组本身是信号：dsh 根本没打到 mock。
     */
    const runAttempt = async (attemptIndex: number): Promise<Omit<AttemptResult, 'index'>> => {
      const mockConf = evalCase.mock
      if (mockConf === undefined) return runAttemptInner(attemptIndex, null)
      // once 语义下持久默认保持健康 F0（横评矩阵同构：server 起在 F0，故障经控制面
      // 一次性武装）——否则 once 消耗完后落回故障默认，重试仍被注入
      const server = await startMockServer({ fault: mockConf.once === true ? 'F0' : mockConf.fault ?? 'F0', port: 0 })
      try {
        if (mockConf.once === true) {
          // 仅首个 LLM 请求命中，此后控制面回 F0——dsh 的断流重试走健康流（F1-F3 静默自愈）
          const control = await fetch(`${server.baseUrl}/__control`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ fault: mockConf.fault ?? 'F0', once: true }),
          })
          if (!control.ok) throw new Error(`${PREFIX}: failed to arm once fault '${String(mockConf.fault)}' on mock server`)
        }
        const result = await runAttemptInner(attemptIndex, { server, api: mockConf.api ?? 'openai-completions' })
        const mockDelivery: MockDeliverySummary[] = server.requests.map((r) => ({
          port: server.port,
          endpoint: r.endpoint,
          fault: r.fault,
          stream: r.stream,
          bytesSent: r.bytesSent,
          eventsCount: r.eventsCount,
          witnesses: r.witnesses,
          ending: r.ending,
        }))
        return { ...result, mockDelivery }
      } finally {
        await server.close()
      }
    }

    // flaky 治理：失败才重跑（不是固定跑 k 次）——任一 attempt 断言全过即停，
    // 最终状态取最后一次 attempt；trace 字段随 result 天然只保留最后一次。
    // trials > 1 时进入可靠性测量模式：跑满 n 次独立 attempt（每次前清空 workspace），
    // 忽略 retries——测量必须是没有重试干预的原始单次成功率
    const retries = evalCase.retries ?? retriesDefault
    const trials = evalCase.trials ?? trialsDefault
    const totalStartedAt = Date.now()
    const attemptResults: AttemptResult[] = []
    let result = await runAttempt(1)
    attemptResults.push({ ...result, index: 1 })
    if (trials > 1) {
      while (attemptResults.length < trials) {
        result = await runAttempt(attemptResults.length + 1)
        attemptResults.push({ ...result, index: attemptResults.length + 1 })
      }
      // 可靠性模式的状态语义与 retries 对齐：任一 trial 通过即 pass；
      // 全未过时报最后一次 attempt 的状态（fail / error）
      const passes = attemptResults.filter((a) => a.status === 'pass').length
      if (passes > 0) {
        result = { ...result, status: 'pass', failures: [] }
        delete result.error
      }
      return {
        name: evalCase.name,
        ...result,
        attempts: attemptResults.length,
        attemptResults,
        flaky: attemptResults.some((a) => a.status !== 'pass') && passes > 0 ? true : undefined,
        reliability: buildReliability(attemptResults, passK),
        durationMs: Date.now() - totalStartedAt,
      }
    }
    while (result.status !== 'pass' && attemptResults.length <= retries) {
      result = await runAttempt(attemptResults.length + 1)
      attemptResults.push({ ...result, index: attemptResults.length + 1 })
    }
    return {
      name: evalCase.name,
      ...result,
      attempts: attemptResults.length,
      attemptResults,
      flaky: result.status === 'pass' && attemptResults.length > 1 ? true : undefined,
      // 耗时按全 attempt 计：flaky 用例重跑的成本（token / 时长）应对读者可见，
      // 而不是只看最后一次 attempt
      durationMs: Date.now() - totalStartedAt,
    }
  }

  // worker 池：保序写回 results，report 里用例顺序与 cases 目录文件序一致
  const results: (CaseResult | undefined)[] = new Array(cases.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < cases.length) {
      const i = next++
      const item = cases[i]
      if (!item) break
      results[i] = await runCase(item.evalCase, item.loadIndex)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()))

  const runFinishedAtMs = Date.now()
  const report: RunReport = {
    schemaVersion: CURRENT_REPORT_SCHEMA_VERSION,
    tool: 'dsh-eval-harness',
    version: harnessVersion,
    startedAt: runStartedAt,
    finishedAt: new Date(runFinishedAtMs).toISOString(),
    durationMs: runFinishedAtMs - runStartedAtMs,
    profile,
    ...(dsh.version === undefined ? {} : { dshVersion: dsh.version }),
    cases: results as CaseResult[],
    summary: summarize(results as CaseResult[]),
  }
  await writeFile(join(outputDir, 'report.json'), `${renderJson(report)}\n`)
  await writeFile(join(outputDir, 'report.md'), renderMarkdown(report))
  return report
}
