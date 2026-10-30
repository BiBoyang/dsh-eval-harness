# TASK-p0-evidence-floor：证据下限——缺证据不得通过

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-evidence-floor.prompt.md
> 创建：2026-10-30 ｜ 状态：pending（待 Owner 确认）｜ 依赖：无 ｜ 批次：P0-1（与 TASK-p0-probe-agents 并行，文件零重叠）

## 目标

堵上四个"没有证据却被当成通过"的出口：E3 送达对账、E4 judge 留痕、E7 缺席即 FAIL、E8 不跑不是绿。

本任务不升 report schema：P0 里"无效"以 `error` + 原因前缀表达，三通道 schema v2 属于 P1。

## 背景（证据已落盘）

设计依据：`docs/EVAL-HARDENING-DESIGN.md` §2.7（K4、K6）、§6.2（E3、E4、E7、E8）。该文档待 Owner 合入；本契约已摘录本任务需要的全部事实。

- K4：mock 没被调用（`mockDelivery=[]`）的用例照样判 pass，`tests/runner.spec.ts:1147` 把这一行为固化成了测试。2026-10-30 的探针：一个不连 mock、直接伪造终态（turn_end=max-tokens、exit 1）的 dsh 通过了阳性对照 `cases/chaos/chaos-f5-think-only.yml`。mock 送达证明在 attempt 结束后才附加（`src/runner.ts:980-990`），不参与判分（`src/types.ts:194` 注释："信息层，v1 无对应断言"）。
- judge 判 PASS 时理由被丢弃、不留痕（`src/runner.ts:930`；`tests/runner.spec.ts:928` 固化），PASS 判定事后无法复核。
- K6：baseline 有、本次缺席的用例只给 WARN（`src/gate.ts:121-123`、`:165-179`）；eval.yml 以非 strict 调用（`.github/workflows/eval.yml:110`），WARN 的退出码为 0（`src/gate.ts:20-21`）。
- CI：未配置 `DEEPSEEK_API_KEY` 时，评测与门禁两步都跳过（`.github/workflows/eval.yml:88`、`:104`），job 显示为绿。

## 需求规格（Planner 建议，待 Owner 拍板）

| 编号 | 规则 | 现状 → 改后 |
| --- | --- | --- |
| E3 | mock 用例的 attempt 必须有送达证据：`mockDelivery` 中至少一条记录满足 `fault === 声明值（缺省 F0）` 且 `endpoint === 声明 api 对应的端点`（openai-completions→cc、openai-responses→responses、anthropic-messages→anthropic）。不满足时把该 attempt 改记为 `error`，`error` 以 `delivery-missing:` 开头并列出实收记录摘要。已经是 error 的 attempt（如安装失败）保留原错误，不覆盖 | pass / fail → error |
| E4 | judge 判 PASS 和判 FAIL 都在 attempt 上记录 `judge: { pass, reason, model, baseUrl }`。`model`、`baseUrl` 取 `src/judge.ts` 的配置解析（与 `judgeOutput` 使用同一套环境变量与缺省值）；通过 `RunOptions.judge` 注入的测试 judge 记为 `injected` | PASS 不留痕 → 留痕 |
| E7 | gate：baseline 有、本次缺席的用例判 FAIL（exit 1），reason 为 `missing case: <name> (in baseline, absent from current report)`；文本输出保留 `REMOVED=` 行 | WARN → FAIL |
| E8 | eval.yml：主仓库（BiBoyang/dsh-eval-harness）在 push、schedule、workflow_dispatch、同仓 PR 中缺 key 时 job 失败；只有 fork PR 允许跳过，并在 step summary 写 `EVAL_SKIPPED=1` | 绿 → 红（主仓库）/ 显式跳过（fork） |

E8 的建议写法（实现时对照 GitHub Actions 表达式文档核对，不凭记忆）：

```yaml
      # 证据下限：主仓库缺 key 不允许以绿灯结束；fork PR 拿不到 secrets，允许跳过但显式标记
      - name: Require eval evidence
        if: env.DEEPSEEK_API_KEY == '' && github.repository == 'BiBoyang/dsh-eval-harness' && !(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name != github.repository)
        run: |
          echo "::error::DEEPSEEK_API_KEY 未配置：评测没有运行，主仓库不允许以绿灯结束"
          exit 1
      - name: Mark skipped eval
        if: env.DEEPSEEK_API_KEY == ''
        run: echo "EVAL_SKIPPED=1" | tee -a "$GITHUB_STEP_SUMMARY"
```

## 范围（In Scope）

修改（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：

