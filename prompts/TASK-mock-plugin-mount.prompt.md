---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-mock-plugin-mount.md
status: done
from: Planner
to: Executor
created: 2026-09-26
---

# 任务：mock 模式支持挂载被测插件

## 目标

用例 `mock:` 段新增 `plugins: [...]`：eval_run 生成隔离 DSH_HOME 后，用 dsh 自己的安装器把声明的插件装进 headless profile，再跑子进程。成功标准：spike（带插件的 F0 用例 PASS）通过 + 安装失败用例级可见 + 三件套全绿。

**先读任务契约**（设计要点、spike 要求、风险，是本任务的唯一事实来源）：
/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-mock-plugin-mount.md

## 涉及文件（绝对路径）

修改（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：
- src/types.ts
- src/runner.ts
- tests/runner.spec.ts
- README.md

参考（只读）：
- src/mock.ts、src/assert.ts、src/report.ts（不动）
- /Users/boyang/deepseek-harness（安装器行为参考，不改动该仓库）

## 约束

- spike 先行：建议用 `dsh-find-plugin`（npm 已发布的小插件）验证全链路；不通立即上报
- 安装用 dsh 自己的安装器（plugin add），不手写 bundle 行；安装失败记用例级 error 而非中断整个 run
- 版本钉死纪律写进 README；本任务不做离线安装
- 不改动 src/mock.ts 的协议行为

## 验收标准（DoD）

1. spike 证据：带 mock.plugins 的 F0 用例 PASS + 隔离 home 内插件安装痕迹（命令 + 输出）
2. 失败路径：不存在/不兼容 spec → 用例 error，消息含 spec 与安装器输出尾部，run 不中断
3. `pnpm build` / `pnpm test` / `pnpm lint` 全绿
4. README 已更新

## 上游任务产出

无（在 v0.5.0 之上直接工作，git 基线 733f54d + tag v0.5.0）。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要、自测命令与结果、已知风险 / 卡点描述。
