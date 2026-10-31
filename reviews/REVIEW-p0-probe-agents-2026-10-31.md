# REVIEW: TASK-p0-probe-agents（2026-10-31）

- Reviewer: Planner
- Executor: ClaudeCode（Owner 外部派发，P0-1 并行单之一）
- 分支: `feat/p0-probe-agents` @ c58d647（基于合并后的 main，未提交，等 Owner review）
- 结论: **Approved**

## 审计表（Planner 实跑与抽查）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 基点与范围 | Done | 分支基于 `main@c58d647`；`git status` 仅 5 个新建文件 + 2 个 status + 开工前既有 `bin/`、`reviews/`；`git diff -- cases/` 为空 |
| DoD-1 探针 spec | Done | Planner 实跑：12/12 通过（2.57s）；do-nothing 0/12、parrot 恰等于 `KNOWN_PARROT_PASSABLE`（10 条） |
| DoD-1 静态检查 | Done | 34 条用例判弱 14 条 = `KNOWN_WEAK_CASES`（answer-in-prompt 11 + no-outcome-assertion 3），与 parrot 动态结果交叉一致 |
| DoD-2 阳性对照 | Done（上报附证据，抽查可信） | 删白名单条目 → 红；删 08 号用例两个断言 → 双红；还原后复绿，`git diff -- cases/` 空 |
| DoD-3 活清单 | Done | 13 条总表与设计文档 §3.1 逐字一致（上报含逐字比对）；放水表 11 行；lister/TPS 两行排期标注如实 |
| DoD-4 三件套 | Done | Planner 实跑：build OK、全量 355/355（343+12）、lint 32 文件零警告 |
| 质量抽查 | Done | `src/strength.ts` 规则①细化为 `.some(p => p.contains !== '')`（堵空串恒真）；`rejectsPrompt` 对非法正则兜底；fake-dsh 未知 `PROBE_MODE` exit 2 不静默降级；棘轮测试 `toEqual` 完全相等 + 0 error 防空转 |

## 五个拍板点的 Planner 裁定

1. **D1 维持"缺失"**：正确——契约 DoD-3 要求与 §3.1 一致，改判权在 review 侧。裁定：本 PR 合入时 D1 的关闭条件（活文档入库 + PR 模板引用）即满足，**改判 D1 → 已关闭（P0）放在 P0 批次收尾时由 Planner 统一做**，避免每单各自改表。
2. **规则①细化（contains 非空才算结果信号）**：**接受**。契约原文"① tool_result_contains 非空"在"数组非空/字符串非空"上有歧义，执行者取严格读法并与一致性测试自洽——这恰是契约歧义时应有的处理方式。契约记录无需回改，本卡即为裁定依据。
3. **lister 标"计划于 P1"**：**确认**。其设计防线（高熵 nonce）随 P1-3 哨兵模板与用例写作规范落地，探针本身届时视需要补——标注措辞已含"待 Planner 确认"，本卡即确认。
4. **TPS 锚点无排期**：**确认**。设计文档 §6.3 明确 TPS 不在 C2 范围，不设探针是对的，维持现状。
5. **共用检出事故**：**核实无恙**。reflog 显示 evidence-floor 09:27 切走、09:30 切回并转独立 worktree（`/Users/boyang/Desktop/dsh-eval-harness-p0-evidence-floor`，两分支当时同为 c58d647）；本单全部验证在切回后重跑，文件清单零重叠。**双方处置正确**；evidence-floor 的 Review 将在其 worktree 进行。

## Findings

- 无 Blocker / Major。
- [Minor·备忘] 探针 dshBin 不含空格的限制（`splitDshBin` 按空白拆分）已在本机测试中显式报错——若 Owner 仓库路径未来含空格需先解决 `splitDshBin` 的引号处理，记入已知限制即可。
- [增值·记录] 3 条插件冒烟在 parrot 下也通过（一次性核实，未进单测）——与静态判定一致，进了活清单现状段；这也是 case-hardening 把冒烟用例加固推迟的旁证（collector 提取缺口待查）。

## 变更摘要

新建 5 文件：`src/strength.ts`（纯函数静态检查）、`tests/probes/fake-dsh.mjs`（探针，双模式 + fail-fast）、`tests/probes.spec.ts`（12 测试含双白名单棘轮）、`docs/abc-checklist.md`（13 条活清单 + 放水表 11 行 + 现状数字 + 维护规则）、`.github/pull_request_template.md`（效度自检勾选项）。
