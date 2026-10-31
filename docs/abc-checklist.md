# ABC 13 条活清单

评测效度（ABC，Agentic Benchmark Checklist，arXiv:2507.02825）13 条可操作项的当前判定与证据，以及每类 verifier 的已知放水方式。门禁的假绿通常没人复核，所以这份清单跟着代码走：改到 verifier、断言键或用例类别的 PR，按 §5 同步本文与 `tests/probes.spec.ts` 的白名单（`.github/pull_request_template.md` 勾选项）。

- 来源：§1 的判定与证据沿用 `docs/EVAL-HARDENING-DESIGN.md` §3.1（2026-10-30 盘点）；§2 的关闭条件取自其 §8.7；§3 在其 §6.3 初版上补了探针状态。设计文档是盘点快照，本文是活文档。
- 证据锚点：`文件:行` 指 `main@c58d647` 的仓库根相对路径与行号（`src/`、`tests/`、`cases/` 与设计文档盘点时的 `main@e90c255` 一致）。本文入库后新增的文件用符号名或测试名指代，不写行号。
- 自检：`CI=1 pnpm exec vitest run tests/probes.spec.ts`
- 最近更新：2026-10-31（TASK-p0-case-hardening：10 条用例加固、parrot 0/12；TASK-p0-mock-sentinels：S1/S2 哨兵与 chaos CI）

## 1. 13 条对照总表

| 编号 | 清单项 | ABC 组 | 判定 | 核心证据 |
| --- | --- | --- | --- | --- |
| D1 | 用 T/O/R 三组检查过设计文档 | T/O/R | **缺失** | 无对应实现；`docs/gate-signals.md:1-4` 只记录 gate 软信号的取舍 |
| D2 | 每类 verifier 建"已知放水方式"表 | O | **部分** | 零散防线：`src/assert.ts:129-133`、`cases/real/01-bash-tool.yml:11-13`、`src/runner.ts:844-849`、`:819-821`；无表；K1、K2、K4 未设防 |
| D3 | 每个任务配 oracle solver 或人工可解性证明 | T | **部分** | `README.md:359` 与 `baseline/report.json` 只覆盖 `cases/real`；oracle solver 无对应实现 |
| R1 | 锁版本（digest/lockfile 级）+ 限流与中断的显式策略 | T | **部分** | `.github/workflows/ci.yml:31`、`eval.yml:84`；`src/runner.ts:107-111`（插件钉版本未校验）；`:1028`（限流与断言失败同路径） |
| R2 | 任务间清理、环境快照冻结、GT 与执行域隔离 | T | **部分** | `src/runner.ts:844-853`（清理有）；`:711`、`:884`（真实模式共享 home）；`:809`（GT 可达）；快照无对应实现 |
| R3 | 端到端评分消除非确定性 | O | **部分** | `src/assert.ts:23-136` 是纯函数；`src/mock.ts:115-152` 确定；真实路径无 seed（K12） |
| C1 | do-nothing agent 在"应不可解"任务上得 0 分 | T/O | **缺失** | 无对应实现；K1、K3 |
| C2 | 把放水方式做成探针 agent 逐条注入 | O | **缺失** | 无对应实现；K2（parrot 10/12）、K15 |
| C3 | pilot run 离群 trace 人审（满分与 0 分都看） | O | **部分** | `update-baseline.yml:97-101`（只点名 FAIL/ERROR/flaky）；`src/report.ts:58-62` |
| C4 | LLM judge 上线前测准确率与自一致性 | O | **部分** | `src/judge.ts:125-189`（有 TPR/TNR）；`src/runner.ts:924-944`（不强制）；`src/judge.ts:165-173`（无自一致性） |
| P1 | 多 run 方差 + 显著性检验 | R | **部分** | `src/reliability.ts:19-35`、`src/gate.ts:142-155`；默认 `trials=1`（`src/runner.ts:802`）；无显著性检验 |
| P2 | trivial / 非 AI 基线分数与 agent 分数并排 | R | **缺失** | 无对应实现（`src/types.ts:254-273`、`src/report.ts:31-108` 都没有基线字段） |
| P3 | 已知弱点披露清单（带量化影响） | R | **部分** | `README.md:156-160`、`docs/gate-signals.md:29-33`、`:59-60`；没有量化，也不随报告走 |

判定分布：已覆盖 0、部分 9（D2、D3、R1、R2、R3、C3、C4、P1、P3）、缺失 4（D1、C1、C2、P2）、不适用 0。13 条都适用于 eval_run / eval_gate 主链路；`eval_tps_run` 是测量工具，不适用 C1、C2、D3（设计文档 §1.2）。`K*` 指设计文档 §2.7 的行为断言编号。

## 2. 关闭计划与进展

判定按 §5 第 3 条改：关闭条件满足、并经 review 确认后，才改 §1 的判定。"进展"列只记已入库的产物，或已派发的 P0 任务。

