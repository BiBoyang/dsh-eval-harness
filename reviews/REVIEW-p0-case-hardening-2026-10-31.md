# REVIEW: TASK-p0-case-hardening（2026-10-31）

- Reviewer: Planner
- Executor: ClaudeCode（主检出，P0-2 并行单之一）
- 分支: `feat/p0-case-hardening` @ c657d06（未提交，等 Owner review）
- 结论: **Approved**（附两项裁定）

## 审计表（Planner 实跑）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 分支与范围 | Done | 基于 `main@c657d06`；13 文件（10 用例 + 白名单 + SKILL.md + README）+ 新建回放 spec |
| 只增不删 | Done | `git diff --numstat -- cases/` 十文件 +49/−0；程序化比对 prompt 与既有断言零改动（上报含比对）；断言注释带 baseline 原文与 dsh 版本 caveat |
| baseline 零改动 | Done | `git diff -- baseline/` 为空 |
| DoD-1 | Done | Planner 实跑 25/25（probes 12 + 回放 13）；parrot 0/12；静态弱恰 4 条（白名单 diff 带保留理由注释）；回放 12/12 |
| DoD-3 | Done | build OK、全量 386/386（373+13）、lint 33 文件零警告 |
| 阳性对照 | Done | 04 改 `3 pending` → 仅回放红且精确指认；10 改 `(3 agents)` → probes 全绿、仅回放红——证明"抄错期望串只有回放拦得住"的分层防御成立 |
| 文档改动 | Done | SKILL.md 重写了制造 K2 的原始指导（"期望关键词写进 prompt"→"期望串由工具真实结果证明"）；README 增"结果型断言"通过口径段并链活清单 |

## 三项裁定

1. **硬停止 2（docs/abc-checklist.md 过时）**：**批准有范围修订**。该文件自身规则（:70"随白名单同 PR 更新"）使更新成为本任务的义务——这是 Planner 在 P0 契约评审时的清单缺口（未把它列进 case-hardening 的修改清单），责任在契约侧。授权本分支补一次修订：更新 §2 三行现状数字、§3 V4/V5 两行、§4 表、页首日期、D3 进展（回放种子）；**判定列不动**（D1/C2 改判统一留 P0 批次收尾）。
2. **回放范围取舍（交集配对，新增/删除/非 PASS 记 todo 不判红）**：**接受**。死锁推理成立——`update-baseline.yml` 先跑 `pnpm test`，三种情况若判红则 baseline 永远刷不动；缺席场景 gate 的 E7 已兜住，分层无重叠。
3. **回放与有意改写期望串的死锁**：**接受为已知限制，建议的修复（update-baseline 预检跳回放、PR 上 ci.yml 全量回放）授权为 5 行级小改**——由 Planner 在批次收尾内联实施（按协作模式小任务内联规则），或随下次触碰 update-baseline.yml 的任务顺带。绕法（先按旧期望刷一次）写进 gate-signals 即可。

## Findings

- 无 Blocker / Major。
- [备忘] 契约中 README `:98-99` 行号在 evidence-floor 合入后漂移到 `:101-103`——执行者自行适配，记录为"行号引用以语义为准"的又一例。
- [备忘·未实测分支] 回放的"baseline 非 PASS 用例"分支无法在禁改 baseline 的约束下实测，已用冒烟覆盖另两支——如实上报，接受。

## DoD-4（Owner 动作，烧 token 先通知）

真实 API 复核 + baseline 刷新由 Owner 执行：开 PR 后 eval.yml 按口径自动跑一轮（12 用例 × retries，token 量级参照 baseline 的 ~122k），预期 12/12 PASS 后 `gh workflow run update-baseline.yml --ref feat/p0-case-hardening`，复核 PR 时至少抽查 todo-tool / web-search / workflow-fanout 三条的 `toolResults`（文案最易变的三条）。

## 变更摘要

cases/real 十用例各得结果型断言（13 条，全部先在 baseline `toolResults` 核对原文）；白名单按棘轮规则同步（parrot 名单清空、弱用例 14→4）；SKILL.md/README 口径重写；新增 baseline 回放 spec（13 测试，含防空转）。
