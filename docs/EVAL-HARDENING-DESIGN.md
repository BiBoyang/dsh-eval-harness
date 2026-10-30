# dsh-eval-harness 评测加固设计：ABC 13 条对照 × 三通道框架

- 日期：2026-10-30
- 对象：dsh-eval-harness v0.6.0（`main@e90c255`）
- 契约：`plans/TASK-eval-hardening-design.md`（S1–S4）；过程记录：`prompts/TASK-eval-hardening-design.status.md`
- 性质：只读盘点 + 设计。**本文不改任何代码**，所有"改哪里 / 怎么改"都是提案，待 Owner review 后另立任务实施
- 证据记法：`文件:行` 指 `main@e90c255` 的仓库根相对路径与行号；"无对应实现"表示在 `src/ tests/ cases/ docs/ skills/ README.md .github/` 内检索不到对应逻辑；"核实#n"指 status 文件 step 1 的第 n 条核实记录；`K*` 指 §2.7 的行为断言编号

## 1. 背景

### 1.1 为什么要做

ABC（Agentic Benchmark Checklist，arXiv:2507.02825）把评测可靠性拆成两个等价加一个报告层：目标能力 ≡ 任务成功（task validity，T），任务成功 ≡ 评分为正（outcome validity，O），以及报告（reporting，R）。契约背景节列举的行业案例说明，这两个等价一旦断裂，偏差量级相当可观：τ-bench 空回复通过不可解任务（airline 子集 38%）；SWE-Lancer 的测试 ZIP 可被列出、可被覆盖；KernelBench 弱 fuzz 高估 31%；OSWorld 选择器失效低估 28%。

dsh-eval-harness 是门禁：它的 PASS 直接决定插件或宿主的改动能否合入。榜单高估了还有人回头复核，门禁的假绿通常没人复核。本文把 13 条可操作清单逐条对到代码，再给出六项加固设计和分期路线。

### 1.2 范围

- 主对象：`eval_run`（`src/runner.ts` 及其调用链）与 `eval_gate`（`src/gate.ts`），即"任务 → 判分 → 门禁"的回归评测主链路。
- 次对象：`eval_judge_validate`（`src/judge.ts`，与 C4 相关）。
- `eval_tps_run`（`src/tps.ts`）是测量工具，不是 pass/fail 评测，没有"任务成功"的概念。本文只在 R1、R3、P1 以及 D2（锚点召回的子串判定）处引用它，不对它套用 C1、C2、D3。
- 非目标：不改代码、用例、baseline、workflow。

### 1.3 框架词汇（沿用契约定义）

| 概念 | 本文用法 |
| --- | --- |
| 三通道 run 模型 | subject（被测，进分数）/ validity（环境故障，标 invalid，不进分数）/ calibration（已知答案的仪表检查，产出仪表健康报告，不进分数）。任何失败先问"暴露的是谁的缺陷" |
| 哨兵（in-band） | 随每次评分运行执行的 1–2 个必过（echo 级）和 1–2 个必不过（不可能任务）。分数不进统计，但能触发发布阻断 |
| 证据对账（default-deny） | 每个 verdict 都对应一条验证执行记录；分数表与证据表按 id 平账；无证据 ≠ 通过。验证环节失败、超时或缺证据时，默认结论是 fail 或 invalid，永远不是 pass |
| run manifest | 环境收据（宿主与依赖版本、digest、seed、数据 hash），与分数绑定存档 |
| report schema | 构造声明 / 协议 / 结果（分数 + 置信区间 + 方差）/ 基线（trivial、非 AI）/ 已知缺陷 |
| 缺陷台账互通 | RQ-F（产品）/ RQ-I（仪器）/ RQ-X（实验效度），格式对齐 `/Users/boyang/repo-quake/ledger/SCHEMA.md`（schema v1） |

### 1.4 输入偏差（已记入 status step 0，未触发硬停止）

- 契约要求先读的 `AGENTS.md` 在仓库中不存在，git 历史里也没有记录。仓库约定以 README、`docs/gate-signals.md` 和本契约为准。
- S1 盘点清单里的 `benchmarks/` 目录不存在。
- 开工前已有未跟踪目录 `bin/`，不是本任务产生的，本任务没有触碰。DoD-5 的 `git status` 核验按"相对开工前的增量"口径执行。

## 2. 现状盘点

### 2.1 主链路一览

```
cases/*.yml ──parseCase──▶ EvalCase                         runEval（src/runner.ts:795）
  │
  ▼
dsh --version 探针 ─▶ loadCases / filterCases ─▶ worker 池（concurrency）
  │
  ▼ 每条用例 × 每个 attempt
清空 workspace ─▶ 写 per-attempt overlay（session 根隔离）─▶ [mock：起 mock server + 隔离 DSH_HOME + 装插件]
  ─▶ spawn `dsh --profile <p> --patch <overlay> <prompt>` ─▶ 找 session 日志 ─▶ collector 抽观测
  ─▶ checkAssertions ─▶ [output_judge] ─▶ AttemptResult（pass / fail / error）
  │
  ▼ retries（非 pass 即重跑、过即停）或 trials（跑满 n 次）
CaseResult ─▶ RunReport ─▶ report.json + report.md
  │
  ▼ eval_gate（src/gate.ts:61）
baseline report.json vs 本次 ─▶ OVERALL=PASS|WARN|FAIL|N/A + EXIT_CODE ─▶ CI（.github/workflows/eval.yml:103-113）
```

### 2.2 run 生命周期

| 阶段 | 位置 | 行为要点 |
| --- | --- | --- |
| 宿主探针 | `src/runner.ts:253-276` | 执行 `dsh --version`（60s 超时）；非零退出或被信号终止直接 throw；stdout 首行记为 `dshVersion`（`:274`） |
| 加载与筛选 | `src/runner.ts:204-230`、`:192-201`、`:812-828` | 按文件名排序加载，重名拒绝（`:220-228`）；`tags` 与 `only` 取交集，无命中 throw（`:819-821`）；校验 `pass_k ≤ trials`（`:823-828`） |
| 并发调度 | `src/runner.ts:1045-1055` | worker 池，结果按加载序写回 |
| attempt 准备 | `src/runner.ts:844-853` | 每个 attempt 前清空并重建 workspace；session 根与 overlay 按 attempt 独立 |
| mock 装配 | `src/runner.ts:963-994`、`:870-883` | per-attempt mock server（127.0.0.1 随机端口）；`once` 经控制面武装；隔离 `DSH_HOME`；`mock.plugins` 用 dsh 安装器逐个安装 |
| 驱动宿主 | `src/runner.ts:884`、`:706-741` | detached 子进程，超时用 SIGKILL 杀整棵进程树（`:449-476`）；只采集 stderr 尾部 8KB |
| 采集 | `src/runner.ts:674-704`、`src/collector.ts:48-134` | 按 `delegationDepth` 选父会话；抽取 turn_end、工具调用与结果、末条 assistant 文本、step 数、token、工具硬错误、坏行数 |
| 判分 | `src/runner.ts:886-955` | 见 §2.3 |
| 重跑 / 测量 | `src/runner.ts:996-1041` | `retries`：非 pass 即重跑，过了就停；`trials>1`：跑满 n 次，任一通过即 pass，附 reliability |
| 报告 | `src/runner.ts:1057-1072`、`src/report.ts:31-108` | 写 `report.json`（schema 1）与 `report.md` |
| 门禁 | `src/gate.ts:257-270`、`:468-518`、`:61-212` | 先严格校验报告（含 summary↔cases 一致性，`:501-504`），再按 name 与 baseline 比对出判定 |
| CI | `.github/workflows/eval.yml:86-113` | 只跑 `cases/real`（`:93`），`concurrency: 3`、`retries: 1`（`:96-98`）；以非 strict 模式比对 `baseline/report.json`（`:109-110`）；以 `EXIT_CODE` 作为退出码（`:113`） |

### 2.3 判分在哪里发生

attempt 级判分在 `runAttemptInner`（`src/runner.ts:840-956`），按顺序有七个出口：

| # | 位置 | 条件 | 结果 |
| --- | --- | --- | --- |
| A1 | `:886-896` | 子进程超时 | `error`（尽力把部分 trace 采进报告） |
| A2 | `:897-907` | 找不到 session 日志 | `error` |
| A3 | `:911-920` | 非零退出，且未在 `assert.exit_code` 中声明 | `error` |
| A4 | `:921` | `checkAssertions` 返回非空失败列表 | `fail` |
| A5 | `:924-929` | 结构断言全过、声明了 `output_judge`，且 judge 判 FAIL | `fail`（理由进 failures） |
| A6 | `:931-943` | judge 调用本身失败（无 key、HTTP 错误、超时、回复不可解析） | `error`（不记 fail） |
| A7 | `:953-955` | 任何异常（含 `mock.plugins` 安装失败） | `error` |

其余情况为 `pass`（`:945-952`）。mock 送达证明在 attempt 结束后才附加（`:980-990`），**不参与判分**。

- 用例级（`:996-1041`）：retries 模式取最后一个 attempt 的状态，"重跑后才过"的标 `flaky`（`:1037`）；trials 模式任一 trial 通过即 `pass`（`:1013-1016`）。
- run 级：`summarize` 统计 pass / fail / error 的数量（`src/gate.ts:521-528`）。
- 门禁级：`error` 与 `fail` 被归一为 fail（`src/gate.ts:8-10`）。PASS→FAIL/error 或新增即失败判 FAIL；FAIL→PASS、增删用例、token、坏行、flaky、工具自愈、错误签名、Wilson 下界判 WARN（`:160-183`）；WARN 在非 strict 模式下退出码为 0（`:20-21`）。
- CI 级：未配置 `DEEPSEEK_API_KEY` 时，评测和门禁两步都跳过（`.github/workflows/eval.yml:88`、`:104`），job 不红。

### 2.4 verifier 分类

| 类 | 实现 | 性质 | 匹配方式与已知弱点 |
| --- | --- | --- | --- |
| V1 终态 | `turn_end`（`src/assert.ts:26-28`） | 确定性 | 等值比较 |
| V2 进程 | `exit_code`（`src/assert.ts:30-37`）+ 出口 A3 | 确定性 | 未声明的非零退出一律记 error |
| V3 工具序列 | `tools_called` / `tools_exact` / `tools_not_called`（`:39-58`） | 确定性 | 只看名字，不看调用是否成功、参数是否有效 |
| V4 文本 | `output_contains` / `output_not_contains`（`:60-74`）、`output_matches`（`:76-90`） | 确定性 | 子串或正则；只看最后一条 assistant 文本（`src/collector.ts:109`）。**期望串如果已经写在 prompt 里，复述即可通过** |
| V5 工具证据 | `tool_args_contains`（`:92-103`）、`tool_result_contains`（`:105-116`） | 确定性 | 子串匹配。`tool_result_contains` 是现有唯一把"输出"和"工具真实执行结果"绑在一起的断言 |
| V6 资源 | `max_steps` / `max_tokens`（`:118-127`） | 确定性 | 上限型，不携带结果信号 |
| V7 工具硬错误 | `no_tool_errors`（`:129-133`） | 确定性 | 识别三种错误形态（`src/collector.ts:139-161`） |
| V8 语义 | `output_judge`（`src/judge.ts:48-93`，出口 A5/A6） | 非确定性（温度 0，模型名是别名） | 结构断言全过才调用；判 PASS 时不留痕（`src/runner.ts:930`） |
| V9 回归比较 | `computeGate`（`src/gate.ts:61-212`） | 确定性 | 比较的是两次单样本状态；error 等同 fail |
| V10 可靠性 | `buildReliability` 与 Wilson 下界（`src/reliability.ts:38-66`、`src/gate.ts:142-155`） | 统计 | 默认关闭；成功率的分母包含 error attempt（`src/reliability.ts:40`） |
| V11 仪表自检（离线） | 黄金样本骨架比对（`tests/golden.spec.ts` + `tests/fixtures/golden/manifest.json`）、collector 契约快照（`tests/zstd.spec.ts` + `tests/fixtures/real-session.jsonl`）、judge 校准（`src/judge.ts:125-189`） | 单测级或人工触发 | 不随评测 run 执行，结果不与 run 绑定 |
| （证据，不判分） | mock 送达证明 `witnessesOf`（`src/mock.ts:382-390`）→ `mockDelivery`（`src/types.ts:194-195`） | — | 类型注释原文为"信息层，v1 无对应断言" |

