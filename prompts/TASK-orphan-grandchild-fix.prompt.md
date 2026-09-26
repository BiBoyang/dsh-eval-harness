---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-orphan-grandchild-fix.md
status: pending
from: Planner
to: Executor
created: 2026-09-27
---

# 任务：超时杀进程树（修孙进程孤儿化）

## 目标

runOne 与 installMockPlugin 两处 spawn 点改为进程组杀（detached + 负 pid），超时/取消时终结整棵子进程树。成功标准：回归测试证明孙进程必死、runner 不再永挂，308+ 既有测试全绿。

**先读任务契约**（根因、安全红线、DoD，是本任务的唯一事实来源）：
/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-orphan-grandchild-fix.md

## 涉及文件（绝对路径）

修改（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：
- src/runner.ts
- tests/runner.spec.ts

## 约束

- detached 只给这两处子进程；负 pid 杀组前确认组 id == 该子进程 pid（防误杀 harness 所在组）
- 正常（无超时）路径语义零变化；Windows 只做注释级退化说明
- 两处都修，不接受只修 runOne

## 验收标准（DoD）

见契约四条：回归测试（孙进程死亡断言）/ 真实复现（pnpm 包装器形态 + 短 timeout 不永挂）/ 全套测试绿 / 注释齐全。

## 上游任务产出

无（git 基线含 v0.5.0 + 未提交的 TASK-mock-plugin-mount 改动——在其之上工作，不要动那批未提交改动的语义）。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要、自测命令与结果、已知风险 / 卡点描述。
