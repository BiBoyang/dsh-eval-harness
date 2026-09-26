---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-golden-calibration.md
status: done
from: Planner
to: Executor
created: 2026-09-26
---

# 任务：真实 API 黄金样本 + mock 保真校准

## 目标

抓取真实 API 的黄金响应样本固化为 fixture，mock 输出与之做事件骨架快照比对（离线进 CI）；同用例 mock/真实双跑对撞，判定一致。成功标准：快照比对离线全绿、对撞一致、无 key 入库。

**先读任务契约**（抓取清单、对撞方法、「不一致时停下上报」纪律，是本任务的唯一事实来源）：
/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-golden-calibration.md

**前置条件**：环境变量里有可用的 DEEPSEEK_API_KEY（Owner 提供）。没有就停止上报，不得硬编或伪造样本。这是全套任务中唯一允许连真实 API 的任务。

## 涉及文件（绝对路径）

新建：
- /Users/boyang/Desktop/dsh-eval-harness/tests/fixtures/golden/（黄金样本，每份标抓取日期/端点/关键请求参数）
- /Users/boyang/Desktop/dsh-eval-harness/scripts/capture-golden.mjs（或 .ts，随仓库惯例；只从环境变量读 key）
- 快照比对测试（tests/mock.spec.ts 增补或独立 spec）

修改（按需）：
- /Users/boyang/Desktop/dsh-eval-harness/src/mock.ts —— 仅当快照比对发现方言不一致时修 mock，并在上报中逐条写明差异点
- /Users/boyang/Desktop/dsh-eval-harness/.gitignore —— 确认无任何含 key 的产物会被提交

## 约束

- 抓取脚本与 fixtures 不得包含任何凭据；上报前自查 git status 与 diff
- 发现真实 API 形状与契约/参照记录不一致：停止并上报（可能上游漂移），不擅自「修齐」
- 对撞是本地手动校准步骤，不进 CI；CI 只跑离线快照比对

## 验收标准（DoD）

1. 黄金样本：三协议 F0 各一份 + 三协议真实截断各一份（低 max_tokens/max_output_tokens 诱发），SSE 原文落盘并标注来源
2. 快照比对：mock 三协议 F0/F4/F5 事件骨架（事件名序列 + 终态事件关键字段路径）与黄金样本一致，离线可跑且绿
3. 对撞：2-3 条纯结构性用例双跑（mock vs 真实 API），判定全部一致；结果写进上报
4. `pnpm build` / `pnpm test` / `pnpm lint` 全绿

## 上游任务产出

TASK-mock-core：src/mock.ts；TASK-runner-mock-mode：eval_run mock 模式。任一缺失即停止上报。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要、自测命令与结果、已知风险 / 卡点描述。