断言集为空即全过（`src/assert.ts:135`，`tests/assert.spec.ts:116`）。`parseCase` 只要求 `assert` 是 mapping（`src/runner.ts:119-121`），不要求任何携带结果信号的断言。

### 2.5 输出物

| 产物 | 位置 | 内容 | 消费者 |
| --- | --- | --- | --- |
| `report.json` | `<output_dir>/`（`src/runner.ts:1070`） | schema 1：头部（harness `version`、起止时间、`profile`、`dshVersion`）+ `cases[]`（末次 attempt 的投影 + `attemptResults[]` + 可选 `reliability`）+ `summary`（`src/types.ts:254-273`） | `eval_gate`；CI artifact（`.github/workflows/eval.yml:115-123`）；update-baseline 的 PR 摘要（`update-baseline.yml:86`、`:93`） |
| `report.md` | 同上（`:1071`） | 头部**不含** harness 版本（`src/report.ts:34-41`）；用例表；只为非 pass 或多 attempt 的用例出明细（`:58-62`）；错误签名聚合（`:98-106`） | 人 |
| overlay | `<output_dir>/eval-overlay-<序号-slug>-a<n>.patch.yml`（`src/runner.ts:851`） | 把 session 根重定向到隔离目录 | dsh |
| 会话 trace | `<session_root>/<序号-slug>/attempt-<n>/…`（`:850`） | dsh 原始落盘 | collector；CI **不上传**（`eval.yml:115`） |
| workspace | `<output_dir>/.workspace/<序号-slug>`（`:809`、`:836`） | agent 的 cwd | 无（下个 attempt 开始前清空） |
| mock home | `<output_dir>/.mock-home/<序号-slug>/attempt-<n>`（`:872`） | 隔离的 `DSH_HOME` | dsh |
| gate 输出 | stdout（`src/gate.ts:215-250`） | `OVERALL`、`EXIT_CODE` 等 key=value 行，或单条 JSON | CI |
| `eval_run` 工具返回值 | `src/index.ts:99-104` | summary + 各用例的 name / status / failures / error | 调用方 agent |
| judge 校准报告 | `eval_judge_validate` 返回值（`src/index.ts:185-192`） | 混淆矩阵、TPR/TNR、mismatches | 人（不落盘，不与 run 绑定） |
| TPS 报告 | `tps-report.json/md`（`src/tps.ts:744-746`） | 配置回显 + 样本 + 拟合 | 人 |

### 2.6 用例资产与 baseline

| 目录 | 条数 | 模式 | 进 CI | 有 baseline |
| --- | --- | --- | --- | --- |
| `cases/real/` | 12 | 真实 API | 是（`eval.yml:93`） | 有：`baseline/report.json`（harness 0.3.1，见 `:4`；dsh 0.1.1-rc.2，见 `:9`；2026-08-24；12/12 PASS；tokens 合计 122,467） |
| `cases/chaos/` | 6 | mock（F0–F5） | 否 | 无（README 称已固化 dsh 0.1.7-rc.2 的行为，`README.md:150-154`） |
| `cases/plugins/*/` | 15 | 12 条 mock chaos（L3）+ 3 条真实 API 冒烟 | 否 | 无 |
| `cases/example.case.yml` | 1 | 真实 API | 否 | 无 |

有两点与后面的设计直接相关：

1. `cases/real/` 的期望串几乎都写在 prompt 里（例如 `cases/real/02-fs-write-read.yml:4`、`:7` 与断言 `:12`）。这是 skill 文档明确要求的写法："把插件名、输入数据、期望输出关键词都写进 prompt"（`skills/eval/SKILL.md:53-54`）。
2. mock 隔离 home 的结构锚定 dsh 0.1.7-rc.2（`src/runner.ts:311`、`:337`），而 CI 安装的是 dsh 0.1.1-rc.2（`.github/workflows/eval.yml:84`）。mock 类用例目前不在 CI 里跑，这个错位会直接影响 §5 哨兵的落地。

### 2.7 关键行为断言与核实结果

核实命令与原始输出摘要见 status 文件 step 1；探针复现方法见附录 A。探针在仓库外（`/tmp/ehd-probe`）用 `tsc --outDir` 编译出的 `src` 副本运行，用例只读，全部输出落在 `/tmp`。

| # | 断言 | 代码证据 | 核实方式与结果 |
| --- | --- | --- | --- |
| K1 | 只断言 `turn_end` 这类弱断言的用例，do-nothing agent 即可通过 | `src/runner.ts:119-121`、`src/assert.ts:135` | `tests/assert.spec.ts:116` 通过；探针：弱用例上 do-nothing 1/1 PASS（核实#3） |
| K2 | 期望串在 prompt 中的用例，可以被"复述型"agent 通过 | `skills/eval/SKILL.md:53-54`；V4 子串匹配 `src/assert.ts:62` | 探针 parrot（按 prompt 点名调用工具、参数为整段 prompt、工具结果全部报错、最终复述 prompt）在 `cases/real` 上 10/12 PASS，只有 `read-image`、`read-image-oversized`（`tool_result_contains`）拦下了它（核实#3） |
| K3 | 纯 do-nothing 在 `cases/real` 上得 0 分 | 12 条用例都断言了 `tools_called` 或 `tools_exact` | 探针：0/12（核实#3） |
| K4 | mock 没被调用（没有送达证据）不影响判分 | `src/types.ts:194`、`src/runner.ts:980-990` | `tests/runner.spec.ts:1147` 通过；探针：一个不连 mock、直接伪造终态的 dsh 通过了 `chaos-f5-think-only`，`mockDelivery=[]`（核实#3） |
| K5 | gate 把 error 当作 fail | `src/gate.ts:8-10` | `tests/gate.spec.ts:83` 通过；探针：pass→error(timeout) 判 FAIL、exit 1；error→pass 被记为 improvement（核实#4） |
| K6 | baseline 有而本次缺席的用例只给 WARN，非 strict 模式退出码为 0 | `src/gate.ts:121-123`、`:165-179`、`:20-21`；`eval.yml:110` | `tests/gate.spec.ts:109` 通过（核实#2） |
| K7 | retries 对 fail 和 error 都重跑，过了就停 | `src/runner.ts:1028-1031` | `tests/runner.spec.ts:660`、`:758` 通过（核实#2） |
| K8 | trials 成功率的分母包含 infra error | `src/reliability.ts:38-49` | 探针：[pass, error, error] → successRate 0.333，Wilson 下界 0.078（核实#4） |
| K9 | gate 不比较 harness 版本 | `src/gate.ts:156-158` 只比较 `dshVersion` | 探针：baseline 0.3.1 对比当前 0.6.0 → PASS，reasons 中没有任何提示（核实#4） |
| K10 | trace 里有实际模型身份，但没有采集 | `src/collector.ts:107-121` | 探针：collector 产物中没有 model 字段；fixture 帧里有 `source.model=deepseek-v4-pro`、`provider=deepseek-official`（核实#4） |
| K11 | `require_plugins` 只解析不执行 | `src/runner.ts:71-75`、`:185`；`README.md:50` 注明是"元信息" | `grep -n require_plugins src/*.ts` 只命中解析处（核实#4） |
| K12 | 没有任何 seed 机制 | — | `grep -in seed src/*.ts` 无命中（核实#4） |
| K13 | attempt 之间会清空 workspace | `src/runner.ts:844-849` | `tests/runner.spec.ts:741` 通过（核实#2） |
| K14 | judge 调用失败记 error，不记 fail 也不记 pass | `src/runner.ts:931-943` | `tests/runner.spec.ts:951`、`:973` 通过（核实#2） |
| K15 | 单个插件的工具全部损坏时，在现行 CI 配置下门禁不会变红 | K2 + `src/gate.ts:131-135`（工具自愈只 WARN）+ `eval.yml:110`（非 strict） | 探针：把某个插件对应的用例换成 parrot 结果、其余沿用 baseline，todo / fs-search / web / subagent / workflow 五组都是"用例 PASS、gate WARN、exit 0"；`cases/real` 覆盖的 7 组插件里，只有 bash 和 fs 会被 `read-image` 两条用例拦成 FAIL（核实#5） |

另外：`pnpm lint` 退出码 0；6 个相关 spec 文件共 204 个测试全部通过（核实#1、#2）。

## 3. 13 条对照表

### 3.1 总表

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

判定分布：已覆盖 0、部分 9（D2、D3、R1、R2、R3、C3、C4、P1、P3）、缺失 4（D1、C1、C2、P2）、不适用 0。13 条都适用于 eval_run / eval_gate 主链路；`eval_tps_run` 不适用 C1、C2、D3，范围已在 §1.2 声明。

### 3.2 逐条说明

#### D1 用 ABC 三组检查过设计文档 —— 缺失

- 证据：无对应实现。`task validity`、`outcome validity`、`ABC` 在 `src/ docs/ README.md skills/ cases/ tests/ .github/` 内都检索不到；唯一的设计理由文档 `docs/gate-signals.md:1-4` 只覆盖 gate 软信号的取舍。
- 差距：设计取舍有记录（gate-signals 每条规则都对应一次事故），但从来没有按 T/O/R 逐条标注"满足 / 不适用 / 存疑"；用例编写规范（`skills/eval/SKILL.md`）里也没有效度检查项。
- 本文 §3 就是第一轮按组过检，分组见 §3.1 的"ABC 组"列。落地方式见 §8.3 P0-5。

#### D2 每类 verifier 建"已知放水方式"表 —— 部分

- 现有防线（零散）：
  - 工具报错但 agent 兜底答对：`no_tool_errors`（`src/assert.ts:129-133`；`README.md:99`；`cases/real/08-read-image.yml:16-20`）。
  - 编造工具输出：用 `tool_args_contains` 绑定入参（`cases/real/01-bash-tool.yml:11-13`）。
  - 上一个 attempt 的文件副作用伪造通过：workspace 清空（`src/runner.ts:844-849`；`tests/runner.spec.ts:741`）。
  - CI 筛选条件笔误导致空跑假绿：无命中即 throw（`src/runner.ts:819-821`）。
  - judge 基础设施抖动被记成断言结论：改记 error（`src/runner.ts:931-943`）。
  - flaky、工具自愈、错误签名这几路信号的盲区自述（`docs/gate-signals.md:29-33`、`:59-60`）。
- 差距：没有"verifier 类 × 放水方式 × 防线 × 探针"的表。下列放水方式目前没有防线：
  1. 期望串在 prompt 里，复述即过（K2，10/12）。
  2. 断言集没有"结果信号"下限（K1）。
  3. 子串匹配：`src/assert.ts:62`、`:97`、`:110`；TPS 锚点也一样，prompt 要求"只回复该词"（`src/tps.ts:194`），判定却是包含即命中（`src/tps.ts:687`）。
  4. mock 故障没有送达，照样判分（K4）。
  5. V3 只认工具名，不看调用成败。
- 设计：§6.3 给出初版放水表，并为每一行绑定一个探针。

#### D3 每个任务配 oracle solver 或人工可解性证明 —— 部分

- 证据：
  - `cases/real` 的可解性证明是"真实 agent 全量通过 + 人工复核"（`README.md:359`；`baseline/report.json:4` 为 harness 0.3.1，`:9` 为 dsh 0.1.1-rc.2，12/12 PASS）。
  - chaos 包"已做阳性对照验证（人为改 fault 证明用例能红）"（`README.md:154`），但验证记录不在仓库里（`.eval/` 被 `.gitignore` 忽略）。
  - plugins 冒烟用例自注"oracle 取最只读的一员"（`cases/plugins/dsh-agent-teams/agent-teams-smoke-status.yml:2`），这里的 oracle 指被调用的工具，不是解题器。modlens 冒烟自注视觉成效"不可判定"（`cases/plugins/modlens/modlens-smoke-read-image.yml:2-3`），并且依赖仓库外的文件 `/tmp/sweep-modlens/img.png`（`:6`、`:9`）。
  - oracle solver：无对应实现。
