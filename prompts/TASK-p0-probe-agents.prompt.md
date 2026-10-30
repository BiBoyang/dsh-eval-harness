---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-probe-agents.md
status: pending
from: Planner
to: Executor
created: 2026-10-30
---

# 任务：探针 agent + 断言强度静态检查 + ABC 活清单

## 目标

交付 do-nothing / parrot 两个探针 agent、`assessAssertionStrength` 静态检查，以及两份"完全相等"白名单的棘轮测试；并把 ABC 13 条对照表与已知放水方式表落成活文档。成功标准：探针测试通过且白名单初值与契约一致；阳性对照证明棘轮能变红；三件套全绿。**不改判分行为，不改用例。**

## 开工方式

1. 先读任务契约（静态规则、测试规格、白名单初值都在里面，是本任务的唯一事实来源）：/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-probe-agents.md
2. 设计背景（可选）：/Users/boyang/Desktop/dsh-eval-harness/docs/EVAL-HARDENING-DESIGN.md。当前检出若不含该文件，以契约摘录为准。
3. **分支要求**：从 `main` 新建 `feat/p0-probe-agents` 分支工作，不得在 main 上直接改动；完成后不提交，留给 Owner review。

## 涉及文件（绝对路径）

新建：
- /Users/boyang/Desktop/dsh-eval-harness/src/strength.ts
- /Users/boyang/Desktop/dsh-eval-harness/tests/probes/fake-dsh.mjs
- /Users/boyang/Desktop/dsh-eval-harness/tests/probes.spec.ts
- /Users/boyang/Desktop/dsh-eval-harness/docs/abc-checklist.md
- /Users/boyang/Desktop/dsh-eval-harness/.github/pull_request_template.md

协议文件（本任务自身记录）：
- /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-probe-agents.md（只读契约）
- /Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-probe-agents.status.md（过程记录，由你追加）

参考（只读）：
- /Users/boyang/Desktop/dsh-eval-harness/tests/runner.spec.ts（既有 fake dsh 写法）
- /Users/boyang/Desktop/dsh-eval-harness/cases/（全部用例）

## 约束

- 不改 `src/runner.ts`、`src/assert.ts`、`src/gate.ts`、`src/report.ts`，不改任何用例，不改 README。
- 白名单必须"完全相等"，不是子集。初值以契约为准；实测与契约不一致时先查原因，不许改白名单来凑绿。
- 阳性对照中临时修改的用例文件必须还原（完成时 `git diff -- cases/` 为空）。

## 验收标准（DoD）

见契约四条：探针测试通过且白名单初值一致 / 两项阳性对照 / 活清单内容 / 三件套全绿且 `git status` 只含新建文件。

## 上游任务产出

无。与 TASK-p0-evidence-floor 并行，两者文件零重叠。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围；
4. 认为验收标准或任务范围本身有误、互斥或已过时（例如实测白名单与契约初值不一致，且原因不在本任务范围内），应报理由而非硬套。

## 只读约束

TASK 文件与本文件整体（含 front matter 状态头）对你只读；状态头由 Owner 维护。
对验收标准有异议时，命中硬停止条件 4，停下上报，不得修改。

## 过程记录

- 每完成一个 step、或命中硬停止条件时，向 `/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-probe-agents.status.md` 追加一行：
  `YYYY-MM-DD HH:mm | step N | done/blocked | 证据（命令+结果 / 文件路径） | 下一步`
- 只追加，不修改已有行。中断续跑时，先读该 status 文件再继续干活。
- status 文件为协议约定写入，不计入「涉及文件」清单之外的改动。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要、自测命令与结果（含两份白名单的实测值与阳性对照记录）、已知风险 / 卡点描述，并附 status 文件绝对路径（未写过程记录视为未完成）。
