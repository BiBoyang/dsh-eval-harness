---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-mock-core.md
status: pending
from: Planner
to: Executor
created: 2026-09-26
---

# 任务：内置确定性 mock provider（核心模块）

## 目标

把参照实现以 TypeScript 零依赖重写为 `/Users/boyang/Desktop/dsh-eval-harness/src/mock.ts` 并配齐单测。成功标准：三协议 × F0-F5 故障注入可用，`pnpm build && pnpm test && pnpm lint` 全绿，事件序列快照与参照实现实测输出逐事件一致。

**先读任务契约**（含故障矩阵逐协议字节形态、接口形状、方言教训，是本任务的唯一事实来源）：
/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-mock-core.md

## 涉及文件（绝对路径）

新建：
- /Users/boyang/Desktop/dsh-eval-harness/src/mock.ts
- /Users/boyang/Desktop/dsh-eval-harness/tests/mock.spec.ts

参考（只读，不改动）：
- /Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/mock.mjs（参照实现）
- /Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/logs/mock-2026-09-25.jsonl（参照实测输出）
- /Users/boyang/Desktop/dsh-eval-harness/src/ 与 tests/ 现有文件（代码风格与测试范式）

## 约束

- 零依赖：只用 Node 内置模块；Node >= 22.15 兼容
- 不接 runner、不动任何现有文件的行为
- 协议事件骨架严格按任务契约的故障矩阵表，勿凭直觉拼（方言教训见契约「背景与动机」）

## 验收标准（DoD）

1. `pnpm build`、`pnpm test`、`pnpm lint` 全绿（在 /Users/boyang/Desktop/dsh-eval-harness 下执行）
2. 单测覆盖：三协议 × F0/F4/F5 事件序列快照（与参照 mock.mjs 实测输出比对一致）；once 语义（命中即失效、match/avoid 隔离）；故障参数优先级（URL query > 请求头 > 控制面 > 启动默认）；F2 终止证人缺席；送达证明字段完整
3. 改动仅限上述新建文件

## 上游任务产出

无（本任务是批次 1，无依赖）。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要、自测命令与结果、已知风险 / 卡点描述。