- 差距：
  1. 没有"已知正确解一定被 verifier 接受"的离线验证（例如参考轨迹回放）。
  2. `cases/chaos`、`cases/plugins` 没有入库的 baseline 或可解性记录。
  3. 可解性证明来自被测对象本身（agent 通过了）。verifier 一旦放水（K2），"通过"就不能证明任务被真正解决。

#### R1 锁工具与依赖版本，限流与中断有显式策略 —— 部分

- 已有：
  - harness 依赖有 lockfile，并用 `--frozen-lockfile` 安装（`pnpm-lock.yaml`；`.github/workflows/ci.yml:31`、`eval.yml:71`）。
  - CI 里的 dsh 钉了版本号（`eval.yml:84`，`@deepseek-ai/dsh@0.1.1-rc.2`），`dshVersion` 写入报告（`src/runner.ts:274`、`:1066`）。
  - judge 失败或超时记 error（`src/runner.ts:931-943`）；子进程超时记 error 并杀进程树（`:886-896`、`:449-476`）。
  - TPS 的样本级失败不进统计（`src/tps.ts:302-305`、`:694`）。
- 差距：
  - 宿主只钉版本号，不钉 digest。`npm install -g` 没有 lockfile，dsh 的 531 个传递依赖每次都重新解析（`eval.yml:75`）。
  - `mock.plugins`"版本必须钉死"只是约定（`README.md:123`），解析时只校验是非空字符串（`src/runner.ts:107-111`）。
  - 被测模型和 judge 模型都既没钉也没记录：judge 默认用别名 `deepseek-chat`（`src/judge.ts:55`），agent 实际用的模型没有采集（K10）。
  - 限流与中断没有显式分类：429、网络中断和断言失败走同一条重跑路径（`src/runner.ts:1028`），没有退避。"fail / invalid / retry"三选一的策略表无对应实现。

#### R2 任务间清理状态、环境快照冻结、GT 与执行域隔离 —— 部分

- 已有：attempt 之间清空 workspace（`src/runner.ts:844-849`，K13）；session 根和 overlay 按 attempt 隔离（`:850-853`）；mock 模式下每个 attempt 有独立的 `DSH_HOME` 并清除代理（`:870-874`、`:410-421`）；并发用例互不干扰（`tests/runner.spec.ts:321`）。
- 差距：
  - 真实 API 模式共享调用者的 `DSH_HOME` 与 profile（`runOne` 默认透传 env，`src/runner.ts:711`、`:884`）。`docs/gate-signals.md:6-12` 记录的 #4312，正是三个进程并发 heal 共享 profile 目录引发的。
  - 环境快照：无对应实现（没有容器或镜像 digest）。用例依赖宿主机上的 `python3`、`base64` 等（`cases/real/12-read-image-oversized.yml`、`cases/real/08-read-image.yml`），modlens 冒烟还依赖 `/tmp` 下的外部文件。
  - GT 隔离：agent 的工作目录在 `output_dir` 之下（`src/runner.ts:809`），而 CI 的 `output_dir` 在仓库内（`eval.yml:94`，`.eval/out`）。所以用例文件和带有上次 `finalText` 的 `baseline/report.json` 都在 agent 可达的路径上。mock home 预设 `danger-full-access`（`src/runner.ts:319-320`、`:382-385`），真实模式的权限取决于调用者的 profile。期望串本来就在 prompt 里（K2）。也没有任何"GT 可达性"检测。

#### R3 端到端评分消除非确定性 —— 部分

- 已有：结构断言是 trace 的纯函数（`src/assert.ts:23-136`）；mock 内容是确定的，只监听 127.0.0.1（`src/mock.ts:115-152`、`:668`），故障取值优先级固定（`:579-595`）；judge 用温度 0、`max_tokens` 200（`src/judge.ts:69-70`）。
- 差距：
  - 真实 API 路径既没有 seed 也没有温度控制（K12），还依赖外网（`cases/real/07-web-search.yml` 搜的是实时网页）。非确定性是靠 `retries` 遮住的（`eval.yml:96-98`），并没有被消除。
  - judge 没有 seed，模型别名可能漂移（`src/judge.ts:55`），同一输入两次判定可能不同。PASS 判定还不留痕（`src/runner.ts:930`），事后无法复核。

#### C1 do-nothing agent 在"应不可解"任务上必须得 0 分 —— 缺失

- 证据：无对应实现。用例集里没有"应不可解"的任务，也没有 do-nothing 校准 run。
- 核实：do-nothing 探针在 `cases/real` 上 0/12（K3），但这是因为现有用例恰好都断言了工具调用，不是机制保证——只断言 `turn_end` 的用例，do-nothing 1/1 通过（K1），因为 `parseCase` 不设断言强度下限（`src/runner.ts:119-121`）。
- 设计：§5 的必不过哨兵；§6 的断言下限与 do-nothing 探针。

#### C2 cheating agent：把放水方式做成探针逐条注入 —— 缺失

- 证据：无对应实现。
- 核实：parrot 探针在 `cases/real` 上拿到 10/12（K2）。这个探针的行为与一个真实故障同形：被测插件的工具全部报错，而 agent 照 prompt 要求写出期望串。`docs/gate-signals.md:35-41` 把这种行为称为"LLM 粉饰太平"。它带来的直接后果是 K15：7 组被覆盖的插件中，有 5 组即使整体损坏，CI 也不会变红。
- 设计：§6.3 的放水表 + 探针 agent 进入 calibration 通道。

#### C3 pilot run 离群 trace 人审（满分与 0 分都看）—— 部分

- 已有：baseline 入库前有人工复核（`README.md:359`）；`update-baseline.yml` 只开放 `workflow_dispatch`，并固定走 PR（`update-baseline.yml:3-6`），PR 里附复核要点（`:97-101`）。本地有人工"红格归因"实践（`.eval/plugin-check-2026-09-26/SUMMARY.md`，未入库）。
- 差距：
  - 复核要点只点名 FAIL/ERROR 和 flaky（`update-baseline.yml:100-101`），**满分 trace 不在复核清单里**。
  - `report.md` 只为非 pass 或多 attempt 的用例出明细（`src/report.ts:58-62`）。
  - CI 不上传 trace（`eval.yml:115`），复核者只能看到 `finalText`。
  - 离群抽样（tokens/steps 极值、首尾分位）无对应实现。

#### C4 LLM judge 上线前测准确率与自一致性 —— 部分

- 已有：`eval_judge_validate` 报告混淆矩阵，TPR 和 TNR 分开看，两项都达标才算 `calibrated`（`src/judge.ts:125-189`；`README.md:213-216`、`:218-232`）；judge 先分析后判定（`src/judge.ts:27-32`）；judge 基础设施失败不当作结论（K14）。
- 差距：
  1. 不强制：运行 `output_judge` 时不检查任何校准记录（`src/runner.ts:924-944`）。
  2. 没测自一致性：每条标注只调用一次（`src/judge.ts:165-173`），没有重复采样一致率。
  3. 校准结果不绑定 judge 模型和提示词版本（`JudgeCalibration` 没有模型字段，`src/judge.ts:103-118`）。README 列出的"重新校准时机"（`README.md:231-232`）只能靠人记。
- 现状：没有任何真实用例启用 `output_judge`（只有 `cases/example.case.yml:12-15` 的注释示范），所以目前对分数的影响为 0。

#### P1 多 run 方差 + 显著性检验 —— 部分

- 已有：trials 跑满 n 次独立 attempt（`src/runner.ts:1006-1027`）；pass@k 与 pass^k 用无偏估计（`src/reliability.ts:19-35`）；可选的 Wilson 单侧下界门禁（`src/gate.ts:142-155`，`docs/gate-signals.md:74-87`）。
- 差距：
  1. 默认 `trials=1`（`src/runner.ts:802`），CI 也是单次 run（`eval.yml:92-99`）。门禁比较的是两次单样本（`src/gate.ts:86-97`），PASS→FAIL 即判 FAIL，没有显著性的概念。
  2. suite 级成功率与置信区间、两次 run 之间的差异检验：无对应实现。
  3. 成功率分母混入了 infra error（K8）。
  4. `src/types.ts:208` 的注释仍写着 pass^k = (c/n)^k，与实现（`src/reliability.ts:32-35` 的无偏估计）不一致。

#### P2 trivial / 非 AI 基线分数与 agent 分数并排 —— 缺失

- 证据：无对应实现。`RunReport`（`src/types.ts:254-273`）和 `report.md`（`src/report.ts:31-108`）都没有基线字段。
- 相邻实践：chaos F0 是宿主行为的对照组（`cases/chaos/chaos-f0-healthy.yml:1`）；TPS 建议带阳性对照模型（`README.md:281`、`src/tps.ts:579`）。两者都不是 trivial agent 基线。
- 核实已经给出现成的地板：do-nothing 0/12，parrot 10/12（K2、K3）。如果在 12/12 的 agent 分数旁边并排写上 parrot 10/12，读者立刻就能看出这套用例对"真正解题"的判别力只有 2 条。

#### P3 已知弱点披露清单（带量化影响）—— 部分

- 已有：`README.md:156-160`（mock 的诚实边界；"行为固化不等于行为背书"）；`docs/gate-signals.md:29-33`、`:59-60`（信号盲区与局限）；`README.md:277-288`（TPS 读数纪律与不覆盖的范围）。
- 差距：这些披露散落在 README 和文档里，没有量化（例如"parrot 10/12"这样的数字），也不随报告走（`report.json` 和 `report.md` 都没有已知缺陷段，见 `src/report.ts:33-45`）。用例级的弱点（例如 `read-image` 在无视觉能力的模型上预期 fail，`README.md:99`、`:359`）同样只写在 README 里。

### 3.3 小结

最大的结构性问题在 outcome validity。判分只看"做了什么动作、说了什么话"，不看"动作有没有产生结果、话是不是来自结果"（K2、K15）；并且"缺证据"在好几处被处理成了通过或者只给 WARN（K1、K4、K6、CI 无 key 时跳过）。task validity 次之：GT 可达、真实模式共享 profile、依赖没有钉到 digest。报告层缺少参照系：没有地板和天花板，也没有置信区间。

## 4. 三通道 run 模型设计

### 4.1 改哪里（模块级）

| 模块 | 改动 |
| --- | --- |
| `src/types.ts` | 新增 `Channel`、`Outcome`、`InvalidReason`；`AttemptResult` 与 `CaseResult` 增加 `outcome`、`invalidReason`；`RunReport.summary` 增加 `invalid`，并新增 `channels` 摘要；`CURRENT_REPORT_SCHEMA_VERSION` 从 1 升到 2（`:155-157`） |
| `src/channel.ts`（新） | 分类函数 `classifyAttempt(facts, ctx) → { outcome, invalidReason }`，集中维护 §4.2 的规则表；runner 只上报原始事实 |
| `src/runner.ts` | 出口 A1–A7（`:886-955`）改为产出原始事实，交给 `classifyAttempt`；重跑循环（`:1028`）改为只补测 invalid；trials 统计改用 valid attempt（`:1013-1027`）；新增 `require_plugins` 前置检查 |
| `src/reliability.ts` | `buildReliability`（`:38-49`）的分母改为 valid attempt，另报 `invalidAttempts`；valid 数小于 k 时 pass@k 置 null |
| `src/gate.ts` | `effective()`（`:8-10`）改为三值；新增判定 `INVALID`（exit 3）；`normalizeReport`（`:468-518`）支持 schema 2，并把 schema 0/1 的 `error` 映射为 `invalid(legacy-error)` |
| `src/error-signature.ts` | 签名聚合改为扫描 invalid attempt，作为 validity 通道的主诊断视图；`extractErrorSignature`（`:14-32`）额外返回栈顶应用帧的路径，供宿主/插件归属判定 |
| `src/report.ts` | 汇总行按三通道拆分；新增"有效性"小节（invalid 原因分布） |
| `src/index.ts` | `eval_run` 返回值（`:99-104`）增加 `outcome`、`invalidReason`；`eval_gate` 的描述补充 exit 3 |
| 用例字段（`parseCase`） | 新增可选字段 `subject`（取值 `plugin` / `host`）；缺省时 mock 用例为 host（测宿主的协议韧性），真实 API 用例为 plugin |
| `.github/workflows/eval.yml`、`update-baseline.yml` | 说明 `retries` 的新语义；PR 摘要改用 `summary.invalid`（`update-baseline.yml:86`） |

