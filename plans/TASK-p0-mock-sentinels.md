# TASK-p0-mock-sentinels：mock 哨兵 S1/S2 + calibration 段 + 离线 chaos CI

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-mock-sentinels.prompt.md
> 创建：2026-10-30 ｜ 状态：pending（待 Owner 确认）｜ 依赖：TASK-p0-evidence-floor（E3 送达对账）、TASK-p0-probe-agents（`src/strength.ts`、`tests/probes/fake-dsh.mjs`），两者须已合入 main ｜ 批次：P0-2（与 TASK-p0-case-hardening 并行）

## 目标

给 mock 类评测加一个 run 级健康位：每次含 mock 用例的 run 都内嵌一个必过哨兵（S1）和一个必不过哨兵（S2），任何一个不符合预期，门禁就阻断。同时把 `cases/chaos` 放进 CI 离线常跑。

## 背景（证据已落盘）

设计依据：`docs/EVAL-HARDENING-DESIGN.md` §5（哨兵设计）、§2.6。该文档待 Owner 合入；本契约已摘录本任务需要的全部事实，并修正了 §5.2 中 S2 示例漏写 `exit_code` 的问题（见下文）。

- 仪表故障（宿主版本与 mock home 结构漂移、overlay 失效、collector 退化、dsh 没打到 mock）目前与被测故障无法区分。
- mock home 结构锚定 dsh 0.1.7-rc.2（`src/runner.ts:311`、`:337`）；CI 只安装 0.1.1-rc.2，且只跑 `cases/real`（`.github/workflows/eval.yml:84`、`:93`）。chaos 包从未进过 CI。
- npm 上可以安装 `@deepseek-ai/dsh@0.1.7-rc.2`（2026-10-30 `npm view` 核实）；latest 已到 0.2.1-rc.5，mock home 结构对 0.2.x 未验证。

## 需求规格（Planner 建议，待 Owner 拍板）

- 哨兵就是普通用例 yaml 加一个顶层键 `sentinel`（取值 `must-pass` / `must-fail`），放在随包分发的 `cases/_sentinels/`。`loadCases` 不递归读子目录，不会把它们误当成用例。
- P0 的注入规则：本次（筛选后）用例集中含 ≥1 条 mock 用例时，注入 S1、S2；不含 mock 用例的 run（如 `cases/real`）不注入。真实 API 哨兵与"总是注入"属于 P1。
- 哨兵不受 `tags` / `only` 筛选，不进 `cases[]` 和 `summary`。结果写入报告的可选字段 `calibration`（schema 仍为 1）：
  `{ sentinels: [{ name, kind, expected, status, error?, ok }], healthy, skipped?, weakCases: [{ name, reason }] }`
  - must-pass 要求 status=pass；must-fail 要求 status=fail（error 也算"破"）；
  - `weakCases` 用 `assessAssertionStrength` 对本次的 subject 用例计算，只告警。
- `RunOptions.sentinels?: boolean`：缺省 true，不进工具参数。为 false 且用例集含 mock 用例时，记 `{ skipped: true, healthy: false }`。
- gate：after 报告带 `calibration` 且 `healthy === false` → FAIL（exit 1），reason 为 `sentinel breach: <name> expected <kind> got <status>` 或 `sentinels skipped`；文本输出新增一行 `SENTINELS=ok|breach|skipped|absent`。P1 再把这里改为 INVALID。
- P0 不做 fail-fast：S1 破了也照常跑完主体用例。

哨兵内容：

```yaml
# cases/_sentinels/s1-mock-echo.yml —— 必过：整条 mock 管线畅通
name: sentinel-mock-echo
sentinel: must-pass
prompt: |
  写一份三节分析报告。直接输出报告全文，不要调用任何工具。
mock:
  fault: F0
assert:
  turn_end: completed
  exit_code: 0
  output_contains: ["【P01】", "【P24】"]
```

```yaml
# cases/_sentinels/s2-mock-impossible.yml —— 必不过：F1 持续注入，P24 永远送不到（src/mock.ts:189-194 只发到 P12）
name: sentinel-mock-impossible
sentinel: must-fail
prompt: |
  写一份三节分析报告。直接输出报告全文，不要调用任何工具。
mock:
  fault: F1
assert:
  exit_code: <以 dsh 0.1.7-rc.2 实测为准>
  turn_end: completed
  output_contains: ["【P24】"]
```

**S2 必须声明 dsh 在持续 F1 下的真实退出码。** 否则非零退出会落进"未声明的非零退出 → error"分支（`src/runner.ts:911-920`），哨兵会因为 error 而被误判为"破"。先跑一次看真实退出码再写断言，不许不验证就写（与 TASK-chaos-pack 同一纪律）。设计文档 §5.2 的 S2 示例漏了这一行，以本契约为准。

- 新 workflow `.github/workflows/chaos.yml`，与 eval.yml 分开，避免与 TASK-p0-evidence-floor 的 E8 改动冲突：
  - 触发：push / PR（paths：`src/**`、`cases/chaos/**`、`cases/_sentinels/**`、该 workflow 文件）+ workflow_dispatch；
  - `npm install -g @deepseek-ai/dsh@0.1.7-rc.2`，`pnpm build`，用 `runEval` 跑 `cases/chaos`；
  - 只有 `summary.failed + summary.errored === 0` 且 `calibration.healthy === true` 才算绿；上传 report.json / report.md。
