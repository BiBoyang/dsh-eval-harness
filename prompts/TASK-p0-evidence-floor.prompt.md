---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-evidence-floor.md
status: pending
from: Planner
to: Executor
created: 2026-10-30
---

# 任务：证据下限——缺证据不得通过（E3 / E4 / E7 / E8）

## 目标

堵上四个"没有证据却被当成通过"的出口：mock 没送达不得判分（E3）、judge 判 PASS 也要留痕（E4）、baseline 有而本次缺席的用例判 FAIL（E7）、主仓库缺 API key 时 CI 不得显示为绿（E8）。成功标准：forge-f5 探针从 pass 变为 `delivery-missing` error；缺席用例 gate exit 1；judge 证据入报告；三件套全绿。**不升 report schema。**

## 开工方式

1. 先读任务契约（四条规则的精确定义、E8 的建议写法、需要翻转的既有测试都在里面，是本任务的唯一事实来源）：/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-evidence-floor.md
2. 设计背景（可选）：/Users/boyang/Desktop/dsh-eval-harness/docs/EVAL-HARDENING-DESIGN.md。当前检出若不含该文件，以契约摘录为准。
3. **分支要求**：从 `main` 新建 `feat/p0-evidence-floor` 分支工作，不得在 main 上直接改动；完成后不提交，留给 Owner review。

## 涉及文件（绝对路径）

修改：
- /Users/boyang/Desktop/dsh-eval-harness/src/runner.ts
- /Users/boyang/Desktop/dsh-eval-harness/src/types.ts
- /Users/boyang/Desktop/dsh-eval-harness/src/judge.ts
- /Users/boyang/Desktop/dsh-eval-harness/src/gate.ts
- /Users/boyang/Desktop/dsh-eval-harness/src/report.ts
- /Users/boyang/Desktop/dsh-eval-harness/tests/runner.spec.ts
- /Users/boyang/Desktop/dsh-eval-harness/tests/gate.spec.ts
- /Users/boyang/Desktop/dsh-eval-harness/tests/judge.spec.ts
- /Users/boyang/Desktop/dsh-eval-harness/.github/workflows/eval.yml
- /Users/boyang/Desktop/dsh-eval-harness/README.md
- /Users/boyang/Desktop/dsh-eval-harness/docs/gate-signals.md

协议文件（本任务自身记录）：
- /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-evidence-floor.md（只读契约）
- /Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-evidence-floor.status.md（过程记录，由你追加）

参考（只读）：
- /Users/boyang/Desktop/dsh-eval-harness/cases/chaos/chaos-f5-think-only.yml（forge-f5 用例直接跑这条，不复制、不修改）

## 约束

- 以下三处既有测试的期望**按契约有意翻转**，不属于"测试失败超出范围"：`tests/runner.spec.ts:1147`（mock 未被调用 → error）、`tests/runner.spec.ts:928`（judge PASS 留痕）、`tests/gate.spec.ts:109`（removed → FAIL）。除此之外，既有测试的语义不得改变。
- E3 不覆盖已经是 error 的 attempt（如安装失败），只对 pass / fail 做送达对账。
- E8 的 `if:` 表达式要对照 GitHub Actions 表达式文档核对；不能在本机运行 workflow 时，在上报中逐项解释表达式。
- 不升 `CURRENT_REPORT_SCHEMA_VERSION`；新字段一律可选。

## 验收标准（DoD）

见契约六条：forge-f5 证明 / 送达对账四态 / judge 证据 / gate 缺席即 FAIL / eval.yml 两个 step（fork 实跑由 Owner 执行）/ 三件套全绿。

## 上游任务产出

无。与 TASK-p0-probe-agents 并行，两者文件零重叠。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围；
4. 认为验收标准或任务范围本身有误、互斥或已过时，应报理由而非硬套。

## 只读约束

TASK 文件与本文件整体（含 front matter 状态头）对你只读；状态头由 Owner 维护。
对验收标准有异议时，命中硬停止条件 4，停下上报，不得修改。

## 过程记录

- 每完成一个 step、或命中硬停止条件时，向 `/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-evidence-floor.status.md` 追加一行：
  `YYYY-MM-DD HH:mm | step N | done/blocked | 证据（命令+结果 / 文件路径） | 下一步`
- 只追加，不修改已有行。中断续跑时，先读该 status 文件再继续干活。
- status 文件为协议约定写入，不计入「涉及文件」清单之外的改动。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要（按 E3 / E4 / E7 / E8 分组）、自测命令与结果、E8 表达式逐项解释、已知风险 / 卡点描述，并附 status 文件绝对路径（未写过程记录视为未完成）。