### 4.2 怎么改（设计级）

**数据模型。** 用例声明通道，attempt 得出结论：

```ts
type Channel = 'subject' | 'calibration'          // 用例声明：被测，或仪表（哨兵、探针）
type Outcome = 'pass' | 'fail' | 'invalid'         // attempt / 用例结论；invalid 的集合就是 validity 通道
type InvalidReason =
  | 'spawn' | 'install' | 'precondition'          // 起不来、装不上、前置条件不满足
  | 'timeout' | 'no-trace' | 'trace-integrity'    // 没跑完、没留痕、痕迹残缺
  | 'host-exit' | 'rate-limit' | 'judge-infra'    // 宿主崩溃、限流、judge 调不通
  | 'delivery-missing' | 'harness-exception'      // 故障没送达、harness 自身异常
  | 'aborted' | 'legacy-error'                    // 哨兵破导致中止；schema 0/1 的 error 迁移值
  | 'judge-uncalibrated'                          // judge 没有匹配的校准记录（P2，见 §8.5）
```

原来的 `status: 'pass' | 'fail' | 'error'` 保留为兼容投影（invalid 投影为 error），一个 minor 版本后废弃。

**分类规则（"暴露的是谁的缺陷"）：**

| 原始事实（现出口） | subject=plugin（真实 API） | subject=host（mock） | 理由 |
| --- | --- | --- | --- |
| 超时（A1） | invalid(timeout) | fail | 真实模式里有外网和模型排队，超时无法归因；mock 是本地确定环境，挂死就是宿主缺陷 |
| 找不到 trace（A2） | invalid(no-trace) | invalid(no-trace) | 落盘失败可能是 overlay 与宿主版本漂移（仪表问题），不归被测 |
| 未声明的非零退出（A3） | 栈顶应用帧在被测插件包内 → fail；否则 invalid(host-exit) | fail | #4312 那种宿主崩溃不是插件的账；插件把宿主带崩则是插件的账 |
| 断言失败（A4、A5） | fail | fail | — |
| judge 调用失败（A6） | invalid(judge-infra) | invalid(judge-infra) | 与现状一致，只是从 error 改名 |
| 插件安装失败（A7 的一种） | invalid(install) | invalid(install) | 与 `.eval/plugin-check-2026-09-26/SUMMARY.md` 的人工归因"无法执行-环境"一致 |
| 其他异常（A7） | invalid(harness-exception) | invalid(harness-exception) | — |
| stderr 命中限流或连接中断签名（429、rate limit、ECONNRESET） | invalid(rate-limit) | — | 现状混在 error 或 fail 里 |
| `require_plugins` 不满足（新） | invalid(precondition) | — | 现状表现为 `tools_called` 失败，记到了插件头上 |
| mock 没有对应的送达证据（新，§6） | — | invalid(delivery-missing) | 故障没送达，结论不成立（K4） |
| trace 有坏行（新，§6） | invalid(trace-integrity) | invalid(trace-integrity) | 断言建立在残缺数据上 |

`require_plugins` 的检查沿用 README 已有的挂载验证方式：每次 run 执行一次 `dsh --profile <p> --dump-config`（`README.md:23`），确认声明的插件都在其中。

**重跑策略。**

- `retries` 只补测 invalid attempt（validity 通道的"补测"），上限不变；`rate-limit` 采用指数退避。
- fail 不重跑：被测结论一次给出。要量抖动，用已有的 `trials`。
- 过渡开关：`retry_failures: true`（RunOptions 与工具参数）保留旧语义。开启后 manifest 写入 `retryPolicy: 'legacy-any'`，报告头部明示"通过率为 pass@(r+1) 口径"。这个开关只保留一个 minor 版本，避免长期多一个旋钮（`docs/gate-signals.md:57-58` 的极简原则）。

**可靠性。** `successRate = passes / validAttempts`；`invalidRate` 单列；valid 数小于 k 时 pass@k 为 null。K8 的例子 [pass, error, error] 在新口径下是"valid 1 次、通过 1 次、invalid 2 次"，报告写"样本不足"，而不是"成功率 0.333"。

**门禁。**

- 判定优先级：
  1. after 的仪表不健康（§5 哨兵破，或 §6 对账失败）→ INVALID；
  2. valid 用例出现 PASS→FAIL，或新增即 FAIL → FAIL；
  3. 存在 invalid 用例 → INVALID（不能为缺证据的用例出 PASS）；
  4. 有 WARN 信号 → WARN；
  5. 其余 → PASS。
- 退出码：INVALID=3（新增），FAIL=1，N/A=2，WARN=0（strict 时为 2），PASS=0。
- invalid 用例不参与 regression / improvement 比较，单列为 `invalidCases`（附原因）。baseline 不允许包含 invalid 用例（update-baseline 时检查），延续 `docs/gate-signals.md` 里"不收编"的纪律。
- 现有软信号的迁移：新语义下，"重跑后才过"只可能来自 invalid→pass，含义变成"环境不稳"，所以改名为 `validityRetries` 并归入有效性小节；错误签名聚合改为扫描 invalid attempt——#4312 那类共享态事故正应该在这里被看见。

**报告。** `summary` 为 `{ total, passed, failed, invalid, errored }`，其中 `errored` 是 `invalid` 的别名，标记为废弃；新增 `channels: { subject: {passed, failed}, validity: {invalid, byReason}, calibration: {healthy, …} }`，calibration 的内容见 §5。

### 4.3 兼容性风险

1. **retries 语义变更是本节最大的行为变化。** CI 现在靠 `retries: 1` 吸收模型抖动（`eval.yml:98`）；改完之后，抖动的用例会直接 FAIL。缓解：P1 先用 `retry_failures: true` 过渡一个版本，同时用 `trials` 量出各用例的真实成功率；确实抖动的用例改写断言，或改用 trials + Wilson 门禁（`docs/gate-signals.md:74-87` 已有这个机制）。
2. **schema 1→2。** `normalizeReport` 要兼容三个版本。schema 0/1 的 `error` 无法区分宿主崩溃和环境故障，统一映射为 `invalid(legacy-error)` 是有损的：旧 baseline 里的 error 用例将不参与回归比较。现有 baseline 全是 PASS，实际影响为 0，但应在 P1 重刷 baseline。
3. **新增退出码 3。** `eval.yml:113` 会原样透传，CI 仍然变红；任何按"非 1 即放行"处理退出码的外部消费者都需要更新。
4. **归属规则可能误判。** 插件导致宿主非零退出、但栈顶帧不在插件包内时（例如插件抛出的错误被宿主包装后重新抛出），会被记成 invalid(host-exit)。它依然不会变成 PASS（判定优先级第 3 条），只是账记错了——由 §8.1 的台账分诊纠正，报告中标注 `attribution: 'heuristic'`。
5. **`summary.errored` 有外部读取者。** update-baseline 的 PR 摘要会读它（`update-baseline.yml:86`），因此保留别名一个版本。
6. **前置检查依赖 `dsh --dump-config` 的输出格式。** 宿主升级可能改变格式；检查失败本身记为 invalid(precondition)，不会落成 pass。

## 5. 哨兵设计

### 5.1 改哪里（模块级）

| 模块 | 改动 |
| --- | --- |
| `cases/_sentinels/`（新，随包分发：`package.json` 的 `files` 已包含 `cases`） | 内置哨兵用例 yaml |
| `src/runner.ts` | `parseCase` 新增 `sentinel` 键（取值 `must-pass` / `must-fail`）和 `{{nonce}}` / `{{secret}}` 模板；`runEval` 合并哨兵集（不受 `tags` / `only` 影响），哨兵结果写入 `calibration.sentinels`，不进 summary。`loadCases`（`:204-230`）不用改：它只读一层目录，`_sentinels/` 子目录不会被误当成用例 |
| `src/sentinel.ts`（新） | 哨兵期望判定（must-pass 要求 outcome=pass；must-fail 要求 outcome=fail，invalid 也算破）；nonce 与 secret 生成（seed 记入 manifest） |
| `src/gate.ts` | after 报告中 `calibration.healthy=false`，或（schema ≥2 时）缺少 calibration 段 → INVALID |
| `src/report.ts` | 报告头部加一行"仪表健康"，附哨兵明细 |
| `.github/workflows/eval.yml` | 把 dsh 升到 ≥0.1.7-rc.2（mock 哨兵的前提）；新增离线 chaos job（不需要 key） |
| `skills/eval/SKILL.md`、`README.md` | 哨兵的语义，以及"不得删除、不得筛掉" |

### 5.2 怎么改（设计级）

**哨兵集。** 每个哨兵都是普通用例 yaml 加一个 `sentinel` 键，结构与现有用例一致：

| id | 类型 | 模式 | 成本 | 通过时证明什么 | 破了说明什么 |
| --- | --- | --- | --- | --- | --- |
| S1 mock-echo | 必过 | mock F0 | 0 token，几秒 | harness → dsh → overlay 落盘 → collector → 断言 → mock 送达，整条管线畅通 | 管线断了：宿主版本与 mock home 结构漂移、overlay 失效、collector 解析退化等 |
| S2 mock-impossible | 必不过 | mock F1 持续注入 | 0 token | 判分会对"内容没送全"说不 | 判分放水，或者 dsh 没走 mock（换了 provider） |
| S3 real-echo-nonce | 必过 | 真实 API | 约 1 万 token | 端点、凭据、配额可用（validity）；collector 能取到本次输出 | 环境故障，整次 run 的真实用例结论都不可信 |
| S4 honeypot | 必不过 | 真实 API | 约 1 万 token（检索步数受 `max_steps` 限制） | GT 不可达（R2）：校验码只存在于 harness 的可见域 | agent 能读到判分域的文件，GT 隔离被打破 |

S1 直接复用 `cases/chaos/chaos-f0-healthy.yml` 的结构：

```yaml
# cases/_sentinels/s1-mock-echo.yml
name: sentinel-mock-echo
sentinel: must-pass
prompt: |
  写一份三节分析报告。直接输出报告全文，不要调用任何工具。
mock:
  fault: F0
assert:
  turn_end: completed
  exit_code: 0
  output_contains: ["【P01】", "【P24】"]
```

S2 持续注入 F1（不设 `once`）：mock 对每个请求都只发前一半内容（`src/mock.ts:189-194`，只到 P12），而断言要求 P24：

```yaml
# cases/_sentinels/s2-mock-impossible.yml
name: sentinel-mock-impossible
sentinel: must-fail
prompt: |
  写一份三节分析报告。直接输出报告全文，不要调用任何工具。
mock:
  fault: F1
assert:
  exit_code: <以 dsh 实测为准>
  turn_end: completed
  output_contains: ["【P24】"]
```

S2 必须声明 dsh 在持续 F1 下的真实退出码：否则宿主重试耗尽后的非零退出会落进出口 A3（未声明的非零退出 → error），哨兵会因为 error 而被误判为"破"，而不是如期得到 fail。退出码先实测再写入，与 chaos 包的做法相同。

S2 还必须通过 §6 的送达对账（至少有一条 F1 送达记录），否则 outcome=invalid，哨兵记为"破"。所以"dsh 根本没打到 mock"的情形（K4）会被 S2 抓住，即使断言本身碰巧 fail 了。

S3 的 `{{nonce}}` 由 harness 为每个 attempt 生成：

```yaml
# cases/_sentinels/s3-real-echo.yml
name: sentinel-real-echo
sentinel: must-pass
prompt: "请原样回复这串字符，不要调用任何工具：{{nonce}}"
assert:
  turn_end: completed
  tools_exact: []
  output_contains: ["{{nonce}}"]
```

S4 蜜罐：harness 在 `output_dir` 下、agent workspace 之外写入 `.expected/<runId>.json`，其中包含 `{{secret}}`。这个位置与真实 GT（用例目录、`baseline/report.json`）处于同一可达范围，所以它的可达性可以代表 GT 的可达性。prompt 只说"本机某处有本次评测的校验码，找到并回复"，断言 `output_contains: ["{{secret}}"]`。隔离正确时这个任务不可能完成；在断言之前，secret 只存在于 harness 内存和这个蜜罐文件中。S4 是单向的绊线：它通过了就证明有泄漏；它没通过，并不能证明隔离是好的。

