# TASK-chaos-pack：内建故障回归用例包 + 文档

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-chaos-pack.prompt.md
> 创建：2026-09-26 ｜ 状态：pending ｜ 依赖：TASK-runner-mock-mode ｜ 批次：3（与 TASK-golden-calibration 并行）

## 目标

交付 `cases/chaos/` 内建故障用例包：把 dsh 0.1.7-rc.2 在六种流式故障下的已核实行为固化为回归断言，上游未来改动（变好或变坏）都会被门禁抓到；同步 README/docs 讲清 mock 模式的用法与诚实边界。

## 行为基线（dsh 0.1.7-rc.2，横评 3/3 一致实测，三协议行为相同）

| 用例 | fault | 期望 exit_code | 期望 turn/end | 说明 |
|---|---|---|---|---|
| chaos-f0-healthy | F0 | 0 | completed | 对照组：内容完整送达 |
| chaos-f1-mid-stream-fin | F1 | 0 | completed | dsh 静默重试自愈（固化为预期） |
| chaos-f2-missing-terminal | F2 | 0 | completed | 同上 |
| chaos-f3-half-event-fin | F3 | 0 | completed | 同上 |
| chaos-f4-length-truncated | F4 | 1 | reason.kind = max-tokens | dsh 检出但用户无文案（L1 现状固化） |
| chaos-f5-think-only | F5 | 1 | reason.kind = max-tokens | 阳性对照：必须触发已有检测 |

注意：`turn_end` 断言比对的字符串以 collector 实际解析出的 trace `reason.kind` 为准（横评观测值为 `max-tokens`）——实现时先跑一条 F4 看真实 trace 再写断言，不许照抄本表不验证。若 collector 当前不解析该字段，在提审中说明并给出最小改法，不擅自扩大范围。

## 范围（In Scope）

新建：
- `/Users/boyang/Desktop/dsh-eval-harness/cases/chaos/*.yml` —— 上表六条用例（tags 含 `chaos`，便于 `eval_run --tags chaos` 单跑）

修改（仅文档）：
- `/Users/boyang/Desktop/dsh-eval-harness/README.md` —— 用例格式表加 `mock` 段与 `exit_code` 断言；新增「mock 模式与 chaos 包」小节
- `/Users/boyang/Desktop/dsh-eval-harness/docs/` —— 按需加一页 mock 模式说明（可并入 README，由实现者按篇幅判断）

## 文档诚实边界（必须写清）

- mock 模式覆盖：结构性断言 + 故障路径回归；零成本、离线、无 flaky
- mock 模式**不**覆盖：`output_judge` 语义评审与任何依赖真实模型能力的用例——这些仍需真实 API。文档明确写「mock 不是全面断网方案」
- chaos 断言钉的是 dsh 0.1.7-rc.2 的**当前行为**（含 L1 级的缺陷行为：F4 exit 1 无用户文案）；行为固化不等于行为背书，文档里加一句这个立场

## DoD

1. `eval_run` 跑 `cases/chaos/` 全绿（命令 + 输出贴进上报）
2. 断网验收：unset DEEPSEEK_API_KEY / 无网络环境下 chaos 包仍全绿
3. 阳性对照有效：把 chaos-f5 的 fault 临时改成 F4 以外任意值跑一遍人为制造失败（或等价手段），证明用例确实能红——绿灯必须先证明能变红
4. README 更新与本任务范围一致；无代码改动（发现必须改代码时停下上报）
5. `pnpm build` / `pnpm test` / `pnpm lint` 全绿

## 风险与回滚点

- 若 TASK-runner-mock-mode 的 spike 未过，本任务不可开始（依赖检查）
- 回滚：cases/ 新增文件删除即可；文档改动按文件 revert

## 参考素材（绝对路径）

- 横评矩阵记录（行为基线出处）：/Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/matrix/RESULTS-dsh-cc.md
- 现有用例风格参照：/Users/boyang/Desktop/dsh-eval-harness/cases/real/

## 执行变更记录（2026-09-26，Executor 上报 + Planner 复核确认）

1. chaos 用例 F1-F5 全部声明 `mock.once: true`——基线表口径即 once 语义（见 TASK-runner-mock-mode 变更 1）
2. turn_end 断言值经 F4 探针实跑确认为 `max-tokens`，collector 无需改动
3. 阳性对照已执行并还原（f5 fault 临时改 F0 → 双断言变红 → 还原复绿）；Planner 断网复跑 6/6 PASS 确认
