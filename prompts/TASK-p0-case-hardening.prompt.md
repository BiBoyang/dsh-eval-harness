---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-case-hardening.md
status: pending
from: Planner
to: Executor
created: 2026-10-30
---

# 任务：cases/real 结果信号加固

## 目标

给 `cases/real` 中 10 条只靠"复述 prompt"就能通过的用例补上 `tool_result_contains`，让"工具真实执行并返回了期望内容"成为通过的必要条件；同步 skill 文档、README 和探针白名单，并新增 baseline 回放测试。成功标准：parrot 0/12；静态弱用例恰为 4 条；baseline 回放 12/12；三件套全绿。真实 API 复核与 baseline 刷新由 Owner 执行。

## 开工方式

1. 先读任务契约（10 条加固断言的对照表、baseline 真实返回摘录、回放测试要求都在里面，是本任务的唯一事实来源）：/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-case-hardening.md
2. 设计背景（可选）：/Users/boyang/Desktop/dsh-eval-harness/docs/EVAL-HARDENING-DESIGN.md。当前检出若不含该文件，以契约摘录为准。
3. **分支要求**：从已合入 TASK-p0-probe-agents 的 `main` 新建 `feat/p0-case-hardening` 分支工作，不得在 main 上直接改动；完成后不提交，留给 Owner review。

## 涉及文件（绝对路径）

修改：
- /Users/boyang/Desktop/dsh-eval-harness/cases/real/ 下 01、02、03、04、05、06、07、09、10、11 共 10 个 yml（只在 assert 块中新增条目）
- /Users/boyang/Desktop/dsh-eval-harness/tests/probes.spec.ts（只改两份白名单）
- /Users/boyang/Desktop/dsh-eval-harness/skills/eval/SKILL.md
- /Users/boyang/Desktop/dsh-eval-harness/README.md

新建：
- /Users/boyang/Desktop/dsh-eval-harness/tests/baseline-replay.spec.ts

协议文件（本任务自身记录）：
- /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-p0-case-hardening.md（只读契约）
- /Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-case-hardening.status.md（过程记录，由你追加）

参考（只读）：
- /Users/boyang/Desktop/dsh-eval-harness/baseline/report.json（真实轨迹，禁止修改）

## 约束

- 只新增 `tool_result_contains`：不改 prompt，不删已有断言，不加 `no_tool_errors`。
- 每条期望串写入前，先在 `baseline/report.json` 的 `toolResults` 里核对真实文本；不许不验证就照抄契约表。
- 不修改 `baseline/report.json`（baseline 只能由 update-baseline workflow 刷新）。
- 不需要、也不应该使用真实 API key；真实复核是 Owner 的步骤。
- 3 条插件冒烟用例与 `cases/example.case.yml` 不在本任务范围，保留在白名单中。

## 验收标准（DoD）

见契约四条：探针与回放测试通过（parrot 0/12、静态弱用例 4 条、回放 12/12）/ 阳性对照 / 三件套全绿 /（Owner）真实 API 复核并刷新 baseline。

## 上游任务产出

TASK-p0-probe-agents：`src/strength.ts`、`tests/probes.spec.ts`、`tests/probes/fake-dsh.mjs`、`docs/abc-checklist.md`。开工前确认这些文件存在于 main；缺失则停止并上报。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围；
4. 认为验收标准或任务范围本身有误、互斥或已过时（例如 baseline 中某工具的真实返回不支持契约给出的期望串），应报理由而非硬套。

## 只读约束

TASK 文件与本文件整体（含 front matter 状态头）对你只读；状态头由 Owner 维护。
对验收标准有异议时，命中硬停止条件 4，停下上报，不得修改。

## 过程记录

- 每完成一个 step、或命中硬停止条件时，向 `/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-case-hardening.status.md` 追加一行：
  `YYYY-MM-DD HH:mm | step N | done/blocked | 证据（命令+结果 / 文件路径） | 下一步`
- 只追加，不修改已有行。中断续跑时，先读该 status 文件再继续干活。
- status 文件为协议约定写入，不计入「涉及文件」清单之外的改动。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要（10 条用例新增的断言逐条列出）、自测命令与结果（含阳性对照记录）、留给 Owner 的真实复核步骤、已知风险 / 卡点描述，并附 status 文件绝对路径（未写过程记录视为未完成）。
