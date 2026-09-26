---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-plugin-eval-sweep.md
status: done
from: Planner
to: Executor
created: 2026-09-26
---

# 任务：三个高星插件的四层漏斗测评

## 目标

对 dsh-routing-suite（7000★）、modlens（4041★）、dsh-agent-teams（1806★）执行「可装 → 行为正确 → 故障韧性 → 归因」测评，证据落盘。成功标准：契约 DoD 五条全满足。

**先读任务契约**（四层漏斗细则、归因纪律、落盘路径、执行顺序，是本任务的唯一事实来源）：
/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-plugin-eval-sweep.md

## 涉及文件（绝对路径）

新建：
- /Users/boyang/Desktop/dsh-eval-harness/cases/plugins/<插件名>/*.yml（进 git）
- /Users/boyang/Desktop/dsh-eval-harness/.eval/plugin-check-2026-09-26/（证据，不入 git）

参考（只读）：
- cases/chaos/、cases/real/、README.md（/Users/boyang/Desktop/dsh-eval-harness/ 下）
- bin/dsh-with-key.sh（key 口径参考）

## 约束

- 执行顺序 routing-suite → modlens → agent-teams，每插件完成即落盘并上报一次（限额友好）
- agent-teams 先 spike 验证 headless 可行性，不过则换 modsearch 并记录理由
- 归因纪律：红格先跑裸对照再判定；归不出标「未决」，不许猜；写不出可判定断言的 README 承诺记「不可判定」，不写橡皮图章断言
- 零代码改动：发现必须改 harness/dsh 代码时停止上报
- 版本全部钉死（@x.y.z 或 #sha）；真实 API token 开销记入 SUMMARY

## 验收标准（DoD）

见契约 DoD 五条（漏斗落盘齐 / spike 结论 / 无裸红 / 版本钉死 / 三件套全绿）。

## 上游任务产出

TASK-mock-plugin-mount：用例 `mock.plugins` 字段（见 src/types.ts 与 README）。若该能力缺失或 spike 未过，停止并上报。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围。

## 上报格式

每插件完成时：插件名、四层结果表、红格归因、产物路径。
最终：当前状态（done / stopped）、已改动文件列表、自测命令与结果、已知风险 / 卡点描述、token 开销。
