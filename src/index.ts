import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { computeGate, loadReport, renderGateJson, renderGateText } from './gate.js'
import { runEval } from './runner.js'

export const name = 'dsh-eval-harness'
export const inject = ['tools']

const renderJsonText = (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: String(value) }]

export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'eval_run',
      description:
        'Run DSH plugin regression eval cases: load yaml cases from cases_dir, drive real headless dsh agent sessions (isolated session_root/workspace), collect session traces (session.jsonl or default session.jsonl.zstd, read directly), run assertions, and write report.json + report.md to output_dir. Timed-out cases still get their partial trace collected when available. Output is a JSON text summary.',
      parameters: {
        cases_dir: {
          type: 'string',
          required: true,
          description: 'Directory containing *.yml / *.yaml eval case files.',
        },
        output_dir: {
          type: 'string',
          required: true,
          description: 'Directory where report.json and report.md are written.',
        },
        session_root: {
          type: 'string',
          description: 'Isolated session root for the eval runs (default: <output_dir>/.sessions).',
        },
        profile: {
          type: 'string',
          default: 'headless',
          description: "dsh profile used to run cases (default 'headless').",
        },
        timeout_ms: {
          type: 'integer',
          default: 600000,
          description: 'Per-case subprocess timeout in milliseconds (default 600000).',
        },
        dsh_bin: {
          type: 'string',
          description:
            "dsh executable command, split on whitespace (default: env DSH_BIN or 'dsh' from PATH). Use 'npx -y @deepseek-ai/dsh' when dsh is not installed globally.",
        },
        concurrency: {
          type: 'integer',
          default: 1,
          description: 'How many cases run in parallel (default 1, serial). Each case gets its own session root and workspace, so parallel runs are isolated.',
        },
        tags: {
          type: 'string',
          description: 'Comma-separated tag filter: only run cases whose yaml tags field contains at least one of these.',
        },
        only: {
          type: 'string',
          description: 'Comma-separated case names: only run these cases (exact match). Combined with tags as an intersection.',
        },
      },
      output: { schema: { type: 'string' }, render: renderJsonText },
      execute: async (args) => {
        const splitCsv = (v: unknown): string[] | undefined =>
          v === undefined ? undefined : String(v).split(',').map((s) => s.trim()).filter((s) => s !== '')
        const report = await runEval({
          casesDir: String(args.cases_dir),
          outputDir: String(args.output_dir),
          sessionRoot: args.session_root === undefined ? undefined : String(args.session_root),
          profile: args.profile === undefined ? undefined : String(args.profile),
          timeoutMs: typeof args.timeout_ms === 'number' ? args.timeout_ms : undefined,
          dshBin: args.dsh_bin === undefined ? undefined : String(args.dsh_bin),
          concurrency: typeof args.concurrency === 'number' ? args.concurrency : undefined,
          tags: splitCsv(args.tags),
          only: splitCsv(args.only),
        })
        return JSON.stringify({
          summary: report.summary,
          report_json: `${String(args.output_dir)}/report.json`,
          report_md: `${String(args.output_dir)}/report.md`,
          cases: report.cases.map((c) => ({ name: c.name, status: c.status, failures: c.failures, error: c.error })),
        })
      },
      // 评测要真实跑 agent 会话，预算放宽到 1 小时（逐条 timeout_ms 另有子进程上限）
      timeoutMs: 3_600_000,
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'eval_gate',
      description:
        'Compare an eval report against a baseline report and emit a CI gate verdict. OVERALL=PASS|WARN|FAIL|N/A; exit code semantics: PASS=0, FAIL=1, N/A=2, WARN=0 (2 in strict mode). Set gate_json=true for a single JSON object output. Omit before (or point it at a missing file) for N/A.',
      parameters: {
        before: {
          type: 'string',
          description: 'Path to the baseline report.json. Omit or point at a missing file for N/A.',
        },
        after: {
          type: 'string',
          required: true,
          description: 'Path to the current report.json.',
        },
        strict: {
          type: 'boolean',
          default: false,
          description: 'Strict mode: WARN exit code becomes 2 instead of 0.',
        },
        gate_json: {
          type: 'boolean',
          default: false,
          description: 'Output a single JSON object instead of key=value text lines.',
        },
        max_token_increase_pct: {
          type: 'integer',
          default: 50,
          description: 'Token total (input+output+reasoning) increase threshold in percent: an unchanged-status case exceeding it counts as a token regression (WARN). Default 50; 0 disables.',
        },
      },
      output: { schema: { type: 'string' }, render: renderJsonText },
      execute: async (args) => {
        const after = await loadReport(String(args.after))
        const before = args.before === undefined ? null : await loadReport(String(args.before), true)
        const report = computeGate(before, after!, args.strict === true, {
          maxTokenIncreasePct: typeof args.max_token_increase_pct === 'number' ? args.max_token_increase_pct : undefined,
        })
        return args.gate_json === true ? renderGateJson(report) : renderGateText(report)
      },
      timeoutMs: 30_000,
    }),
  )
}
