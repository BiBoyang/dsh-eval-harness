---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-runner-mock-mode.md
status: pending
from: Planner
to: Executor
created: 2026-09-26
---

# 任务：runner 接入 mock 模式 + exit_code 断言

## 目标

让 eval_run 支持用例级 `mock:` 声明（per-case 起 ephemeral mock server + 生成隔离 DSH_HOME 指向它 + 送达证明进报告），并补 `exit_code` 断言。成功标准：spike（mock 模式 F0 用例 PASS）通过、断网（无 DEEPSEEK_API_KEY）可跑、三件套全绿。

**先读任务契约**（设计要点、已验证的 DSH_HOME 参照实现、风险，是本任务的唯一事实来源）：
/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-runner-mock-mode.md

## 涉及文件（绝对路径）

修改（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：
- src/types.ts（case schema 加 `mock?: { fault?: 'F0'|...|'F5' }`；断言加 `exit_code?: number`）
- src/runner.ts（mock 模式接线）
- src/assert.ts（exit_code 断言）
- src/report.ts（attemptResults 附可选 mockDelivery 摘要）
- src/gate.ts（仅当报告校验拒绝新可选字段时放行，保持 legacy 兼容策略）
- tests/runner.spec.ts、tests/assert.spec.ts、tests/report.spec.ts、tests/gate.spec.ts（按需）

不改：src/yaml-mini.ts（mock 段规定块级 map 写法）。

参考（只读）：
- src/mock.ts（上游产出）
- /Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/run/dsh-home/（已验证可用的隔离 DSH_HOME 结构）
- /Users/boyang/deepseek-harness/docs/user/guide/providers.zh.md（dsh providers 配置权威说明）

## 约束

- spike 先行：先打通最小路径（一条 `mock: {fault: F0}` 文本用例出 PASS）再铺开；spike 不通立即上报
- per-case 独立 mock server（port 0 ephemeral），try/finally 回收，无残留端口
- 不碰用户真实 ~/.dsh；子进程 env 在现有透传基础上覆盖 DSH_HOME 与 MOCK_API_KEY
- v1 不支持 tool_calls 脚本、不做 mock_witness 断言

## 验收标准（DoD）

1. spike 证据：mock 模式 F0 用例 PASS（命令 + 输出）
2. 断网验收：无 DEEPSEEK_API_KEY 时 mock 用例照常 PASS
3. exit_code 断言单测三态（匹配/不匹配/未声明）
4. 并发 2 个 mock 用例互不串扰的证明（测试或实测输出）
5. `pnpm build` / `pnpm test` / `pnpm lint` 全绿；真实 API 相关测试本机无 key 可跳过，但须在上报中列出哪些没跑

## 上游任务产出

TASK-mock-core：/Users/boyang/Desktop/dsh-eval-harness/src/mock.ts（`startMockServer` API 见该文件与 plans/TASK-mock-core.md）。若上游缺失或不达标，停止并上报，不自行补写。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要、自测命令与结果、已知风险 / 卡点描述。
