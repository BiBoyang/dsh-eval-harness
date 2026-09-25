---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-chaos-pack.md
status: pending
from: Planner
to: Executor
created: 2026-09-26
---

# 任务：内建故障回归用例包（cases/chaos/）+ 文档

## 目标

交付六条 chaos 用例，把 dsh 0.1.7-rc.2 在 F0-F5 下的已核实行为固化为回归断言，并同步文档。成功标准：chaos 包在 mock 模式全绿、断网仍全绿、阳性对照被证明能变红、文档讲清诚实边界。

**先读任务契约**（行为基线表、文档诚实边界要求，是本任务的唯一事实来源）：
/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-chaos-pack.md

## 涉及文件（绝对路径）

新建：
- /Users/boyang/Desktop/dsh-eval-harness/cases/chaos/ 下六个 yml（chaos-f0-healthy / chaos-f1-mid-stream-fin / chaos-f2-missing-terminal / chaos-f3-half-event-fin / chaos-f4-length-truncated / chaos-f5-think-only，tags 含 chaos）

修改（仅文档）：
- /Users/boyang/Desktop/dsh-eval-harness/README.md
- /Users/boyang/Desktop/dsh-eval-harness/docs/（按需，可并入 README）

参考（只读）：
- /Users/boyang/Desktop/dsh-eval-harness/cases/real/（用例风格）
- /Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/matrix/RESULTS-dsh-cc.md（行为基线出处）

## 约束

- turn_end 断言值以真实 trace 的 reason.kind 为准：先跑一条 F4 用例看 collector 解析出的实际字符串，再写断言；不许不验证就照抄契约表
- 本任务零代码改动；发现必须改代码（如 collector 不解析该字段）时停止并上报
- 文档必须写清：mock 不覆盖 judge/语义用例；chaos 钉的是当前行为而非行为背书

## 验收标准（DoD）

1. eval_run 跑 cases/chaos/ 全绿（命令 + 输出）
2. 断网验收：无 API key 环境 chaos 包仍全绿
3. 阳性对照证明：人为制造一次失败（如临时改 chaos-f5 的 fault），证明用例能红，随后还原
4. `pnpm build` / `pnpm test` / `pnpm lint` 全绿

## 上游任务产出

TASK-runner-mock-mode：eval_run 的 mock 模式与 exit_code 断言（见 src/runner.ts、src/assert.ts）。若 spike 未过或 mock 模式不可用，停止并上报。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要、自测命令与结果、已知风险 / 卡点描述。
