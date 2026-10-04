import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAnchorPrompt,
  buildFiller,
  buildNeedle,
  buildTpsPrompt,
  fitDecay,
  type TpsMeasurement,
  measureRequest,
  median,
  parseTpsConfig,
  renderTpsMarkdown,
  runTpsEval,
} from '../src/tps.ts'

/** 合法的最小配置文本（按需覆盖字段） */
const configYaml = (overrides = ''): string => `
models:
  - name: ds-chat
    base_url: https://api.example.com/v1/
    api_key_env: TPS_TEST_KEY
    model: deepseek-chat
  - name: gpt-x
    base_url: https://api2.example.com
    model: gpt-x
steps: [8000, 16000, 32000]
repeats: 2
budget_tokens: 500000
${overrides}
`

describe('parseTpsConfig', () => {
  it('parses a valid config and strips trailing slashes from base_url', () => {
    const cfg = parseTpsConfig(configYaml())
    expect(cfg.models).toHaveLength(2)
    expect(cfg.models[0]).toEqual({
      name: 'ds-chat',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'TPS_TEST_KEY',
      model: 'deepseek-chat',
    })
    // api_key_env 缺省回落 DEEPSEEK_API_KEY（与 judge 同口径）
    expect(cfg.models[1].apiKeyEnv).toBe('DEEPSEEK_API_KEY')
    expect(cfg.steps).toEqual([8000, 16000, 32000])
    expect(cfg.repeats).toBe(2)
    expect(cfg.maxOutputTokens).toBe(512)
    expect(cfg.temperature).toBe(0)
    expect(cfg.anchors).toBe(false)
    expect(cfg.cacheBust).toBe(true)
    expect(cfg.budgetTokens).toBe(500000)
    expect(cfg.requestTimeoutMs).toBe(300000)
  })

  it('rejects missing budget_tokens —— 预算前置声明是硬约束', () => {
    const src = configYaml().replace('budget_tokens: 500000', '')
    expect(() => parseTpsConfig(src)).toThrow(/eval_tps_run:.*budget_tokens 必填/)
  })

  it('rejects empty models, duplicate names, non-ascending steps and bad yaml', () => {
    expect(() => parseTpsConfig('models: []\nsteps: [8000]\nbudget_tokens: 1000')).toThrow(/models 必须是非空序列/)
    expect(() =>
      parseTpsConfig(configYaml().replace('- name: gpt-x', '- name: ds-chat')),
    ).toThrow(/name 重复/)
    expect(() => parseTpsConfig(configYaml().replace('steps: [8000, 16000, 32000]', 'steps: [16000, 8000]'))).toThrow(/严格升序/)
    expect(() => parseTpsConfig(configYaml().replace('steps: [8000, 16000, 32000]', 'steps: [8000, 8000]'))).toThrow(/重复值/)
    expect(() => parseTpsConfig('models: [unclosed')).toThrow(/eval_tps_run: config 解析失败/)
    expect(() => parseTpsConfig('- just\n- a\n- sequence')).toThrow(/顶层必须是 map/)
  })

  it('rejects out-of-range repeats / max_output_tokens / temperature', () => {
    expect(() => parseTpsConfig(configYaml().replace('repeats: 2', 'repeats: 0'))).toThrow(/repeats 必须是正整数/)
    expect(() => parseTpsConfig(configYaml('max_output_tokens: 8'))).toThrow(/max_output_tokens 必须是 >= 64/)
    expect(() => parseTpsConfig(configYaml('temperature: 3'))).toThrow(/temperature 必须在/)
  })
})

describe('buildFiller / prompt 构造', () => {
  it('grows monotonically with the target and is deterministic', () => {
    const small = buildFiller(2000)
    const large = buildFiller(8000)
    expect(large.length).toBeGreaterThan(small.length)
    expect(buildFiller(8000)).toBe(large)
    // 台阶目标 8000 token × 3.5 字符 ≈ 28000 字符量级（段落边界截断，宁少不多）
    expect(large.length).toBeGreaterThan(20000)
    expect(large.length).toBeLessThanOrEqual(8000 * 3.5 + 500)
  })

  it('inserts the needle near the front (~10% depth)', () => {
    const needle = buildNeedle('falcon')
    const filler = buildFiller(8000, needle)
    const pos = filler.indexOf(needle)
    expect(pos).toBeGreaterThanOrEqual(0)
    expect(pos / filler.length).toBeLessThan(0.2)
    expect(needle).toContain('"falcon"')
  })

  it('cache_bust 前缀让两次 prompt 不同；关闭后完全一致', () => {
    const filler = buildFiller(2000)
    expect(buildTpsPrompt(filler, 512, true)).not.toBe(buildTpsPrompt(filler, 512, true))
    expect(buildTpsPrompt(filler, 512, false)).toBe(buildTpsPrompt(filler, 512, false))
    expect(buildTpsPrompt(filler, 512, false)).toContain('"ok" repeated 512 times')
    expect(buildAnchorPrompt(filler, false)).toContain('code word')
  })
})

