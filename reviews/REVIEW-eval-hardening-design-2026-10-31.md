# REVIEW: TASK-eval-hardening-design（2026-10-31）

- Reviewer: Planner
- Executor: Opus 5.5（Owner 外部派发）
- 分支: `feat/eval-hardening-design` @ f093c6c（已推送，推送是备份不是批准）
- 结论: **Approved**

## 审计表

| 检查项 | 结果 | 证据 |
|---|---|---|
| 契约哈希复核 | Done | TASK `9a426142…` / PROMPT `bdb67e33…` 与派发留痕一致 |
| 零代码改动 | Done | `git diff` 为空；全部产物为文档/契约（12 文件已入库） |
| DoD-1 八部分齐全 | Done | §1 背景 / §2 现状盘点 / §3 十三条对照 / §4 三通道 / §5 哨兵 / §6 证据对账 / §7 manifest+schema / §8 分期路线（含 §8.1 台账互通）+ 附录 A 探针复现 + 附录 B 未核实项 |
| DoD-2 逐条判定+证据 | Done | 13 条全部有判定（部分 9 / 缺失 4 / 不适用 0）+ 文件:行；**Planner 独立抽查 20+ 处引用全部命中**（assert.ts:135 空集放行、runner.ts:119-121 弱校验、gate.ts:8-10 error→fail、eval.yml:84 dsh 0.1.1-rc.2、runner.ts:930 PASS 不留痕、reliability.ts:38-41 分母含 error、types.ts:194 "信息层"注释、SKILL.md:53-54 answer-in-prompt 指导、mock home 锚点 0.1.7-rc.2 与 CI 0.1.1-rc.2 错位、cases/real=12、chaos=6、plugins=15、现有用例零 `{{`） |
| 关键量化口径静态佐证 | Done | `tool_result_contains` 恰好只在 08/12 两条 read-image 用例 → parrot 10/12 的静态口径成立；`output_judge` 仅 example 注释（C4 当前影响 0 属实）；modlens 冒烟确依赖 `/tmp/sweep-modlens/img.png`（D3 差距属实） |
| DoD-3 六项设计三要素 | Done | 每节均有"改哪里（模块级表）+ 怎么改（设计级含数据模型/规则表）+ 兼容性风险（编号清单）" |
| DoD-4 行为断言经核实 | Done | K1–K15 全部带核实方式与结果（探针在 /tmp/ehd-probe 执行，附录 A 可复现）；`pnpm lint` exit 0、204 测试通过（status step 1） |
| DoD-5 git 状态 | Done | 冻结前终检：仅新增声明文件 + status；未跟踪 `bin/` 为开工前既有 |
| 输入偏差处理 | Done | §1.4 如实上报：AGENTS.md 不存在（契约错误——把 monorepo 的布局误写进了盘点清单）、benchmarks/ 不存在（同上）；未触发硬停止，处理正确 |

## 超出契约的增值

1. K1–K15 行为断言体系：把"现状哪里会放水"从推断变成 15 条可复现探针支撑的断言（附录 A 含 fake-dsh 探针全文）。
2. §8.2 放大倍数表：每项缺陷给出量化机制（如 fail 重跑使检出率降为 1/3.3）——排序有依据而非直觉。
3. §8.7 十三条关闭计划：每条清单位置化到具体期次与关闭条件。
4. §5.2 S4 蜜罐的单向性诚实声明（"它没通过不能证明隔离是好的"）。
5. §8.1 台账互通：dedupeKey 去重、候选条目"人工补全前不合法"的有意设计、fault.type 新词需先在 repo-quake SCHEMA 登记——跨仓纪律对齐。

## Findings

- 无 Blocker / Major。
- [Minor·记录在案] §8.2 retries 放大倍数与 token 成本是模型值/估算值（附录 B 已自曝），不是实测——P1 实施时不应引用为承诺数字。
- [Minor·P0 实施时处理] §6.2 用例改写示例中 `printf '%s' QkFTSE9LLTdmM2E= | base64 -d` 的期望串派生方案依赖 `base64` 在宿主环境存在（R2 已点名该依赖），改写用例时需在 `_suite.yml` 或用例注释中声明前置。
- [备注] 契约把 monorepo 的 `AGENTS.md`/`benchmarks/` 误列入盘点清单，Executor 以输入偏差如实上报而非硬套——Planner 侧契约瑕疵，Executor 处理正确。

## 结论与放行建议

设计文档 **Approved**。P0 批次放行建议：
- **P0-1（TASK-p0-evidence-floor + TASK-p0-probe-agents）可派发**——两单文件零重叠、不依赖对方；待 4 份 P0 契约的 Planner 评审通过后正式放行（见后续评审）。
- **P0-2（case-hardening + mock-sentinels）暂缓**——依赖 P0-1 合入 main，且 mock-sentinels 依赖 probe-agents 的 `src/strength.ts`。
- 派发前需补的协议件：4 份 P0 契约缺 Planner 哈希留痕与 status 文件约定（Executor 自拟时未按 WORKFLOW 模板加 front matter），由 Planner 补齐后走确认闸门。