**运行语义。**

- 每次 `eval_run` 都执行哨兵：mock 类（S1、S2）总是执行；真实类（S3、S4）只在用例集里有真实 API 用例时执行。`tags` / `only` 不筛哨兵；用了筛选的 run 在 manifest 中记为 `partial: true`。
- 先跑哨兵，后跑主体。必过哨兵（S1、S3）破了就中止 subject 用例，记为 invalid(aborted)，省下 token；必不过哨兵（S2、S4）破了照常跑完，因为问题出在判分或隔离上，主体结果保留下来供诊断，但 gate 判 INVALID。
- 哨兵结果写入 `calibration.sentinels[]`，每项为 `{ name, kind, expected, outcome, invalidReason?, ok }`；`calibration.healthy` 等于全部 ok。
- 哨兵不进 summary，不进 gate 的逐用例比较，也不与 baseline 比较（每次独立判断，不存在"较 baseline 增多"的问题）。任何一个哨兵不 ok → gate INVALID，阻断发布。
- 与探针的分工：哨兵检查"环境与管线是否健康"，是 run 级的健康位；§6.3 的探针 agent 检查"每条用例的判分会不会被已知放水方式骗过"，是用例级的判别力。两者都属于 calibration 通道。

### 5.3 兼容性风险

1. **宿主版本是前置条件。** mock home 的结构锚定 dsh 0.1.7-rc.2（`src/runner.ts:311`、`:337`），CI 装的却是 0.1.1-rc.2（`eval.yml:84`）。S1、S2 进入 `eval.yml` 之前，必须先升级 CI 的 dsh 并重刷 baseline（dsh 版本变化本身只是 informational，见 `docs/gate-signals.md:62-72`）。在此之前，mock 哨兵只在离线 chaos job 中启用。
2. **成本。** S3 + S4 每次约 2 万 token，相对 baseline 12 条合计 122,467 token 增加约 16%；S1、S2 零 token，各几秒。
3. **对单测的冲击。** `tests/runner.spec.ts` 用 fake dsh（不连 mock）跑 runEval，内置哨兵会让这些测试全部变成 INVALID。因此需要 `RunOptions.sentinels: false`，只开放给程序调用，不进工具参数；关闭时报告记 `calibration.skipped=true`，gate 一律判 INVALID——不提供"跳过但放行"的组合。
4. **模板冲突。** 现有用例中没有 `{{`（已检索），没有冲突；但以后用例作者如果需要在 prompt 里写字面的 `{{`，需要转义规则。
5. **哨兵自己也可能抖动。** S3 走真实 API，失败按 invalid 处理，允许一次补测（§4 的 retries 新语义），连续失败才判为"破"。
6. **告警疲劳。** 哨兵破直接阻断，而不是 WARN。这与 `docs/gate-signals.md:14-20` "WARN 会被烧掉"的判断一致：哨兵破是"仪表坏了"的直接证据，不属于需要"较 baseline 增多"才报警的软信号。

## 6. 证据对账设计

### 6.1 改哪里（模块级）

| 模块 | 改动 |
| --- | --- |
| `src/types.ts` | 新增 `EvidenceRecord`、`AssertionVerdict`；`AttemptResult` 增加 `evidence[]`、`verdicts[]`；`RunReport` 增加 `reconciliation` 段 |
| `src/collector.ts` | 记录帧的 `seq`（`ToolCallRecord`、`ToolResultRecord` 增加 `seq`，另记 `finalTextSeq`、`turnEndSeq`）；顺带采集 `source.provider` / `source.model`，供 §7 使用 |
| `src/assert.ts` | `checkAssertions`（`:23-136`）改为产出结构化 verdict（带支撑帧的 seq），`failures: string[]` 变成投影；新增结果态断言 `workspace_file_contains`；导出 `assertionStrength(evalCase)` |
| `src/reconcile.ts`（新） | attempt 级与 run 级对账 |
| `src/runner.ts` | 采集证据（trace 路径与 sha256、进程事实、mock 送达、judge 调用、workspace 文件摘要）；mock 送达对账（`:963-994`）；judge 判 PASS 也留痕（推翻 `:930` 的既有取舍）；run 结束前执行 run 级对账 |
| `src/gate.ts` | 处理 removed 用例与 partial run（`:121-123`）；`reconciliation.ok=false` → INVALID |
| `.github/workflows/eval.yml` | 主仓库在 push 到 main 或定时触发时缺 key 直接失败（`:88`、`:104`）；上传证据包（摘录，不含原始 trace） |
| `tests/probes/`（新）、`tests/probes.spec.ts`（新） | 探针 agent（do-nothing、parrot 等，见 §6.3），单测与 in-band 校准共用 |

### 6.2 怎么改（设计级）

**数据模型。**

```ts
interface EvidenceRecord {
  id: string                 // 'ev:<case>#a<n>:<kind>:<k>'
  kind: 'trace' | 'process' | 'mock-delivery' | 'judge' | 'workspace' | 'install'
  path?: string              // 相对 output_dir 的路径
  sha256?: string            // trace 或 workspace 文件的摘要
  facts: Record<string, unknown>
  // 例：{events, skippedLines} / {exitCode, timedOut} / {fault, endpoint, witnesses} / {model, verdict, replyExcerpt}
}
interface AssertionVerdict {
  id: string                 // 'v:<case>#a<n>:<assertKey>[<i>]'
  assertion: string          // 'output_contains[0]'、'tool_result_contains[0]'、'delivery'、'output_judge' …
  result: 'pass' | 'fail' | 'invalid'
  evidence: string[]         // 至少一个 EvidenceRecord.id
  frames?: number[]          // 支撑判定的 trace 帧 seq（例如命中的 tool/result）
  detail?: string            // 即现在 failures[] 里的文案
}
```

**对账规则（default-deny）。**

| 规则 | 内容 | 违反时 | 堵住的现状问题 |
| --- | --- | --- | --- |
| E1 一判一证 | 每个 verdict 至少引用一条存在的 evidence | 该 verdict → invalid | 判分与证据脱钩 |
| E2 结果信号下限 | 每条 subject 用例至少有一个"结果型"断言：`tool_result_contains`、`workspace_file_contains`，或期望串不在 prompt 里的 `tool_args_contains` / V4。host 用例用 V2 + V1 + 送达证据满足 | 解析期报错（P0 只告警，P1 起强制） | K1 弱断言、K2 复述 |
| E3 送达对账 | mock 用例必须有与声明的 fault / api 一致的送达记录（`once` 时首个请求为声明的 fault） | attempt → invalid(delivery-missing) | K4 |
| E4 judge 留痕 | judge 判 PASS 和判 FAIL 都记 evidence（模型、base URL、回复摘录） | 没有记录的 judge verdict → invalid | `src/runner.ts:930` PASS 不留痕 |
| E5 trace 完整 | 用于判分的 trace 必须 `skippedLines=0` | attempt → invalid(trace-integrity) | 现状只在 gate 里按增量给 WARN（`src/gate.ts:117-119`） |
| E6 用例平账 | run 级：筛选后加载的用例集 = 报告中的用例集；每条用例都有 outcome；每个 attempt 至少一条 evidence。与现有的 summary↔cases 校验（`src/gate.ts:501-504`）、attempt 连续性校验（`:424-430`）合并为 `reconciliation` 段 | `reconciliation.ok=false` → gate INVALID | — |
| E7 缺席不是通过 | gate：baseline 有、本次没有的用例，如果用例集 digest（§7.1）没变 → INVALID；digest 变了（有意删改）→ WARN 并要求重刷 baseline；`partial` run 不出 PASS | — | K6 |
| E8 不跑不是绿 | CI：主仓库在 push 到 main 或定时触发时缺 key → job 失败；只有 fork 允许跳过，并输出 `EVAL_SKIPPED=1` | — | `eval.yml:88`、`:104` |

E2 里"期望串不在 prompt 中"由 `assertionStrength` 静态判定：把每个 V4 与 `tool_args_contains` 的期望串拿到 prompt 里做字面检索；如果全部命中，且没有 `tool_result_contains` 或 workspace 断言，就标为 `answer-in-prompt`。期望串在 prompt 里的 `tool_args_contains` 不算结果信号——parrot 把整段 prompt 塞进参数即可命中（§6.3）；`no_tool_errors` 也不算，调用成功但答非所问的 agent 能过它。对现有 12 条用例，它会标出除 `read-image`、`read-image-oversized` 以外的 10 条，与 parrot 探针的 10/12 一致。

**用例改写方向（P0 用例加固的例子）。** P0 只用现有断言类型（`tool_result_contains` 已足以让 parrot 0/12，见 `plans/TASK-p0-case-hardening.md`）；下面提到的 `workspace_file_contains` 随 P1-4 引入。

- `02-fs-write-read`：增加 `tool_result_contains: [{name: read, contains: FSMARK-9c2e}]` 和 `workspace_file_contains: [{path: marker.txt, contains: FSMARK-9c2e}]`。
- `01-bash-tool`：让期望串由执行派生、不在 prompt 中字面出现，例如命令改为 `printf '%s' QkFTSE9LLTdmM2E= | base64 -d`，断言 `BASHOK-7f3a`，并加上对 bash 的 `tool_result_contains`。
- `09-subagent`、`10-workflow`：用 `tool_result_contains` 绑定子代理或工作流的返回结果。
- `skills/eval/SKILL.md:53-54` 的指导同步改为："输入数据写进 prompt；期望串由执行派生，并配结果型断言"。

### 6.3 已知放水方式表（D2 初版，每行绑定探针）

| verifier | 放水方式 | 现状防线 | 设计防线 | 探针 agent |
| --- | --- | --- | --- | --- |
| V4 文本 | 期望串在 prompt 中，复述即过 | 无 | E2 + 用例改写 | parrot |
| V1 / V6 | 断言集只有终态或资源上限 | 无 | E2 | do-nothing |
| V3 工具序列 | 点名调用、参数是垃圾、结果报错 | `no_tool_errors`（只有 2 条用例启用） | E2（V5 或 workspace 断言） | parrot |
| V5 参数 | 把 prompt 原文塞进参数，命中 `tool_args_contains` | 无（01 号用例会被 parrot 穿透） | 期望串派生化 + `tool_result_contains` | parrot |
| V4 子串 | 回复里罗列大量候选词 | 无 | 期望串用高熵 nonce；用 `output_not_contains` 配反例 | lister（罗列 prompt 中的全部 token） |
| V7 工具错误 | 工具报错后 agent 绕开，凭 prompt 作答 | `no_tool_errors`；gate 的 `toolErrorRecoveries` 只 WARN | E2 | parrot |
| V8 judge | 迎合 rubric 的措辞 | TPR/TNR 校准（不强制） | 强制校准 + 自一致性（P2） | rubric-echo（复述 rubric） |
| mock 证据 | 宿主没打 mock，却产出期望终态 | 无 | E3 | forge-f5 |
| 进程 | 宿主中途被杀，已落盘的残缺 trace 被判过 | 超时记 error（A1） | E5 + 三通道 | truncated-trace（写残缺尾帧） |
| gate | 用例缺席、run 被筛选、没有 key | 筛选无命中即 throw | E6–E8 | gate 单测 |
| TPS 锚点 | 回复包含该词即算命中 | 无 | 改为回复 trim 后等于该词（或首行等值） | —（TPS 不在 C2 范围） |

**探针 agent 的形态。** 它不需要真实 dsh，只是一个按 dsh 命令行协议（`--version` 探针，以及 `--profile` / `--patch` / `<prompt>`）落 session 日志的脚本。附录 A 给出本次核实用的 do-nothing、parrot、forge-f5 实现。有两种用法：

1. **单测**：`tests/probes.spec.ts` 对 `cases/real`、`cases/plugins` 跑全部探针，断言"每个探针在每条 subject 用例上都 fail"。这是 C2 的回归保护。
2. **in-band**：每次 `eval_run` 先用探针跑一遍本次的用例集（毫秒级，零 token），被任一探针穿透的用例记入 `calibration.weakCases[{case, probe}]`。P0 只告警（现有 10 条需要改写）；P1 起按"较 baseline 增多才阻断"的口径进入 gate（新增 weak case → INVALID），与 `docs/gate-signals.md` 的增量原则一致。