| 编号 | 关闭于 | 关闭条件（设计文档 §8.7） | 进展 |
| --- | --- | --- | --- |
| D1 | P0 | §3 的总表作为活文档入库，PR 模板引用 | 本文与 `.github/pull_request_template.md` 随 TASK-p0-probe-agents 入库；条件已具备，待 review 确认后改判 |
| D2 | P0 | §6.3 放水表的每一行都有探针或单测 | 放水表见本文 §3；parrot、do-nothing、forge-f5 探针均已入库（TASK-p0-probe-agents / TASK-p0-evidence-floor 已合入）；E7/E8 gate 单测已合入；lister/rubric-echo/truncated-trace 按期排期（§3） |
| D3 | P2 | oracle 回放 100% 通过，并有阳性对照 | — |
| R1 | P1 | manifest 记录 digest、锁文件、模型；限流显式记为 invalid(rate-limit) 并退避 | — |
| R2 | P1 | S4 蜜罐常驻；P1-5 完成真实模式的 home 隔离与 workspace 外移 | — |
| R3 | P1 | seed 入 manifest，judge 留痕；真实 API 的非确定性以 trials + 区间呈现，并如实声明"无法消除" | judge 留痕（E4）已合入（TASK-p0-evidence-floor） |
| C1 | P0 | do-nothing 探针单测 + S2 必不过哨兵 | do-nothing 探针单测已入库（`cases/real` 0/12，0 error）；S2 必不过哨兵已入库（TASK-p0-mock-sentinels：F1 持续注入下 exit 1 为实测值，S2=fail 为预期） |
| C2 | P0 | parrot 等探针单测 + in-band weakCases | parrot 探针单测已入库，用例加固后 `cases/real` **0/12**（TASK-p0-case-hardening）；静态检查由 `KNOWN_WEAK_CASES` 锁定；in-band `calibration.weakCases` 已随 TASK-p0-mock-sentinels 合入（告警级） |
| C3 | P2 | 报告人审抽样段 + PR 模板 | — |
| C4 | P2 | 强制校准 + 自一致率 | — |
| P1 | P2 | 区间 + 显著性检验 | — |
| P2 | P2 | floor 与 ceiling 并排呈现 | 地板已由探针单测常驻测得（do-nothing 0/12、parrot 0/12——加固后与天花板重合，见 §4），尚未进报告 |
| P3 | P2 | 已知缺陷带量化进报告 | 本文 §4 给出量化（静态弱用例 4/34；parrot 0/12），尚未随报告走 |

## 3. 已知放水方式表

每行都写明对应的探针或单测及其状态：已入库，或计划于哪一期。"棘轮"指 `tests/probes.spec.ts` 的完全相等白名单：新增这类弱用例会让 `pnpm test` 变红，但存量弱用例仍然能被骗过，要靠用例加固清零。

| verifier | 放水方式 | 现状防线 | 设计防线 | 探针 / 单测 | 状态 |
| --- | --- | --- | --- | --- | --- |
| V4 文本 | 期望串在 prompt 中，复述即过 | 棘轮（静态 `answer-in-prompt`）；存量已清零——`cases/real` 10 条已加固（TASK-p0-case-hardening），`echo-hello` 为语法示例保留在名单 | E2 + 用例改写 | parrot | 已入库：`tests/probes/fake-dsh.mjs`（`PROBE_MODE=parrot`）+ `tests/probes.spec.ts` |
| V1 / V6 | 断言集只有终态或资源上限 | 棘轮（静态 `no-outcome-assertion`） | E2 | do-nothing | 已入库：`PROBE_MODE=do-nothing` + `tests/probes.spec.ts` |
| V3 工具序列 | 点名调用、参数是垃圾、结果报错 | `no_tool_errors`（只有 2 条用例启用）；棘轮（只断言工具名的用例判 `no-outcome-assertion`，存量 3 条插件冒烟） | E2（V5 或 workspace 断言） | parrot | 已入库 |
| V5 参数 | 把 prompt 原文塞进参数，命中 `tool_args_contains` | 棘轮（期望串在 prompt 里的 `tool_args_contains` 不算结果信号）；`bash-tool` 已加固（`tool_result_contains` 绑 bash 真实返回） | 期望串派生化 + `tool_result_contains` | parrot | 已入库 |
| V4 子串 | 回复里罗列大量候选词 | 无 | 期望串用高熵 nonce；用 `output_not_contains` 配反例 | lister（罗列 prompt 中的全部 token） | 计划于 P1：设计文档 §8 未单列 lister，这里按其设计防线（nonce 模板，P1-3）归期，待 Planner 确认 |
| V7 工具错误 | 工具报错后 agent 绕开，凭 prompt 作答 | `no_tool_errors`；gate 的 `toolErrorRecoveries` 只 WARN | E2 | parrot（工具结果一律报错） | 已入库 |
| V8 judge | 迎合 rubric 的措辞 | TPR/TNR 校准（不强制） | 强制校准 + 自一致性 | rubric-echo（复述 rubric） | 计划于 P2（P2-3） |
| mock 证据 | 宿主没打 mock，却产出期望终态 | E3 送达对账已合入（TASK-p0-evidence-floor）；哨兵侧 S1/S2 也要求送达对账（TASK-p0-mock-sentinels） | E3 | forge-f5 | 已入库 |
| 进程 | 宿主中途被杀，已落盘的残缺 trace 被判过 | 超时记 error（A1） | E5 + 三通道 | truncated-trace（写残缺尾帧） | 计划于 P1（P1-1 三通道、P1-4 E5） |
| gate | 用例缺席、run 被筛选、没有 key | 筛选无命中即 throw；E7（缺席即 FAIL）与 E8（主仓库无 key 即红）已合入 | E6–E8 | gate 单测 | E7、E8 已合入（TASK-p0-evidence-floor）；E6 计划于 P1（P1-4） |
| TPS 锚点 | 回复包含该词即算命中 | 无 | 改为回复 trim 后等于该词（或首行等值） | 不设探针：TPS 是测量工具，不在 C2 范围（设计文档 §1.2） | 防线改动未排期（设计文档 §8 未列） |

