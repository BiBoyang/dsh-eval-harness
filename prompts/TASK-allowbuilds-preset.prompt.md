---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-allowbuilds-preset.md
status: pending
from: Planner
to: Executor
created: 2026-09-27
---

# 任务：mock home 预置 allowBuilds（解锁需构建插件）

## 目标

mock.plugins 挂载「需 prepare 构建」的插件时，隔离 home 预置按声明包名最小授权的 allowBuilds 配置，使插件可构建、可激活。成功标准：routing-suite 挂载 chaos 四格从「安装失败 error」变为「行为可判定」（红绿不论）+ 三件套全绿。

**先读任务契约**（背景证据、最小授权红线、机制核查要求，是本任务的唯一事实来源）：
/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-allowbuilds-preset.md

## 涉及文件（绝对路径）

修改（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：
- src/runner.ts
- tests/runner.spec.ts
- README.md

新建（证据，不入 git）：
- /Users/boyang/Desktop/dsh-eval-harness/.eval/plugin-check-2026-09-26/dsh-routing-suite/l3-chaos-mounted-v2/

参考（只读）：
- /Users/boyang/deepseek-harness/apps/cli/src/plugin.ts（安装器提示逻辑）
- .eval/plugin-check-2026-09-26/dsh-routing-suite/（案发证据，仓库内相对路径同上）

## 约束

- allowBuilds 只覆盖 mock.plugins 声明的包名；不全局放行
- 机制先核查（dsh 源码 + pnpm 版本文档）再实现，不凭记忆写字段名
- routing-suite 解锁后 chaos 行为本身为红不算任务失败；无法激活/无法判定才算
- 不改 src/mock.ts 协议行为；不做 routing-suite 的 L2 冒烟

## 验收标准（DoD）

见契约四条：解锁证据（四格可判定 + v2 报告落盘）/ 最小授权单测 / 三类形态包名解析单测 / 三件套绿 + README。

## 上游任务产出

TASK-orphan-grandchild-fix：超时杀进程树已修（src/runner.ts 的 spawn 形态可能已变，以最新代码为准）。若发现该修复缺失，停止并上报。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要、自测命令与结果（含四格 v2 报告摘要）、已知风险 / 卡点描述。