- spike 先行：npm 安装的 dsh 0.1.7-rc.2 在本机离线（无 `DEEPSEEK_API_KEY`）跑 `cases/chaos` 6/6 PASS。spike 不通就停止并上报，不在错误的地基上继续。本机用隔离前缀安装（如 `npm install --prefix /tmp/dsh-0.1.7 @deepseek-ai/dsh@0.1.7-rc.2`），不改全局 npm。

## 范围（In Scope）

新建（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：

- `cases/_sentinels/s1-mock-echo.yml`、`cases/_sentinels/s2-mock-impossible.yml`
- `src/sentinel.ts` —— 哨兵加载与期望判定
- `tests/sentinel.spec.ts`
- `.github/workflows/chaos.yml`

修改：

- `src/runner.ts` —— `parseCase` 支持新键；`runEval` 注入哨兵并组装 `calibration`
- `src/types.ts` —— `calibration` 类型
- `src/gate.ts` —— `normalizeReport` 解析 `calibration`；判定与文本输出
- `src/report.ts` —— 报告头部"仪表健康"行 + 弱用例告警段
- `tests/runner.spec.ts` —— 既有 mock 用例测试传 `sentinels: false`，语义不变
- `tests/gate.spec.ts`
- `tests/probes/fake-dsh.mjs` —— 可选：新增 relay 模式（向 mock 发流式请求，把正文写进 assistant/message），供哨兵单测使用
- `README.md` —— mock 与 chaos 小节：哨兵语义、"不得删除或筛掉"、chaos CI
- `docs/gate-signals.md` —— 新增一节"哨兵破：FAIL，不走增量"

## 非目标（Out of Scope）

- 真实 API 哨兵 S3/S4、nonce/secret 模板、eval.yml 升级 dsh、fail-fast、INVALID 判定（均为 P1）
- `cases/plugins` 的 mock chaos 进 CI（需要网络安装插件）

## DoD

1. spike：npm 版 dsh 0.1.7-rc.2 离线跑 `cases/chaos` 6/6 PASS（命令与输出）；S2 的真实退出码已实测并写入断言。
2. 本机 `runEval({ casesDir: 'cases/chaos', dshBin: <0.1.7-rc.2> })`：`calibration.healthy === true`，S1 为 pass、S2 为 fail。
3. 阳性对照（各自还原）：
   - S1 的 fault 临时改为 F1 → S1 破 → gate FAIL；
   - 用不连 mock、伪造 P24 的 fake dsh 运行 → S1、S2 因 delivery-missing 记 error → 都破。
4. 单测覆盖：注入规则（含 / 不含 mock 用例）、筛选不影响哨兵、哨兵不进 summary、`sentinels: false` → skipped、gate 对 breach 与 skipped 判 FAIL、没有 calibration 的旧报告 gate 行为不变。
5. Owner 触发一次 `chaos.yml` 的 workflow_dispatch 并通过（附 run 链接）。
6. `pnpm build` / `pnpm test` / `pnpm lint` 全绿。

验收命令（实施后可执行）：

```bash
npm install --prefix /tmp/dsh-0.1.7 @deepseek-ai/dsh@0.1.7-rc.2
pnpm build && env -u DEEPSEEK_API_KEY node --input-type=module -e "import { runEval } from './lib/runner.js'; const r = await runEval({ casesDir: 'cases/chaos', outputDir: '/tmp/p0-chaos', dshBin: '/tmp/dsh-0.1.7/node_modules/.bin/dsh' }); console.log(r.summary, JSON.stringify(r.calibration)); process.exit(r.summary.passed === r.summary.total && r.calibration.healthy ? 0 : 1)"
CI=1 pnpm exec vitest run tests/sentinel.spec.ts tests/runner.spec.ts tests/gate.spec.ts
gh workflow run chaos.yml   # Owner 执行
```

## 风险与回滚点

- 宿主版本：chaos.yml 钉 0.1.7-rc.2。dsh 已发到 0.2.x，mock home 结构对新版本未验证——升级是独立任务，本任务不碰。
- 现有 mock 单测用的 fake dsh 不会转发 mock 内容，开着哨兵会全部判"破"：统一传 `sentinels: false`，不许为了让测试通过而放宽哨兵判定。
- 哨兵也可能抖动：mock 是本地确定环境，理论上不抖。如果 CI 出现抖动，先查环境（端口、代理），不加重试。
- 回滚：`sentinels` 选项是总开关；新增文件删除即回滚。

## 参考素材（绝对路径）

- 设计文档：/Users/boyang/Desktop/dsh-eval-harness/docs/EVAL-HARDENING-DESIGN.md（§5）
- 健康流对照用例：/Users/boyang/Desktop/dsh-eval-harness/cases/chaos/chaos-f0-healthy.yml
- mock 故障动作序列：/Users/boyang/Desktop/dsh-eval-harness/src/mock.ts（F1 见 `:189-194`）
- 既有 eval workflow 写法：/Users/boyang/Desktop/dsh-eval-harness/.github/workflows/eval.yml