- `src/runner.ts` —— E3：在 `runAttempt`（`:963-994`）中，`runAttemptInner` 返回之后、`server.close()` 之前做送达对账；E4：在 judge 调用处（`:924-944`）附加 judge 证据
- `src/types.ts` —— `AttemptResult.judge?`（可选字段，schema 仍为 1）
- `src/judge.ts` —— 导出 judge 配置解析（例如 `judgeConfig()`），`judgeOutput` 改为复用它
- `src/gate.ts` —— E7（`:160-183` 的判定分支与 reasons）
- `src/report.ts` —— 在已有的 attempt 明细里渲染 judge 证据（一行即可）
- `tests/runner.spec.ts` —— 更新 `:1147`（改为期望 error + delivery-missing）与 `:928`（改为期望存在 judge 证据）；新增送达对账用例（F0 正常、fault 不符、端点不符、once 语义下首请求命中）与 forge-f5 用例（用不连 mock 的 fake dsh 跑真实的 `cases/chaos/chaos-f5-think-only.yml`，期望 error + delivery-missing）
- `tests/gate.spec.ts` —— 更新 `:109`（removed → FAIL / exit 1），补 reasons 断言
- `tests/judge.spec.ts` —— judge 配置解析的单测
- `.github/workflows/eval.yml` —— E8 的两个 step，放在 "Run eval cases" 之前
- `README.md` —— `output_judge` 说明（`:82-90`，改写"判 PASS 不留任何痕迹"）；gate 协议表（`:305-317`，移除用例那一行改为 FAIL）；mock 送达证明（`:139-141`，补"缺送达即 error"）
- `docs/gate-signals.md` —— 新增一节"缺席用例：FAIL"，写清取舍：缺证据不放行；删用例须同 PR 刷新 baseline，代价是纪律成本

## 非目标（Out of Scope）

- 三通道数据模型、INVALID 判定、report schema 升级（P1）
- 断言强度下限的运行期强制（P1；P0 的静态检查见 TASK-p0-probe-agents）
- `update-baseline.yml` 的缺 key 行为（手动触发，job 跳过本身可见）

## DoD

1. forge-f5 证明：用不连 mock 的 fake dsh 跑 `chaos-f5-think-only`，结果为 `error`，且 error 以 `delivery-missing:` 开头（改动前为 pass）。
2. 送达对账四态单测全部通过（F0 正常 pass、fault 不符、端点不符、once 首请求命中）；既有 mock 用例测试除 `:1147` 外语义不变。
3. judge 判 PASS 与 FAIL 都在 attempt 上留下 `judge` 证据；judge 调用失败仍记 error（`tests/runner.spec.ts:951`、`:973` 不变）。
4. gate：缺席用例 → `OVERALL=FAIL`、`EXIT_CODE=1`（单测 + 下方手工命令）。
5. eval.yml 的两个 step 就位；Owner 在 fork（无 secret）触发一次，确认评测被跳过且 step summary 中有 `EVAL_SKIPPED=1`。
6. `pnpm build` / `pnpm test` / `pnpm lint` 全绿。

验收命令（实施后可执行）：

```bash
CI=1 pnpm exec vitest run tests/runner.spec.ts tests/gate.spec.ts tests/judge.spec.ts tests/report.spec.ts
pnpm build && node --input-type=module -e "import { computeGate, loadReport } from './lib/gate.js'; const b = await loadReport('baseline/report.json'); const a = structuredClone(b); a.cases = a.cases.filter((c) => c.name !== 'todo-tool'); a.summary = { total: 11, passed: 11, failed: 0, errored: 0 }; const g = computeGate(b, a, false); console.log(g.verdict, g.exitCode); process.exit(g.verdict === 'FAIL' && g.exitCode === 1 ? 0 : 1)"
grep -n "Require eval evidence\|EVAL_SKIPPED" .github/workflows/eval.yml
```

## 风险与回滚点

- E7 改变现行协议：删用例的 PR 在评测上会 FAIL，直到 baseline 刷新。这是有意的纪律成本，文档必须写清操作路径：删用例 → 触发 update-baseline → 合入 baseline PR。
- E3 用"至少一条匹配"而不是"首条匹配"，对 dsh 可能发出的辅助请求保持宽容；`once` 语义下首个 LLM 请求即主请求，已由 chaos 包实测成立。
- E4 推翻"pass 用例不留 judge 痕迹"的既有取舍（`tests/runner.spec.ts:928` 的标题就是这句话），必须在 README 同步改口径。
- E8 的表达式写错，会让 fork PR 变红或主仓库仍然是绿的：上报时附表达式的逐项解释。
- 回滚：E3、E4、E7、E8 彼此独立（建议 Owner 按四项分开审 diff），可按文件或按 hunk revert。

## 参考素材（绝对路径）

- 设计文档：/Users/boyang/Desktop/dsh-eval-harness/docs/EVAL-HARDENING-DESIGN.md（§2.3、§2.7、§6.2、§8.3）
- 既有 mock fake dsh：/Users/boyang/Desktop/dsh-eval-harness/tests/runner.spec.ts（`writeMockFakeDsh`，`curl: false` 即"不连 mock"）
- 阳性对照用例：/Users/boyang/Desktop/dsh-eval-harness/cases/chaos/chaos-f5-think-only.yml