### 6.4 兼容性风险

1. **报告体积。** 每个 attempt 增加约 10–30 条 verdict 与 evidence，`report.json` 预计变为原来的 2–3 倍，仍远小于 trace。
2. **严格化带来的红。** E2 会让现有 10 条真实用例，以及 3 条只断言 `tools_called` 的插件冒烟用例（如 `cases/plugins/dsh-agent-teams/agent-teams-smoke-status.yml`）不达标。必须先改写用例，再开启强制（P0 告警，P1 强制）；改写后要重刷 baseline（真实 API）。
3. **E4 推翻既有取舍。** `src/runner.ts:930` 的"pass 用例不留 judge 痕迹"被推翻，报告里会出现 judge 的理由，需要同步修改 README（`README.md:82-90`）。
4. **E5 依赖 collector 对坏行的定义**（`src/collector.ts:61-73`）。dsh 如果引入非 JSON 行，会被误判为残缺。现有 baseline 12 条的坏行都是 0，风险低；gate 已有的坏行增量信号可以作为早期预警。
5. **E7 改变现行协议。** README 目前规定"删用例只 WARN"（`README.md:308`）；改后，删用例的 PR 需要同时刷新 baseline。这是有意的纪律成本。
6. **E8 对 fork 的影响。** 规则需要用 `github.repository` 限定在主仓库，否则 fork 自己的 main 也会变红。
7. **证据包隐私。** trace 含真实工具输出（`eval.yml:115` 注释里的顾虑）。上传的只是被 verdict 引用的帧摘录，并截断文本（沿用 `src/collector.ts:136` `TOOL_ERROR_MAX` 的做法）。
8. **workspace 断言的时序。** `workspace_file_contains` 要在 attempt 结束后、下个 attempt 清空之前读取 workspace。清空发生在 attempt 开头（`src/runner.ts:844-849`），时序上可行；每条用例独占 workspace，并发不受影响。

## 7. run manifest 与 report schema 设计

### 7.1 run manifest

#### 改哪里（模块级）

| 模块 | 改动 |
| --- | --- |
| `src/manifest.ts`（新） | 收集环境收据，计算 digest（用 `node:crypto`，保持零依赖） |
| `src/runner.ts` | `runEval` 开始时（`:811-812` 之后）收集静态收据；attempt 级附加动态收据（mock home 锁文件 digest、观测到的模型）；结束时写 `manifest.json` 并内嵌进报告 |
| `src/collector.ts` | 采集 `assistant/message` 的 `data.message.source.{provider, model}`（K10） |
| `src/judge.ts` | 暴露 judge 配置快照：模型、base URL、温度、系统提示词的 sha256 |
| `src/gate.ts` | 新增 `compareManifests(before, after)` 可比性检查 |
| `src/report.ts` | 报告头部打印 harness 版本、manifest 摘要、模型、用例集 digest |
| `src/runner.ts` 的 `parseCase` | `mock.plugins` 没有钉版本时报错（`:107-111`） |

#### 怎么改（设计级）

| 字段 | 内容 | 来源 | 现状 |
| --- | --- | --- | --- |
| `runId` | uuid | 新生成 | 无 |
| `harness.version` | 包版本 | `src/runner.ts:19` | 已有（报告的 `version`），但 gate 不比较（K9） |
| `harness.commit`、`harness.dirty` | git HEAD；工作区是否干净 | `git rev-parse`（可选：插件安装形态没有 `.git` 时缺省） | 无 |
| `harness.lockSha256` | `pnpm-lock.yaml` 的摘要 | 文件 | 无 |
| `runtime` | node 版本、platform、arch | `process` | 无 |
| `host.dshVersion` | `dsh --version` 首行 | `src/runner.ts:274` | 已有 |
| `host.dshBin`、`host.dshEntrySha256` | 配置的命令；解析到的入口文件摘要 | `which` + realpath | 无 |
| `host.homeMode` | `isolated`（mock）/ `shared`（真实） | runner | 无（把 R2 的风险点显式化） |
| `host.mockHomeAnchor` | mock home 结构锚定的 dsh 版本（目前是 0.1.7-rc.2） | 常量（`src/runner.ts:311`、`:337`） | 只写在注释里 |
| `plugins[]` | 声明的 spec、是否钉死、安装后 profile 锁文件的摘要 | `mock.plugins` + 隔离 home 的 `pnpm-lock.yaml` | 无 |
| `models[]` | 实际被调用的 `provider/model` 及出现次数 | trace（K10） | 无 |
| `judge` | 模型、base URL、温度、系统提示词摘要；对应校准记录的摘要（§8.5 P2-3） | `src/judge.ts:28-32`、`:54-55`、`:69` | 无 |
| `cases.files[]`、`cases.caseSetDigest` | 每个用例文件的 sha256；排序后的整体摘要；`filters`、`partial` | 文件 | 无 |
| `options` | concurrency、retries 与 `retryPolicy`、trials、passK、timeoutMs、profile | RunOptions | 部分（只有 profile） |
| `seed` | harness 侧随机源的种子（nonce、哨兵 secret） | 新增 | 无 |
| `modelSampling` | 固定写 `uncontrolled`（dsh 不暴露 seed） | 声明 | 无（这是一个诚实字段） |
| `ci` | `GITHUB_RUN_ID`、`GITHUB_SHA`、`ImageOS`、`ImageVersion` | 环境变量（只取这些名字） | 无 |
| `network` | `mock-only` / `real-api`；代理是否被清除 | runner | 无 |

**绑定方式。** `manifest.json` 与 `report.json` 放在同一目录；报告内嵌 `manifest` 和 `manifestSha256`（对规范化后的 JSON 求摘要）。分数与收据由此绑定：gate 读报告时校验 `manifestSha256` 与内嵌 manifest 是否一致，不一致就报 `eval_gate: invalid report`，与现有 schema 校验共用一个出口（`src/gate.ts:265-269`）。

**可比性检查（gate）。**

| 差异 | 处理 | 理由 |
| --- | --- | --- |
| dsh 版本 | informational（不变） | 沿用 `docs/gate-signals.md:62-72` 的决定 |
| harness 的 minor / major 版本 | WARN `BASELINE_STALE` | 断言与判分口径可能变了（例如 pass^k 的口径变化，`docs/gate-signals.md:86-87`）。现有 baseline 0.3.1 对比 0.6.0 就属于这种情形（K9） |
| `caseSetDigest` | WARN `CASE_SET_CHANGED`，并接管 E7 | 用例改了而 baseline 没刷，比较的是不同口径 |
| `models` 集合 | WARN `MODEL_CHANGED` | 插件的结论会随模型变化；dsh 默认模型漂移是最隐蔽的口径变化 |
| `retryPolicy`、trials | WARN | pass@1 与 pass@(r+1) 不可比 |
| before 没有 manifest（旧报告） | informational："baseline 无收据，可比性未知" | 不因旧 baseline 而阻断 |

#### 兼容性风险

1. **隐私。** manifest 会进入 CI artifact（公开仓库）。只记录相对路径和摘要；环境变量只记录白名单中的 CI 元数据，绝不记录任何 key 类变量；`dshBin` 如果包含用户目录的绝对路径，只记 basename 和摘要。
2. **插件安装形态。** 通过 `dsh plugin add github:…` 安装时没有 `.git` 和 `pnpm-lock.yaml`，相应字段缺省，不报错。
3. **告警量增加。** `BASELINE_STALE` 在现状下会立刻触发（baseline 是 0.3.1），应与 P1 的 baseline 重刷同时上线。
4. **钉版本校验是破坏性变更。** 它会拒绝未钉版本的 `mock.plugins` 写法。仓库现有用例都已钉死（`@x.y.z` 或 tarball sha），没有存量冲击；但对外部用户是破坏性变更，需要在 CHANGELOG 中标注。
5. **模型身份依赖 trace 帧形状**（`data.message.source`）。形状变化时字段缺省，并在 manifest 中标 `modelsObserved: false`，不阻断。

### 7.2 report schema

#### 改哪里（模块级）

| 模块 | 改动 |
| --- | --- |
| `src/types.ts` | `RunReport` v2：新增 `construct`、`protocol`、`results`、`baselines`、`knownDefects` |
| `cases/<suite>/_suite.yml`（新，可选）+ 用例的 `measures` 字段 | 构造声明的来源；`loadCases` 跳过 `_` 开头的文件 |
| `src/stats.ts`（新） | Wilson 双侧区间、Fisher 精确检验（适合小样本，零依赖） |
| `src/report.ts` | `report.md` 按五段重排 |
| `src/gate.ts` | `normalizeReport` 支持 v2；trials 用例的 regression 判定使用显著性检验 |
| `README.md`、`update-baseline.yml`（`:80-104` 的 PR 摘要脚本） | 文档与消费方同步 |

#### 怎么改（设计级）

| 段 | 字段 | 来源 | 现状 |
| --- | --- | --- | --- |
| 构造声明 | `construct.statement`（测什么能力）、`subject`（plugin / host）、`inScope` / `outOfScope`；用例级 `measures` | `_suite.yml` + 用例 | 无；能力描述散在 README 和用例注释里（例如 `cases/real/12-read-image-oversized.yml:21-23`） |
| 协议 | `manifestSha256` + 摘要（n、trials、retryPolicy、seed、哨兵集、探针集、断言下限版本） | §7.1 | 部分（profile、dshVersion） |
| 结果 | 只含 subject 通道的 valid attempt：用例 outcome；suite 通过率 p̂ 及 Wilson 95% 双侧区间；trials 用例的 p̂、方差 p̂(1−p̂)/n 与 Wilson 区间；与 baseline 的差异检验（两边 n≥2 时用单侧 Fisher；n=1 时标注"单次观测，不做显著性"） | `src/stats.ts` | 部分（trials 指标，`src/reliability.ts`） |
| 基线 | `floor.doNothing`、`floor.parrot`（§6.3 探针在本次用例集上的得分）、`ceiling.oracle`（参考轨迹回放得分，§8.5 P2-4）；派生 `effectiveRange = ceiling − max(floor)` | calibration 通道 | 无 |
| 已知缺陷 | `[{ id, title, impact: {metric, value, basis}, ledgerRef? }]`：自动项（weakCases、哨兵历史、invalid 率）+ 人工项（`docs/known-defects.yml`） | calibration + 人工 | 散在 README 和文档里，没有量化 |

`report.md` 的结构：头部五行（构造 / 协议 / 结果 / 基线 / 已知缺陷，各一句结论）→ 结果表 → 有效性 → 仪表健康 → 明细。用本次核实的数字示意头部：

> 结果：12/12（Wilson 95%：0.76–1.00）｜基线：do-nothing 0/12、parrot 10/12、oracle 12/12 → 有效判别区间 2 条｜已知缺陷：answer-in-prompt 10 条（parrot 可过）

#### 兼容性风险

1. **消费方。** `update-baseline.yml:80-104` 直接读取 `summary.*`、`c.status`、`c.attempts`、`c.flaky`、`c.tokens.total`。v2 把这些字段保留为投影，持续一个 minor 版本。
2. **测试同步。** `tests/report.spec.ts` 对 md 文本有断言，重排后需要更新。
3. **单次 run 的局限。** 显著性检验只在 trials≥2 时有意义。CI 现在是单次 run，结果段会大量出现"单次观测"。这是如实呈现，不是缺陷；要得到显著性就要提高 trials，成本随之线性增长。
4. **叙事"缩水"。** `floor.parrot` 进报告后，现有 12/12 的叙事会变成"判别区间 2 条"。这正是本设计的目的，但需要在 README 中解释口径，避免被误读为退化。
5. **`_suite.yml` 的文件约定。** `loadCases` 读取目录下全部 `*.yml`（`src/runner.ts:211`），如果不排除，构造声明文件会被当成用例解析并报错。所以必须同时引入"`_` 开头的文件不是用例"的约定。仓库现有用例没有以 `_` 开头的文件名，没有存量冲突。

## 8. 分期路线（含台账互通）

### 8.1 缺陷台账互通设计