describe('median', () => {
  it('handles odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1])).toBe(2.5)
    expect(median([])).toBeNull()
  })
})

describe('fitDecay', () => {
  it('recovers a/b from synthetic 1/(a+b·n) data and derives the half-speed point', () => {
    // a=0.005（基准 200 tok/s），b=7.5e-8 → n½ = a/b ≈ 66667
    const points = [8000, 32000, 64000, 128000, 256000].map((n) => ({ n, tps: 1 / (0.005 + 7.5e-8 * n) }))
    const fit = fitDecay(points, 'usage')
    if (fit === null) throw new Error('fit should exist')
    expect(fit.a).toBeCloseTo(0.005, 4)
    expect(fit.b).toBeCloseTo(7.5e-8, 10)
    expect(fit.baselineTps).toBeCloseTo(200, 0)
    expect(fit.halfSpeedContext).toBeCloseTo(66667, -2)
    expect(fit.r2).toBeGreaterThan(0.999)
    expect(fit.note).toBeNull()
    expect(fit.points).toBe(5)
    expect(fit.source).toBe('usage')
  })

  it('flags a kinked curve with a residual note instead of trusting the fit', () => {
    // 前段贴合 1/(a+bn)，64k 后撞限速平台（tps 不再降）——线性化 R² 应掉下来并给出提示
    const points = [8000, 32000, 64000, 128000, 256000].map((n) => ({
      n,
      tps: Math.max(1 / (0.005 + 7.5e-8 * n), 1 / 0.0098),
    }))
    const fit = fitDecay(points, 'usage')
    if (fit === null) throw new Error('fit should exist')
    expect(fit.r2).toBeLessThan(0.9)
    expect(fit.note).toContain('残差偏大')
  })

  it('returns null for fewer than 3 points and for physically meaningless fits', () => {
    expect(fitDecay([{ n: 8000, tps: 100 }, { n: 16000, tps: 90 }], 'usage')).toBeNull()
    // 速度随长度上升 → b<0：半速点 null + 「未观测到衰减」提示（阳性对照模型出这结果要先怀疑测量通道）
    const rising = fitDecay([{ n: 8000, tps: 10 }, { n: 16000, tps: 500 }, { n: 32000, tps: 2000 }], 'usage')
    if (rising === null) throw new Error('rising fit should exist')
    expect(rising.b).toBe(0)
    expect(rising.halfSpeedContext).toBeNull()
    expect(rising.note).toContain('未观测到衰减')
    // 无衰减：b=0 → 半速点 null
    const flat = fitDecay([{ n: 8000, tps: 100 }, { n: 16000, tps: 100 }, { n: 32000, tps: 100 }], 'usage')
    if (flat === null) throw new Error('flat fit should exist')
    expect(flat.halfSpeedContext).toBeNull()
  })
})

/** 构造 SSE 流 Response：每条事件一行 data:，可附带 usage 终止块 */
const sseResponse = (events: unknown[], status = 200): Response => {
  const lines = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
  return new Response(`${lines}data: [DONE]\n\n`, { status, headers: { 'content-type': 'text/event-stream' } })
}

const contentChunk = (text: string): unknown => ({ choices: [{ delta: { content: text }, finish_reason: null }] })

