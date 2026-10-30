---
task: /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-eval-hardening-design.md
status: done
from: Planner
to: Executor
created: 2026-10-30
---

# 任务：dsh-eval-harness × ABC 清单与三通道框架的改造设计

## 目标

对照 13 条 ABC 可操作清单与 harness 加固框架（三通道 run 模型 / in-band 哨兵 / 证据对账 / run manifest / report schema / 缺陷台账互通），盘点 dsh-eval-harness v0.6.0 现状，产出设计文档 `docs/EVAL-HARDENING-DESIGN.md`。成功标准：13 条对照逐条带代码级证据、六项加固设计齐全、分期路线可执行。**零代码改动。**

## 开工方式

1. 先读仓库自身约定：`/Users/boyang/Desktop/dsh-eval-harness/AGENTS.md`（遵守其中所有约定）。
2. 再读任务契约：`/Users/boyang/Desktop/dsh-eval-harness/plans/TASK-eval-hardening-design.md`——13 条清单、框架概念定义、Steps 与 DoD 全在里面，以契约为准。
3. 术语参照（只读，可选）：`/Users/boyang/repo-quake/ledger/SCHEMA.md`（缺陷台账格式，S3 台账互通一节需要对齐它）。
4. **分支要求**：从 `main` 新建 `feat/eval-hardening-design` 分支工作，不得在 main 上直接改动；完成后不提交，留给 Owner review。

## 涉及文件（绝对路径）

新建：
- /Users/boyang/Desktop/dsh-eval-harness/docs/EVAL-HARDENING-DESIGN.md（唯一代码交付物）

协议文件（本任务自身记录）：
- /Users/boyang/Desktop/dsh-eval-harness/plans/TASK-eval-hardening-design.md（只读契约）
- /Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-eval-hardening-design.status.md（过程记录，由你追加）

只读参考（禁止修改）：
- /Users/boyang/Desktop/dsh-eval-harness/ 全部代码与文档（AGENTS.md、README.md、docs/、src/、lib/、tests/、cases/、benchmarks/、scripts/）

## 验收标准（DoD）

1. `docs/EVAL-HARDENING-DESIGN.md` 落盘（中文），八部分齐全：背景 / 现状盘点 / 13 条对照表 / 三通道设计 / 哨兵设计 / 证据对账设计 / manifest+report schema 设计 / 分期路线（含台账互通）。
2. 13 条对照逐条有判定（已覆盖/部分/缺失/不适用）+ 代码级证据（文件:行 或 "无对应实现"），无空泛评语。
3. 六项加固设计每节含"改哪里（模块级）"+"怎么改（设计级）"+"兼容性风险"。
4. 分期路线 P0/P1/P2 每期带 DoD 与可执行验收方式。
5. `git status --short` 仅出现 `docs/EVAL-HARDENING-DESIGN.md`（新分支上）；零代码文件改动。
6. 现状盘点中的关键行为断言经过只读命令核实（lint/局部测试），核实命令与结果写进 status 文件。

## 上游任务产出

无（本任务与 repo-quake 仓库的 factorial 任务并行，互不依赖）。

## 硬停止条件（命中任一即停并上报，不硬试、不回滚）

1. 同一处修改尝试超过 3 次仍未通过；
2. 需要改动上述清单之外的文件；
3. 测试/构建失败原因超出本任务描述范围；
4. 认为验收标准或任务范围本身有误、互斥或已过时（例如认为某条清单对 harness 架构不适用，应报理由而非硬套）。

## 只读约束

TASK 文件与本文件整体（含 front matter 状态头）对你只读；状态头由 Owner 维护。
对验收标准有异议时，命中硬停止条件 4，停下上报，不得修改。

## 过程记录

- 每完成一个 step、或命中硬停止条件时，向 `/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-eval-hardening-design.status.md` 追加一行：
  `YYYY-MM-DD HH:mm | step N | done/blocked | 证据（命令+结果 / 文件路径） | 下一步`
- 只追加，不修改已有行。中断续跑时，先读该 status 文件再继续干活。
- status 文件为协议约定写入，不计入「涉及文件」清单之外的改动。

## 上报格式

停止或完成时输出：当前状态（done / stopped）、已改动文件列表、关键 diff 摘要、自测命令与结果、已知风险 / 卡点描述，并附 status 文件绝对路径（未写过程记录视为未完成）。