#### 改哪里（模块级）

| 模块 | 改动 |
| --- | --- |
| `src/ledger.ts`（新） | 从 v2 报告生成台账候选条目；按 SCHEMA v1 做字段白名单校验 |
| `scripts/ledger-export.mjs`（新） | 命令行入口：`--report`、`--ledger-root`、`--phase`；复制证据包，写候选文件 |
| `docs/ledger-mapping.md`（新） | 映射规则与人工补全清单 |
| repo-quake 侧 | 不改代码；校验复用其 `bin/ledger-check`；fault.type 新词按其约定先登记到 SCHEMA |

#### 怎么改（设计级）

分类沿用 SCHEMA 的三问顺序，与三通道一一对应：

| SCHEMA 的判定问题 | harness 的通道与信号 | class | id 前缀 | status |
| --- | --- | --- | --- | --- |
| 1. 预期故障送达了吗？没送达、夹具构造错、变量没钉死 | validity 通道的 invalid（install、precondition、delivery-missing、rate-limit、timeout 等）；manifest 可比性被破坏（`BASELINE_STALE`、`MODEL_CHANGED`） | `experiment-invalid` | RQ-X | `n-a`（SCHEMA 强制） |
| 2. 送达了，但异常来自证人或判分器 | calibration 通道：哨兵破、weakCases（被探针穿透）、judge 校准不达标、黄金样本漂移 | `instrument-defect` | RQ-I | `open` |
| 3. 送达了、证人在场、被测违反合同 | subject 通道里对账通过的 valid fail | `target-finding` | RQ-F | `open` |

字段映射：候选条目只填 harness 能测到的字段，"解释"留给人。

| 台账字段 | 来源 | 自动 / 人工 |
| --- | --- | --- |
| `id` | 留空：台账 id 全局只增，harness 不分配 | 人工或台账工具 |
| `created` | 导出日期 | 自动 |
| `phase` | 固定为 `dsh-eval`，或由 `--phase` 指定（满足"小写字母、数字、连字符"的约束） | 自动 |
| `class`、`status` | 见上表 | 自动 |
| `title` | 模板 + x/N，例如"dsh-eval 2026-11-02：bash-tool 有效 attempt 0/3 通过（tool_result_contains bash）" | 自动出初稿，人工可改 |
| `target` | F 类：`{repo: 被测插件仓库或宿主仓库, artifact: 工具或功能, version: 钉死的 spec 或 dshVersion}`；I 类：`{repo: BiBoyang/dsh-eval-harness, artifact: 用例文件或 src 模块, version: harness version@commit}` | 自动 |
| `fault` | F 类（chaos）：`type` 由 mock fault 映射（F1–F3 → `stream-interruption`，F4/F5 → `truncation`），`spec` 取 failures，`delivery` 取 `mockDelivery` 摘要（去掉端口），`path_relation` 缺省为 `unknown`；F 类（回归）：`type` 由失败断言的类别映射（如 `tool-error`、`missing-output`）；I 类：`validator-blind-spot`（被探针穿透）、`false-positive`（必不过哨兵通过了）、`grader-over-constraint`（必过哨兵因断言而失败） | 自动 |
| `cells` | chaos 的宿主矩阵：`{host: dsh, model: manifest.models, runs: valid attempt 数, detected, levels?}`；回归失败可以省略（SCHEMA：有宿主矩阵时才必填） | 自动 |
| `observation` | chaos：`detected`（exit 1 / max-tokens）；`recovered`（F1–F3 的 once 场景：首个请求是故障、之后为 F0 且 completed，由 `mockDelivery` 序列证明）；`reported` 需要 L2 级判定，没测就不写（SCHEMA："没测的不写"） | 自动 |
| `attribution` | F 类必填，但它"是解释不是测量"，harness 不填 | 人工 |
| `evidence` | 证据包复制进台账仓库后的相对路径 | 自动 |
| `upstream` | — | 人工 |
| `lesson` | 必填的一行提炼 | 人工 |

**输出格式。** 候选文件 `ledger-candidates.json` 外层是一层 harness 元数据，内层 `entry` 只包含 SCHEMA 字段（SCHEMA 规定"未列出的字段一律视为错误"）：

```json
{
  "ledgerSchema": 1,
  "source": { "runId": "…", "reportSha256": "…", "harness": "0.7.0@abc1234" },
  "candidates": [
    {
      "entry": {
        "created": "2026-11-02", "phase": "dsh-eval", "class": "experiment-invalid", "status": "n-a",
        "title": "…", "evidence": ["runs/dsh-eval-2026-11-02-1a2b3c4d/report.json"]
      },
      "dedupeKey": "experiment-invalid|install|routing-suite-chaos-f0",
      "needs": ["id", "lesson"]
    }
  ]
}
```

**证据包。** `ledger-export` 把 `report.json`、`report.md`、`manifest.json`、对账段，以及被 verdict 引用的帧摘录复制到 `<ledger-root>/runs/dsh-eval-<日期>-<runId 前 8 位>/`，候选条目的 `evidence` 指向这些路径；`ledger-check` 会以台账仓库根目录为基准检查它们是否存在。不能只链接 CI artifact，因为它的保留期只有 14 天（`eval.yml:123`）。

**去重。** 如果台账里已有同一 `dedupeKey`（class + target.artifact + fault.type + 用例）的 open 条目，就不生成新条目，而是生成"追加 cells / evidence"的建议（SCHEMA 规则 6：同一处伤在不同宿主上的结果记在同一条目里）。只在 gate 判 FAIL 或 INVALID、或者显式调用时导出，避免每日定时 run 刷屏。

#### 兼容性风险

1. **跨仓 schema 耦合。** 台账 schema v1 一旦变更（新增必填字段、改枚举），导出器就会产出非法条目。导出器锁定 `ledgerSchema: 1`，版本不符时拒绝导出。
2. **台账仓库体积。** `ledger-check` 要求证据实体存在，台账仓库会随导出增长；只复制摘录可以控制规模。
3. **隐私。** 证据包会离开 dsh-eval-harness 的 CI 边界。只带被引用帧的截断摘录，不带完整 trace（与 `eval.yml:115` 的原则相同）。
4. **人工补全之前，候选条目本身不合法**（缺 `id`、`lesson`，F 类还缺 `attribution`），不能直接拼进 `ledger.json`。这是有意的设计：SCHEMA 明确"归因是解释不是测量"，并要求"宁缺勿编"。
5. **fault.type 新词。** `stream-interruption`、`tool-error`、`missing-output` 需要先在台账 SCHEMA 的"已用"清单中登记。SCHEMA 的约定是先改 SCHEMA、再改校验器、最后改数据，所以这一步必须在 repo-quake 侧先完成。

### 8.2 排序依据：缺陷对分数偏差的放大倍数

| 缺陷 | 本次量化 | 放大机制 | 修复成本 | 期 |
| --- | --- | --- | --- | --- |
| 期望串在 prompt 中 / 断言没有结果信号（K1、K2、K15） | parrot 10/12；弱用例上 do-nothing 1/1；7 组插件中有 5 组整体损坏时 CI 仍是绿的 | 不解题的 agent 得分下界为 83%，12 条里只有 2 条能区分"真解题"；插件回归在门禁上的检出面只剩 2/7 | 低：改写用例 + 静态检查 + 探针单测 | P0 |
| 缺证据仍通过（K4、K6、CI 无 key） | 伪造终态的 dsh 通过 F5 阳性对照；缺席用例 exit 0；无 key 时 job 是绿的 | 触发一次，整包或整次 run 都是假绿（放大到 suite 规模） | 低 | P0 |
| fail 也重跑（K7） | CI `retries: 1` | 回归后单次成功率 p′=0.7 时，单次 run 抓到 FAIL 的概率 (1−p′)^(r+1) 从 0.30 降到 0.09，检出率降为原来的 1/3.3 | 中：依赖三通道，否则 infra 抖动会直接打红 CI | P1 |
| error 与 fail 混账（K5、K8） | [pass, error, error] → 0.333 | infra 故障按被测失败计（此例低估 3 倍），或者被 retries 洗成 flaky pass | 中：schema v2 | P1 |
| 没有收据 / baseline 陈旧（K9、K10） | baseline 0.3.1 对 0.6.0 仍判 PASS | 不同口径的两次 run 被当作同口径比较，偏差方向不定 | 中 | P1 |
| 没有哨兵 | — | 仪表与环境故障和被测故障分不开，所有结论的可信度没有下限 | 低（mock 哨兵）/ 中（真实哨兵 + CI 宿主升级） | P0（mock）/ P1（真实） |
| 没有基线、区间、显著性 | — | 分数没有参照系，造成误读而不是偏差 | 中 | P2 |
| judge 不强制校准（C4） | 目前没有用例启用 | 当前为 0；启用后作用于全部 judge 用例 | 中 | P2 |
| 台账互通 | — | 不改变单次分数，影响跨期累积和归因 | 中 | P2 |

### 8.3 P0：止血——缺证据不得通过，量出判分地板

| 项 | 内容 | 对应设计 |
| --- | --- | --- |
| P0-1 证据对账 MVP | E3 送达对账（P0 先以 `error` + `delivery-missing` 原因落地，不升 schema）；E4 judge 留痕；E7 缺席用例不再 exit 0（P0 先以 FAIL 落地）；E8 CI 无 key 规则（限定主仓库） | §6 |
| P0-2 探针与静态检查 | `tests/probes/`（do-nothing、parrot、forge-f5）+ `tests/probes.spec.ts`；`assertionStrength` 只告警、不阻断 | §6.3 |
| P0-3 用例加固 | 改写 10 条 answer-in-prompt 用例；修改 `skills/eval/SKILL.md:53-54` 的指导；由 Owner 触发 update-baseline 重刷 baseline | §6.2 |
| P0-4 mock 哨兵（离线） | S1、S2 + 报告的 `calibration` 段（schema 1 上的可选字段）+ gate 对哨兵破的阻断；新增离线 chaos CI job（dsh 0.1.7-rc.2，不需要 key） | §5 |
| P0-5 D1 活文档 | 把 §3.1 总表移入 `docs/`，新增 verifier 或用例类型时复检；PR 模板引用 | §3 |

派发：P0 已拆成四份任务契约，分两批执行（详见 `plans/TASK-p0-*.md`）。批次 1 为 `TASK-p0-probe-agents`（P0-2、P0-5）与 `TASK-p0-evidence-floor`（P0-1），两者文件零重叠；批次 2 为 `TASK-p0-case-hardening`（P0-3，依赖 probe-agents）与 `TASK-p0-mock-sentinels`（P0-4，依赖前两者）。forge-f5 探针随 E3 一起归入 `TASK-p0-evidence-floor` 验收。

DoD：

1. 探针单测：do-nothing 和 parrot 在 `cases/real` 上全部 fail（0/12）；forge-f5 在 `cases/chaos` 上得到非 pass。
2. `assertionStrength` 对 `cases/real` 报出 0 条 answer-in-prompt。
3. mock 用例没有送达记录时 outcome 不是 pass；gate 对缺席用例的退出码不为 0。
4. 离线 chaos job：S1、S2 健康，6 条 chaos 全绿；人为把 S1 的 fault 改成 F1 后，gate 退出码不为 0（阳性对照）。
5. 新 baseline 入库（真实 API），人工复核清单增加 PASS trace 抽查。

验收方式（实施后可执行）：

```bash
pnpm build && pnpm lint
CI=1 pnpm exec vitest run tests/probes.spec.ts tests/runner.spec.ts tests/gate.spec.ts
node --input-type=module -e "import { loadCases } from './lib/runner.js'; import { assertionStrength } from './lib/assert.js'; const cs = await loadCases('cases/real'); const weak = cs.filter((c) => assertionStrength(c.evalCase).answerInPrompt); console.log('answer-in-prompt', weak.length); process.exit(weak.length === 0 ? 0 : 1)"
node --input-type=module -e "import { runEval } from './lib/runner.js'; const r = await runEval({ casesDir: 'cases/chaos', outputDir: '/tmp/p0-chaos' }); console.log(JSON.stringify(r.calibration)); process.exit(r.calibration.healthy ? 0 : 1)"   # 需本机 dsh ≥0.1.7-rc.2，不需要 key
gh workflow run update-baseline.yml   # Owner 执行（真实 API）
```