describe('measureRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('measures ttft/decode/instantTps from scripted chunk times and passes usage through raw', async () => {
    // 假时钟：脚本化 now() 序列——t0=0，之后每个 chunk 按 100ms 间隔到达
    let t = 0
    const now = (): number => {
      const v = t
      t += 100
      return v
    }
    const usage = { prompt_tokens: 32100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 10 } }
    const events = [contentChunk('ok'), contentChunk(' ok'), contentChunk(' ok'), contentChunk(' ok'), { choices: [], usage }]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)))

    const m = await measureRequest({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'm',
      prompt: 'p'.repeat(1000),
      maxTokens: 64,
      temperature: 0,
      timeoutMs: 30000,
      now,
    })
    expect(m.error).toBeNull()
    expect(m.promptTokens).toBe(32100)
    expect(m.completionTokens).toBe(50)
    expect(m.reasoningTokens).toBe(10)
    expect(m.estimatedTokens).toBe(false)
    expect(m.usage).toEqual(usage)
    expect(m.ttftMs).toBe(100)
    expect(m.ttftContentMs).toBe(100)
    // decode 窗口 = 首 chunk(100ms) → 末 chunk(400ms) = 300ms；50 tokens / 0.3s ≈ 166.67
    expect(m.decodeMs).toBe(300)
    expect(m.instantTps).toBeCloseTo(166.67, 1)
    expect(m.chunks).toHaveLength(4)
    expect(m.answer).toContain('ok')
  })

  it('falls back to char-estimated tokens (estimatedTokens=true) when usage is missing', async () => {
    let t = 0
    const now = (): number => {
      const v = t
      t += 50
      return v
    }
    const events = [contentChunk('ok'), contentChunk('ok'), contentChunk('ok')]
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)))
    const m = await measureRequest({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'm',
      prompt: 'p'.repeat(3500),
      maxTokens: 64,
      temperature: 0,
      timeoutMs: 30000,
      now,
    })
    expect(m.error).toBeNull()
    expect(m.estimatedTokens).toBe(true)
    expect(m.promptTokens).toBe(1000) // 3500 字符 / 3.5
    expect(m.completionTokens).toBe(2) // 6 字符 / 4 → 1.5 → round 2
    expect(m.instantTps).not.toBeNull()
  })

  it('records HTTP errors as sample-level error instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))
    const m = await measureRequest({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'm',
      prompt: 'p',
      maxTokens: 64,
      temperature: 0,
      timeoutMs: 30000,
    })
    expect(m.error).toContain('HTTP 429')
    expect(m.instantTps).toBeNull()
  })

  it('records network/timeout failures as sample-level error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('socket hang up')
      }),
    )
    const m = await measureRequest({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'm',
      prompt: 'p',
      maxTokens: 64,
      temperature: 0,
      timeoutMs: 30000,
    })
    expect(m.error).toContain('socket hang up')
  })

  it('marks instantTps null when the decode window has fewer than 3 chunks', async () => {
    let t = 0
    const now = (): number => {
      const v = t
      t += 100
      return v
    }
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([contentChunk('ok ok')])) )
    const m = await measureRequest({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'm',
      prompt: 'p',
      maxTokens: 64,
      temperature: 0,
      timeoutMs: 30000,
      now,
    })
    expect(m.error).toBeNull()
    expect(m.instantTps).toBeNull()
    expect(m.ttftMs).not.toBeNull()
  })
})

