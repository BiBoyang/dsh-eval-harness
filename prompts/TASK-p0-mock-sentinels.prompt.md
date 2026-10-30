---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-mock-sentinels.md
status: pending
from: Planner
to: Executor
created: 2026-10-30
---

# 任务：mock 哨兵 S1/S2 + calibration 段 + 离线 chaos CI

## 目标

每次含 mock 用例的 run 都内嵌必过哨兵 S1 与必不过哨兵 S2，结果写入报告的 `calibration` 段，任一不符合预期则 gate 判 FAIL；同时新增离线的 chaos CI workflow。成功标准：spike 通过（npm 版 dsh 0.1.7-rc.2 离线跑 chaos 6/6）；本机 chaos 运行 `calibration.healthy === true`；两项阳性对照都能变红；三件套全绿。

## 开工方式

1. 先读任务契约（注入规则、calibration 字段、两个哨兵的内容、chaos.yml 要求都在里面，是本任务的唯一事实来源）：/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-mock-sentinels.md
2. 设计背景（可选）：/Users/boyang/Desktop/dsh-eval-harness/docs/EVAL-HARDENING-DESIGN.md §5。若与契约冲突（如 S2 的 `exit_code`），以契约为准。
3. **分支要求**：从已合入 TASK-p0-evidence-floor 与 TASK-p0-probe-agents 的 `main` 新建 `feat/p0-mock-sentinels` 分支工作，不得在 main 上直接改动；完成后不提交，留给 Owner review。
4. **spike 先行**：先用隔离前缀安装 dsh 0.1.7-rc.2，离线跑通 `cases/chaos` 6/6，并实测 S2 场景（F1 持续注入）的真实退出码，再开始写代码。

## 涉及文件（绝对路径）

新建：
- /Users/boyang/Desktop/dsh-eval-harness/cases/_sentinels/s1-mock-echo.yml
- /Users/boyang/Desktop/dsh-eval-harness/cases/_sentinels/s2-mock-impossible.yml
- /Users/boyang/Desktop/dsh-eval-harness/src/sentinel.ts
- /Users/boyang/Desktop/dsh-eval-harness/tests/sentinel.spec.ts
- /Users/boyang/Desktop/dsh-eval-harness/.github/workflows/chaos.yml

修改：
- /Users/boyang/Desktop/dsh-eval-harness/src/runner.ts
- /Users/boyang/Desktop/dsh-eval-harness/src/types.ts
- /Users/boyang/Desktop/dsh-eval-harness/src/gate.ts
- /Users/boyang/Desktop/dsh-eval-harness/src/report.ts
- /Users/boyang/Desktop/dsh-eval-harness/tests/runner.spec.ts
- /Users/boyang/Desktop/dsh-eval-harness/tests/gate.spec.ts
- /Users/boyang/Desktop/dsh-eval-harness/tests/probes/fake-dsh.mjs（可选：relay 模式）
- /Users/boyang/Desktop/dsh-eval-harness/README.md
- /Users/boyang/Desktop/dsh-eval-harness/docs/gate-signals.md

协议文件（本任务自身记录）：
- /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-mock-sentinels.md（只读契约）
- /Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-mock-sentinels.status.md（过程记录，由你追加）

本机临时环境（不入 git）：
- /tmp/dsh-0.1.7/（`npm install --prefix /tmp/dsh-0.1.7 @deepseek-ai/dsh@0.1.7-rc.2`）

## 约束

- 不改全局 npm 环境；本机 dsh 只装在 `/tmp/dsh-0.1.7`。
- 不改 `.github/workflows/eval.yml`（E8 归 TASK-p0-evidence-floor；eval.yml 的 dsh 升级属 P1）。
- S2 的 `exit_code` 必须以实测为准；不许为了让哨兵通过而放宽 must-fail 的判定（error 也算破）。
- 既有 mock 单测统一传 `sentinels: false`，语义不变。
- 不做 fail-fast、不做真实 API 哨兵、不引入 INVALID 判定（均为 P1）。

## 验收标准（DoD）

见契约六条：spike 与 S2 退出码实测 / 本机 chaos 运行 healthy / 两项阳性对照 / 单测覆盖 / chaos.yml（Owner dispatch）/ 三件套全绿。

## 上游任务产出

- TASK-p0-evidence-floor：E3 送达对账（mock 无送达证据 → `delivery-missing` error）。
- TASK-p0-probe-agents：`src/strength.ts`（`assessAssertionStrength`）、`tests/probes/fake-dsh.mjs`。

开工前确认二者已在 main；缺失则停止并上报。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围；
4. 认为验收标准或任务范围本身有误、互斥或已过时（例如 spike 不通：npm 版 dsh 0.1.7-rc.2 离线跑不通 chaos），应报理由而非硬套。

## 只读约束

TASK 文件与本文件整体（含 front matter 状态头）对你只读；状态头由 Owner 维护。
对验收标准有异议时，命中硬停止条件 4，停下上报，不得修改。

## 过程记录

- 每完成一个 step、或命中硬停止条件时，向 `/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-mock-sentinels.status.md` 追加一行：
  `YYYY-MM-DD HH:mm | step N | done/blocked | 证据（命令+结果 / 文件路径） | 下一步`
- 只追加，不修改已有行。中断续跑时，先读该 status 文件再继续干活。
- status 文件为协议约定写入，不计入「涉及文件」清单之外的改动。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要、spike 结果与 S2 实测退出码、自测命令与结果（含阳性对照记录）、已知风险 / 卡点描述，并附 status 文件绝对路径（未写过程记录视为未完成）。
