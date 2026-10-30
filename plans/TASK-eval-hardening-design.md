# TASK: dsh-eval-harness × ABC 清单与三通道框架的改造设计（只读盘点 + 设计文档）

- 日期：2026-10-30
- 分工：Planner 起草（本契约），Executor 执行，Owner 确认与派发
- 状态：待 Owner 确认（对应 PROMPT 状态头 `pending`）
- 仓库：/Users/boyang/Desktop/dsh-eval-harness（分支 main，v0.6.0）

## 目标

把 ABC（Agentic Benchmark Checklist，arXiv:2507.02825）的 13 条可操作清单与一套 harness 加固框架，对照 dsh-eval-harness 现状逐条盘点，产出可执行的改造设计文档。**本任务只读代码、只产一份设计文档，不改任何代码。**

## 背景

ABC 论文（Establishing Best Practices for Building Rigorous Agentic Benchmarks）把评测可靠性形式化为两个等价：目标能力 ≡ 任务成功（task validity）、任务成功 ≡ 评分为正（outcome validity），外加报告层（reporting）。行业实锤案例：τ-bench 空回复通过不可解任务（airline 子集 38%）；SWE-Lancer 测试 ZIP 可列出可覆盖、不做事拿满分；KernelBench 弱 fuzz 高估 31%；OSWorld 选择器失效低估 28%。

## 13 条可操作清单（对照基准）

**设计期**
- D1 用 ABC 三组检查（T/O/R）过设计文档，每条记 满足/不适用/存疑
- D2 每类 verifier 建"已知放水方式"表（空回复、全量列举、子串误匹配、覆盖测试文件、不变 shape 的弱 fuzz……）
- D3 每个任务配 oracle solver（自动解题器）或人工可解性证明

**运行时**
- R1 锁工具/依赖版本（digest/lockfile 级），处理 API 限流与中断（显式策略：fail/invalid/retry）
- R2 任务间清理状态、环境快照冻结、ground truth 与 agent 执行域隔离
- R3 端到端评分消除非确定性（种子、时间、外部网络）

**校准期**
- C1 do-nothing agent 在"应不可解"任务上得分必须为 0
- C2 cheating agent：把放水方式做成探针 agent 逐条注入
- C3 pilot run 离群 trace 人审（满分与 0 分都看）
- C4 LLM judge 上线前测准确率 + 自一致性

**报告期**
- P1 多 run 方差 + 显著性检验
- P2 trivial / 非 AI 基线分数与 agent 分数并排
- P3 已知弱点披露清单（带量化影响）

## 加固框架概念定义（设计的词汇表）

- **三通道 run 模型**：run 分三类——subject（被测，进分数）/ validity（环境故障，标 invalid 不进分数）/ calibration（已知答案的仪表检查，产出仪表健康报告不进分数）。任何失败先问"暴露的是谁的缺陷"。
- **哨兵（in-band）**：任务集内嵌 1–2 个必过（echo 级）+ 1–2 个必不过（不可能任务），随每次评分运行执行，作为运行级健康位；哨兵分数不进统计，但触发发布阻断。
- **证据对账（default-deny）**：每个判分 verdict 必须对应一条验证执行记录；分数表与证据表按 id 平账；无证据 ≠ 通过，验证环节失败/超时/缺证据的默认结论是 fail 或 invalid，永远不能默认 pass。
- **run manifest**：每次 run 记录环境收据（镜像 digest、依赖版本、seed、数据 hash），分数与收据绑定存档。
- **report schema**：构造声明（测什么能力）/ 协议（manifest、n、seed）/ 结果（分数 + 置信区间 + 方差）/ 基线（trivial、非 AI）/ 已知缺陷。
- **缺陷台账互通**：缺陷按 RQ-F（产品）/ RQ-I（仪器）/ RQ-X（实验效度）三类编号，格式对齐 repo-quake 的 ledger（本地可读：/Users/boyang/repo-quake/ledger/SCHEMA.md）。

## Steps 与 DoD

### S1 现状盘点
通读仓库 AGENTS.md、README.md、docs/gate-signals.md、src/、lib/、tests/、cases/、benchmarks/，盘点现有评分/判分机制、run 流程、输出物与报告形态。允许运行只读命令核实（lint、单测试文件），**不要求也不禁止全量测试**；禁止改动任何代码文件。
- DoD：现状盘点一节覆盖"判分在哪里发生、verifier 有哪些类、run 生命周期、输出什么"。

### S2 13 条对照表
逐条标注 已覆盖 / 部分覆盖 / 缺失 / 不适用，每条带代码级证据（`文件:行`，或明确写"无对应实现"）。
- DoD：13 条全部有判定 + 证据，无一条空泛评语。

### S3 加固设计
六项各一节：三通道数据模型（改哪些模块、run 记录怎么加字段）、哨兵嵌入（结合现有 case 结构）、证据对账（verdict↔evidence 记录）、run manifest、report schema、台账互通。每项给模块级落点 + 设计级方案 + 兼容性风险。
- DoD：六节齐全，每节有"改哪里"与"兼容性风险"。

### S4 分期实施路线
P0/P1/P2 按性价比排序（依据：缺陷对分数偏差的放大倍数），每期含 DoD 与可执行的验收方式。
- DoD：路线覆盖 S3 全部六项，每期可独立验收。

## 基础校验

纯文档任务无构建要求；但分支操作与最终状态需满足：

```bash
cd /Users/boyang/Desktop/dsh-eval-harness && git status --short
# 预期：仅新增 docs/EVAL-HARDENING-DESIGN.md 与 plans/prompts 协议文件
```

## 风险与回滚

- 设计脱离代码现实 → 强制 S2 的文件:行证据与 S1 的只读命令核实。
- 回滚点：单文档新增，`git checkout` 即回滚；分支 `feat/eval-hardening-design` 从 main 新建，不污染 main。