describe('runTpsEval', () => {
  let dir: string
  afterEach(async () => {
    vi.unstubAllEnvs()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  })

  const setup = async (cfg: string): Promise<{ configPath: string; outputDir: string }> => {
    dir = await mkdtemp(join(tmpdir(), 'tps-spec-'))
    const configPath = join(dir, 'tps.yml')
    await writeFile(configPath, cfg, 'utf8')
    return { configPath, outputDir: join(dir, 'out') }
  }

  it('dry_run 只出计划：不发请求、不写文件', async () => {
    vi.stubEnv('TPS_TEST_KEY', 'x')
    vi.stubEnv('DEEPSEEK_API_KEY', 'x')
    const { configPath, outputDir } = await setup(configYaml())
    let called = 0
    const result = await runTpsEval({
      configPath,
      outputDir,
      dryRun: true,
      measure: (async () => {
        called++
        throw new Error('should not be called')
      }) as typeof measureRequest,
    })
    expect(called).toBe(0)
    expect(result.report).toBeNull()
    // 2 模型 × 3 台阶 × 2 repeats，anchors off
    expect(result.requestCount).toBe(12)
    expect(result.plannedTokens).toBeGreaterThan(0)
    await expect(readFile(result.reportJsonPath, 'utf8')).rejects.toThrow()
  })

  it('计划估算超 budget_tokens 直接拒跑（不发任何请求）', async () => {
    vi.stubEnv('TPS_TEST_KEY', 'x')
    vi.stubEnv('DEEPSEEK_API_KEY', 'x')
    const { configPath, outputDir } = await setup(configYaml().replace('budget_tokens: 500000', 'budget_tokens: 100'))
    let called = 0
    await expect(
      runTpsEval({
        configPath,
        outputDir,
        measure: (async () => {
          called++
          throw new Error('should not be called')
        }) as typeof measureRequest,
      }),
    ).rejects.toThrow(/超出 budget_tokens/)
    expect(called).toBe(0)
  })

  it('缺 API key 启动即死，不发出请求', async () => {
    vi.stubEnv('TPS_TEST_KEY', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    const { configPath, outputDir } = await setup(configYaml())
    await expect(runTpsEval({ configPath, outputDir })).rejects.toThrow(/TPS_TEST_KEY 未设置/)
  })

  it('完整跑通：聚合中位数、拟合半速点、写 json/md 报告', async () => {
    vi.stubEnv('TPS_TEST_KEY', 'x')
    vi.stubEnv('DEEPSEEK_API_KEY', 'x')
    const cfg = configYaml().replace('repeats: 2', 'repeats: 1')
    const { configPath, outputDir } = await setup(cfg)
    // ds-chat 随台阶衰减（陡），gpt-x 全程 100（平）
    const result = await runTpsEval({
      configPath,
      outputDir,
      measure: (async (opts: { model: string; prompt: string; maxTokens: number }) => {
        // 由 prompt 长度反推名义台阶（填料 ≈ step×3.5 字符）
        const approxStep = Math.round(opts.prompt.length / 3.5 / 8000) * 8000
        const tps = opts.model === 'deepseek-chat' ? 1 / (0.005 + 7.5e-8 * approxStep) : 100
        const m: TpsMeasurement = {
          promptTokens: approxStep,
          completionTokens: opts.maxTokens,
          reasoningTokens: null,
          estimatedTokens: false,
          ttftMs: 500,
          ttftContentMs: 500,
          decodeMs: (opts.maxTokens / tps) * 1000,
          instantTps: tps,
          finishReason: 'length',
          outputChars: opts.maxTokens * 3,
          usage: { prompt_tokens: approxStep, completion_tokens: opts.maxTokens },
          chunks: [[0, 3]],
          answer: 'ok ok ok',
          error: null,
        }
        return m
      }) as typeof measureRequest,
    })
    const report = result.report
    if (report === null) throw new Error('report should exist')
    expect(report.schemaVersion).toBe(1)
    expect(report.kind).toBe('tps-report')
    expect(report.models).toHaveLength(2)
    const ds = report.models[0]
    expect(ds.steps).toHaveLength(3)
    expect(ds.fit).not.toBeNull()
    expect(ds.fit?.b).toBeGreaterThan(0)
    expect(ds.fit?.halfSpeedContext).not.toBeNull()
    const gpt = report.models[1]
    expect(gpt.fit?.halfSpeedContext).toBeNull() // 平曲线：未观测到衰减
    expect(report.budget.truncated).toBe(false)
    expect(report.budget.actualUsed).toBeGreaterThan(0)

    const json = JSON.parse(await readFile(result.reportJsonPath, 'utf8')) as { kind: string }
    expect(json.kind).toBe('tps-report')
    const md = await readFile(result.reportMdPath, 'utf8')
    expect(md).toContain('口径警示')
    expect(md).toContain('横评汇总')
    expect(md).toContain('半速点')
  })

  it('only 筛选无命中直接报错', async () => {
    vi.stubEnv('TPS_TEST_KEY', 'x')
    const { configPath, outputDir } = await setup(configYaml())
    await expect(runTpsEval({ configPath, outputDir, only: ['nope'] })).rejects.toThrow(/only 筛选后无命中模型/)
  })
})

describe('renderTpsMarkdown', () => {
  it('renders the deployment-caveat and the comparison table', () => {
    const report = {
      schemaVersion: 1 as const,
      kind: 'tps-report' as const,
      startedAt: '2026-10-04T00:00:00Z',
      finishedAt: '2026-10-04T00:10:00Z',
      durationMs: 600000,
      config: {
        steps: [8000, 16000],
        repeats: 3,
        maxOutputTokens: 512,
        temperature: 0,
        anchors: false,
        cacheBust: true,
        budgetTokens: 1000000,
        requestTimeoutMs: 300000,
      },
      models: [
        {
          name: 'm1',
          model: 'm1',
          baseUrl: 'https://api.example.com',
          steps: [
            {
              nominal: 8000,
              samples: [],
              medianPromptTokens: 8100,
              medianInstantTps: 190.5,
              medianTtftMs: 800,
              anchorHitRate: null,
            },
          ],
          fit: {
            a: 0.005,
            b: 7.5e-8,
            baselineTps: 200,
            halfSpeedContext: 66667,
            r2: 0.99,
            points: 6,
            source: 'usage' as const,
            note: null,
          },
          fitNote: null,
        },
      ],
      budget: { declared: 1000000, planned: 100000, actualUsed: 90000, truncated: false },
    }
    const md = renderTpsMarkdown(report)
    expect(md).toContain('部署结论，不是架构结论')
    expect(md).toContain('| m1 | 200 | 7.5e-8 | 66667 | 0.99 |')
    expect(md).toContain('阳性对照')
  })
})