回滚：每一项单独提交；E3、E7 的严格化各有单测，回滚即 revert 对应提交。P0 不升 schema。

### 8.4 P1：分账——三通道、收据、真实哨兵、全量对账

| 项 | 内容 | 对应设计 |
| --- | --- | --- |
| P1-1 三通道 schema v2 | §4 全部：retries 只补测 invalid（带 `retry_failures` 过渡开关）；reliability 只计 valid；gate 新增 INVALID（exit 3） | §4 |
| P1-2 run manifest | §7.1 全部；gate 可比性检查；`mock.plugins` 钉版本校验 | §7.1 |
| P1-3 真实哨兵 | S3、S4 + nonce / secret 模板；CI 的 dsh 升到 ≥0.1.7-rc.2，S1、S2 也进入 `eval.yml` | §5 |
| P1-4 全量证据对账 | E1、E2（强制）、E5、E6；collector 记录帧 seq；`workspace_file_contains`；weakCases 按增量进 gate | §6 |
| P1-5 R2 隔离（六项之外，建议并行） | 真实模式也生成隔离 `DSH_HOME`（沿用 `.eval/plugin-check-2026-09-26` 里"隔离 home + 真实端点"的做法）；workspace 移到仓库树之外（如系统临时目录）；以 S4 作为验收绊线 | R2 |

DoD：

1. 报告 `schemaVersion=2`，包含 `channels`、`manifest`、`calibration`、`reconciliation`；`loadReport` 能读 0/1/2 三个版本（含 legacy error→invalid 的映射）。
2. 用 fake dsh 夹具分别模拟超时、无 trace、宿主非零退出、安装失败、限流 stderr，各自得到 §4.2 表中的 outcome 与 invalidReason。
3. gate：invalid 用例不进 regression；任一哨兵破或对账失败 → INVALID，exit 3。
4. 用 0.3.1 的旧 baseline 对新报告跑 gate → WARN，并含 `BASELINE_STALE`；重刷 baseline 后 → PASS。
5. 记录 S4 蜜罐在当前目录布局下的表现；P1-5 完成后再跑一次，作为 R2 改造的对照。

验收方式：

```bash
pnpm build && pnpm lint && CI=1 pnpm test
node --input-type=module -e "import { runEval } from './lib/runner.js'; const r = await runEval({ casesDir: 'cases/real', outputDir: '.eval/out', concurrency: 3 }); console.log(r.summary, r.calibration.healthy, r.reconciliation.ok)"   # 真实 API，需要 DEEPSEEK_API_KEY
node --input-type=module -e "import { computeGate, loadReport } from './lib/gate.js'; const g = computeGate(await loadReport('baseline/report.json'), await loadReport('.eval/out/report.json'), false); console.log(g.verdict, g.exitCode, g.reasons)"   # 旧 baseline 下期望含 BASELINE_STALE
```

### 8.5 P2：报告与外部互通

| 项 | 内容 | 对应设计 |
| --- | --- | --- |
| P2-1 report schema 全量 | 构造声明、Wilson / Fisher、floor 与 ceiling 并排、已知缺陷量化 | §7.2 |
| P2-2 台账互通 | 导出器 + 映射文档；fault.type 新词先在 repo-quake SCHEMA 登记 | §8.1 |
| P2-3 judge 强制校准（C4） | 校准记录绑定 judge 模型与提示词摘要；`output_judge` 用例运行时找不到匹配的校准记录 → invalid(judge-uncalibrated)；`eval_judge_validate` 增加"每条重复 k 次"的自一致率 | §4、§7.1 |
| P2-4 oracle（D3） | 每条用例配参考轨迹（`cases/<suite>/_oracle/<case>.jsonl`），由人工复核过的通过 trace 脱敏生成，沿用 `scripts/gen-fixtures.mjs` 的脱敏思路；离线回放必须被 verifier 接受，由此得出 `ceiling.oracle` | §7.2 |
| P2-5 离群人审（C3） | 报告增加"人审抽样"段：tokens / steps 最高与最低的 PASS、全部 FAIL、全部 invalid 各取摘录；update-baseline 的 PR 模板加"PASS 抽查"项 | §7.2 |

DoD：

1. `report.md` 头部五段齐全，结果段带区间；基线段给出 do-nothing、parrot、oracle 三个数。
2. `ledger-export` 对夹具报告产出候选条目；人工补全字段后的样例能通过 repo-quake 的校验器。
3. 未校准的 judge 用例 outcome=invalid；校准报告包含 `selfConsistency`。
4. oracle 回放：每条用例的参考轨迹 100% 通过；篡改参考轨迹的关键帧后，对应断言 fail（阳性对照）。

验收方式：

```bash
CI=1 pnpm exec vitest run tests/stats.spec.ts tests/ledger.spec.ts tests/oracle.spec.ts tests/judge.spec.ts
node scripts/ledger-export.mjs --report tests/fixtures/ledger/report.v2.json --ledger-root /tmp/ledger-sandbox --phase dsh-eval
python3 /Users/boyang/repo-quake/bin/ledger-check tests/fixtures/ledger/completed-sample.json --root tests/fixtures/ledger
```

### 8.6 覆盖矩阵（六项 × 三期）

| 设计项 | P0 | P1 | P2 |
| --- | --- | --- | --- |
| 三通道（§4） | 不改模型；mock 送达缺失先记 error + 原因 | schema v2 全量 | 在报告各段呈现 |
| 哨兵（§5） | S1、S2 离线 | S3、S4 真实 + 进主 CI | 哨兵历史进已知缺陷 |
| 证据对账（§6） | E3、E4、E7、E8 + 探针 | E1、E2、E5、E6 强制 | 证据包供台账使用 |
| run manifest（§7.1） | — | 全量 + 可比性检查 | 进报告的协议段 |
| report schema（§7.2） | `calibration` 段（可选字段） | `summary.invalid`、`channels`、`reconciliation` | 五段全量 |
| 台账互通（§8.1） | — | — | 导出器 |

每一期都可以独立验收：P0 不升 schema、不依赖三通道；P1 不依赖 P2 的统计与导出；P2 的各项彼此独立。

### 8.7 13 条清单的关闭计划

| 清单项 | 现判定 | 关闭于 | 关闭条件 |
| --- | --- | --- | --- |
| D1 | 缺失 | P0 | §3 的总表作为活文档入库，PR 模板引用 |
| D2 | 部分 | P0 | §6.3 放水表的每一行都有探针或单测 |
| D3 | 部分 | P2 | oracle 回放 100% 通过，并有阳性对照 |
| R1 | 部分 | P1 | manifest 记录 digest、锁文件、模型；限流显式记为 invalid(rate-limit) 并退避 |
| R2 | 部分 | P1 | S4 蜜罐常驻；P1-5 完成真实模式的 home 隔离与 workspace 外移 |
| R3 | 部分 | P1 | seed 入 manifest，judge 留痕；真实 API 的非确定性以 trials + 区间呈现，并如实声明"无法消除" |
| C1 | 缺失 | P0 | do-nothing 探针单测 + S2 必不过哨兵 |
| C2 | 缺失 | P0 | parrot 等探针单测 + in-band weakCases |
| C3 | 部分 | P2 | 报告人审抽样段 + PR 模板 |
| C4 | 部分 | P2 | 强制校准 + 自一致率 |
| P1 | 部分 | P2 | 区间 + 显著性检验 |
| P2 | 缺失 | P2 | floor 与 ceiling 并排呈现 |
| P3 | 部分 | P2 | 已知缺陷带量化进报告 |

## 附录 A：核实命令与探针复现

全部命令都在仓库根目录或 `/tmp/ehd-probe` 下执行：只读仓库，输出全部落在 `/tmp`。结果见 status 文件 step 1。

```bash
pnpm lint
CI=1 pnpm exec vitest run tests/assert.spec.ts tests/gate.spec.ts tests/reliability.spec.ts tests/judge.spec.ts tests/report.spec.ts tests/runner.spec.ts
./node_modules/.bin/tsc -p tsconfig.json --outDir /tmp/ehd-probe/lib && cp package.json /tmp/ehd-probe/package.json
cd /tmp/ehd-probe && node probes/agents.mjs && node probes/static.mjs && node probes/gate-parrot.mjs && node probes/gate-single-plugin.mjs
```

要复制 `package.json`，是因为 `src/runner.ts:19` 按 `../package.json` 读取 harness 版本。

探针 agent（伪造 dsh，`/tmp/ehd-probe/bin/fake-dsh.mjs`）：

```js
#!/usr/bin/env node
// PROBE_MODE：do-nothing | parrot | forge-f5；只写 overlay 指定的 session 根
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const argv = process.argv.slice(2)
if (argv[0] === '--version') { console.log('0.0.0-probe'); process.exit(0) }
const overlay = argv[3]                 // dsh --profile <p> --patch <overlay> <prompt>
const prompt = argv[4] ?? ''
const root = JSON.parse(/^\s+root: (".*")$/m.exec(readFileSync(overlay, 'utf8'))[1])
const dir = join(root, 'case', 'session-probe')
mkdirSync(dir, { recursive: true })
const mode = process.env.PROBE_MODE
let seq = 0, step = 0, exit = 0, finalText = '', turnEnd = 'completed'
const frames = [{ type: 'session', version: 0, id: 's', createdAt: 1, cwd: '/x', delegationDepth: 0 }]
const ev = (type, data) => frames.push({ type, seq: ++seq, time: 1, data })
if (mode === 'parrot') {
  // 按 prompt 中「<name> 工具」的字样依序调用（去重），参数为整段 prompt，结果一律报错
  const tools = [...new Set([...prompt.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*工具/g)].map((m) => m[1]))]
  for (const name of tools) {
    step++
    const callId = `c${step}`
    ev('tool/call', { turn: 1, step, callId, name, arguments: JSON.stringify({ input: prompt }) })
    ev('tool/result', { turn: 1, step, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'simulated: invalid arguments' }], isError: true }], role: 'user', id: `r${step}` } })
    ev('step/end', { turn: 1, step })
  }
  finalText = prompt                    // 最终回复 = 复述 prompt
} else if (mode === 'forge-f5') {
  turnEnd = 'max-tokens'                // 不连 mock，直接伪造 F5 的期望终态
  exit = 1
}
step++
ev('assistant/message', { turn: 1, step, message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } })
ev('step/end', { turn: 1, step })
ev('turn/end', { turn: 1, reason: { kind: turnEnd } })
writeFileSync(join(dir, 'session.jsonl'), frames.map((f) => JSON.stringify(f)).join('\n') + '\n')
process.exit(exit)
```

驱动方式：`runEval({ casesDir, outputDir: '/tmp/…', dshBin: '/tmp/ehd-probe/bin/fake-dsh.mjs' })`，分别设置 `PROBE_MODE` 运行；forge-f5 另加 `only: ['chaos-f5-think-only']`。单插件损坏的场景：把 baseline 中该插件对应的用例替换为 parrot 结果，再调用 `computeGate(before, after, false)`（与 `eval.yml:110` 相同）。

建模假设：parrot 的工具结果一律是报错，这是保守设定。如果工具对垃圾参数也返回成功，`read-image` 两条仍会因为 `tool_result_contains` 而 fail，其余 10 条照样通过，结论不变。

## 附录 B：未核实项与局限

- 本机没有安装 dsh。chaos 与 plugins 用例的行为结论来自 README（`README.md:150-160`）和本地未入库的 `.eval/plugin-check-2026-09-26/SUMMARY.md`，本次没有重跑。
- GT 可达性（R2）是按路径推断的"可达"，没有观察到 agent 真的读取了它；S4 蜜罐的作用就是把它变成可观测的事实。
- §8.2 中 retries 的放大倍数是按 (1−p′)^(r+1) 计算的模型值，不是实测值。
- token 成本估算基于 baseline（dsh 0.1.1-rc.2，2026-08）；升级宿主或更换模型后需要重估。
- 探针运行在用 `tsc --outDir` 编译出的 `src` 副本上，与 CI 构建的 `lib/` 同源，但不是同一份产物；仓库里被 `.gitignore` 忽略的 `lib/` 没有被读取，也没有被修改。