## 4. 探针与白名单现状（2026-10-31）

用例名单以 `tests/probes.spec.ts` 的 `KNOWN_PARROT_PASSABLE`、`KNOWN_WEAK_CASES` 为准（测试强制与实测完全相等），本节只记数字，随白名单同 PR 更新。

| 探针 / 检查 | 范围 | 结果 | 锁定方式 |
| --- | --- | --- | --- |
| do-nothing | `cases/real` | 0/12 通过：12 条全部断言失败，0 error | 硬断言通过数为 0，且不许有 error |
| parrot | `cases/real` | **0/12 通过**（TASK-p0-case-hardening 加固后：10 条新增 `tool_result_contains` 全部拦下 parrot；`read-image` 两条原本就拦） | `KNOWN_PARROT_PASSABLE` 完全相等（现为空名单） |
| `assessAssertionStrength` | `cases/`、`cases/real`、`cases/chaos`、`cases/plugins/*`，共 34 条 | 弱 4 条：`answer-in-prompt` 1（`echo-hello` 语法示例，保留）、`no-outcome-assertion` 3（`cases/plugins/*` 的 L2 冒烟，collector 提取缺口待查）；`cases/chaos` 0/6 | `KNOWN_WEAK_CASES` 完全相等，逐条比对原因 |
| S1/S2 mock 哨兵 | 随含 mock 用例的 run 注入（TASK-p0-mock-sentinels） | S1=pass、S2=fail（预期）、`calibration.healthy=true`；任一破 → gate FAIL；bypass mock 伪造【P24】→ 双双 delivery-missing | `tests/sentinel.spec.ts` + 阳性对照（chaos.yml 与单测） |

一致性：parrot 能通过的用例都被静态检查判弱（`KNOWN_PARROT_PASSABLE` ⊆ `cases/real` 的静态弱用例，有单测）。3 条插件冒烟 parrot 也能通过（2026-10-31 一次性核实，未进单测：探针单测只跑 `cases/real`）。

## 5. 维护规则

1. **何时更新。** PR 新增或修改了 verifier（`src/assert.ts` 的判定逻辑、`src/judge.ts`）、断言键（`EvalAssert` 与 `parseCase`）或用例类别（`cases/` 下的新目录、新的用例形态）时，在同一个 PR 里：
   - 复检 §1 受影响的条目，需要改判的按第 3 条处理；
   - 在 §3 补行或改行：每行都要写明探针或单测，或标"计划于 Px"；
   - 同步 `tests/probes.spec.ts` 的两份白名单和 §4 的数字；
   - 新增被测用例目录时，把它加进 `tests/probes.spec.ts` 的 `caseDirs` 扫描范围。
2. **白名单纪律（完全相等，不是子集）。**
   - 新增弱用例：先加固用例，补结果型断言（`tool_result_contains`，或期望串不在 prompt 字面里的 `output_contains` / `output_matches` / `tool_args_contains`）。
   - 静态误判（期望串出现在 prompt 里，但语义上确实要执行才能得到）：用例名留在 `KNOWN_WEAK_CASES`，在该行旁写明理由。
   - 用例修好了：在同一个 PR 里从白名单移除。
   - parrot 能过、静态却判强：说明静态规则漏掉了一种放水方式，修 `src/strength.ts`，不要往白名单里塞。
   - 不许为了变绿改白名单而不写理由。
3. **改判。** 判定只随证据变化，并在同一个 PR 里更新 §1 的"核心证据"和 §2 的"进展"。改成"已覆盖"须满足 §2 的关闭条件，并经 review 确认。
4. **证据指针。** `文件:行` 用仓库根相对路径，并注明锚定的提交；改动被引用的代码时同步更新行号，或整体换锚点提交。
