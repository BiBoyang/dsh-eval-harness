# dsh-eval-harness

DSH 插件/skill 作者的回归评测门禁：写 yaml 用例 → headless 驱动真实 agent 跑 → 解析 session trace 断言 → 对比 baseline 出 PASS/WARN/FAIL 报告与 CI 退出码。

## 简介

给 DSH 插件/skill 的回归评测流程提供一个可进 CI 的门禁工具：

1. 用 yaml 写评测用例（prompt + 期望行为断言）；
2. `eval_run` 逐条 fork `dsh --profile headless --patch <overlay> <prompt>` 子进程跑真实 agent（overlay 把会话落盘切到隔离目录，每条用例独立 workspace），解析落盘的 `session.jsonl` / `session.jsonl.zstd` trace（多帧 zstd 直读），执行断言，写 `report.json` + `report.md`；
3. `eval_gate` 把本次报告与 baseline 报告对比，输出 `OVERALL=PASS|WARN|FAIL|N/A` 与退出码，供 CI 拦截回归。

## 安装

已发布到 npm（[`dsh-eval-harness`](https://www.npmjs.com/package/dsh-eval-harness)）：

```sh
dsh plugin --profile headless add dsh-eval-harness
# 或从 GitHub 源码安装：
# dsh plugin --profile headless add github:boyang/dsh-eval-harness

# 验证挂载
dsh --profile headless --dump-config | grep dsh-eval-harness
```

## 能力面

### Tools

| 工具 | 说明 |
| --- | --- |
| `eval_run` | 跑 cases_dir 下全部用例：headless 驱动真实 agent → 采集 session trace → 断言 → 写 report.json/report.md |
| `eval_gate` | 对比 baseline 与本次报告，输出门禁判定（OVERALL/EXIT_CODE），strict 模式收紧 WARN 退出码 |
| `eval_judge_validate` | 在人工标注集上校准 LLM judge：报混淆矩阵与 TPR/TNR（分开看，agreement 会骗人），双指标达标才算 calibrated |

### Skills

| Skill | 作用 |
| --- | --- |
| `eval` | 教模型帮用户编写评测用例（用例格式、断言编写要点、解析子集约束） |

## 用例格式（cases/*.yml）

一个文件一条用例：

```yaml
name: 用例名                    # 唯一，gate 按 name 对比 baseline
prompt: "发给 agent 的内容"      # 多行可用块标量 `|`
require_plugins: [some-plugin]  # 可选，元信息
tags: [fast]                    # 可选，标签；eval_run 的 tags 筛选按任一命中匹配
retries: 1                      # 可选，失败重跑次数（非负整数，缺省用 eval_run 的全局 retries）
trials: 3                       # 可选，可靠性测量的独立 trial 次数（正整数，缺省用 eval_run 的全局 trials，默认 1）；
                                # trials > 1 时忽略 retries——测量必须是无重试干预的原始单次成功率
assert:
  turn_end: completed           # turn/end 事件的 reason.kind
  tools_called: [tool_a]        # tool/call 名称序列须按序包含（保序子序列）
  output_contains: ["关键词"]    # 最终 assistant 文本须包含全部
  max_steps: 8                  # 可选，step/end 数上限
  max_tokens: 50000             # 可选，token 上限（input+output+reasoning；cacheRead/cacheWrite 不计入，防多步膨胀）
  no_tool_errors: true          # 可选，任何 tool/result 硬错误（data.error / isError）即 fail
  tools_exact: [tool_a]         # 可选，工具调用名称序列须完全一致（长度+顺序+内容）
  tools_not_called: [tool_b]    # 可选，列出的工具一次都不能被调用
  output_not_contains: ["抱歉"]  # 可选，最终 assistant 文本不得包含任一子串
  output_matches: ["^okay"]     # 可选，最终 assistant 文本须匹配全部正则（解析期预编译校验）
  tool_args_contains:           # 可选，指定工具至少一次调用的参数 JSON 串包含子串
    - name: tool_a
      contains: '"path"'
  tool_result_contains:         # 可选，指定工具至少一次结果的文本包含子串
    - name: tool_a
      contains: total
  output_judge:                 # 可选，LLM 语义评审（结构断言全过后才调，判 FAIL 记 fail）
    rubric: "回答应解释原因而非只给结论"
```

**LLM-as-judge（`output_judge`）**：表达「解释原因而非只给结论」这类写不出正则的语义
期望。定位是**结构断言优先、judge 兜语义**——一个 attempt 只有结构性断言全过后才会调
judge（结构已失败不白烧 judge token）；judge 判 FAIL 时理由进该用例 `failures`
（形如 `output_judge: <理由>`），判 PASS 不留任何痕迹。judge 走 OpenAI 兼容 chat
completions 接口（零依赖，Node 内置 fetch），配置全靠环境变量：`EVAL_JUDGE_API_KEY`
（缺省回落 `DEEPSEEK_API_KEY`，两者都无时报错）、`EVAL_JUDGE_BASE_URL`（默认
`https://api.deepseek.com`）、`EVAL_JUDGE_MODEL`（默认 `deepseek-chat`）。judge 调用
本身失败（HTTP 错误/超时/回复解析失败/无 key）按 `error` 处理而非 `fail`——infra 抖动
不是断言失败，可被 `retries` 覆盖。

报告里的 token 是分字段聚合：`total (in X+out Y+reas Z; cacheR A+cacheW B)`——prompt cache
命中时 `inputTokens` 只剩零头、真实输入在 `cacheReadTokens`，分字段展示让 cache
命中情况一眼可见。`max_tokens` 对 `total`（input+output+reasoning）生效：cacheRead 是
多步会话里同一段缓存的重复读回，计入会让上限随步数膨胀，故只展示、不计入。

示例见 [`cases/example.case.yml`](cases/example.case.yml)。
[`cases/real/`](cases/real/) 收录了 12 条针对真实插件（bash/fs/search/todo/web_search/subagent/workflow 等）的实测用例，全部在真实 agent 回合中验证过；
其中 `08-read-image.yml` 演示 `no_tool_errors` 如何拦下「工具报错但 agent 兜底答对」的假通过（在无视觉能力的模型上该用例预期 fail，属正常）。

**解析约束**：harness 内置零依赖 YAML 子集解析器（块级 map、`- ` 标量/map 序列、
flow 序列、引号、数字/布尔/null、`|`/`>` 块标量、注释）。不支持锚点、多文档；
解析失败报带行号的 `eval_run:` 前缀错误。

## 工具参数

### eval_run

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `cases_dir` | string | 是 | - | 用例目录（*.yml/*.yaml） |
| `output_dir` | string | 是 | - | report.json / report.md 输出目录 |
| `session_root` | string | 否 | `<output_dir>/.sessions` | 隔离的 session 落盘根 |
| `profile` | string | 否 | `headless` | dsh profile |
| `timeout_ms` | integer | 否 | `600000` | 单条用例子进程超时 |
| `dsh_bin` | string | 否 | `$DSH_BIN` 或 `dsh` | dsh 可执行命令，按空白拆分；本机无全局 dsh 时用 `npx -y @deepseek-ai/dsh` |
| `concurrency` | integer | 否 | `1` | 并行跑用例的并发数；每条用例独占 session 根与 workspace，并行互不干扰 |
| `retries` | integer | 否 | `0` | 失败重跑的全局默认次数；单条用例最多跑 retries+1 次，任一 attempt 全过即停（fail 和 error 含超时都触发重跑）；用例 yaml 的 `retries` 优先于此值；`trials > 1` 的用例忽略重试 |
| `trials` | integer | 否 | `1` | 可靠性测量的独立 trial 次数全局默认；`> 1` 时用例跑满 n 次隔离 attempt（每次前清空 workspace、不重试），报告写入 per-case `reliability`（successRate / pass@k / pass^k），用例状态仍为任一通过即 pass |
| `pass_k` | integer | 否 | `2` | pass@k / pass^k 的 k；不得超过任何被测量用例的有效 trials，否则报错（小样本外推会给出虚假精确的数） |
| `tags` | string | 否 | - | 逗号分隔标签筛选：只跑 yaml `tags` 命中任一的用例 |
| `only` | string | 否 | - | 逗号分隔用例名（精确匹配）；与 tags 同给时取交集；筛选后无命中会直接报错（防 CI 笔误空跑假绿） |

输出：JSON 文本（summary + 报告路径 + 各用例状态）。错误一律 throw
`eval_run:` 前缀消息（找不到 dsh 可执行文件、用例解析失败等）。

`report.json` 当前写入 `schemaVersion: 1`。`eval_gate` 会严格校验当前 schema；未带
`schemaVersion` 的旧版 baseline 会按 legacy schema 0 兼容读取，并为新增的诊断字段补上
安全默认值。未知的未来 schema、重复用例名、非法状态、token 字段或 summary 不一致都会以
`eval_gate: invalid report:` 前缀报错，不会继续做门禁比较。

每条新报告用例还会写入 `attemptResults`：按执行顺序保存每次重试的状态、断言失败、
进程诊断、trace 摘要、token 与耗时；`CaseResult` 顶层字段继续表示最后一次 attempt，
兼容现有 gate 与报告消费者。旧报告没有真实 attempt 历史时，loader 会合成一条单次记录，
不会伪造旧报告不存在的重试信息。报告头部另记 `dshVersion`（`dsh --version` 探针首行），
排障时可直接区分「dsh 变了」还是「模型变了」。

`trials > 1` 的用例额外写入 `reliability`：`successRate`（单次成功率）、`passAtK`
（无偏估计 1−C(n−c,k)/C(n,k)，不用小 n 下有偏的 naive 公式）、`passPowK`（(c/n)^k）；
report.md 用例表新增「可靠性 (trials)」列。可靠性目前只做测量展示，不进门禁——
阈值等数据攒起来再定。

### eval_judge_validate

在人工标注集上校准 judge。标注集是 JSONL，每行
`{"rubric": "...", "output": "...", "expect": "pass"|"fail"}`。逐条调 judge
（配置同 `output_judge` 的环境变量）后报混淆矩阵。

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `labels_path` | string | 是 | - | 人工标注 JSONL 路径 |
| `tpr_threshold` | number | 否 | `0.9` | TPR（真失败被抓到的比例）达标线 |
| `tnr_threshold` | number | 否 | `0.9` | TNR（真通过没被冤枉的比例）达标线 |

TPR 与 TNR 分开看：标注集里 90% 都是 pass 时，什么都放行的橡皮图章 judge 也能拿
90% agreement——agreement 会骗人，所以 `calibrated=true` 要求两个指标都达标；
某一维没有对应样本（比如没标 fail）时该维记 null 且整体不达标。判定与标注不一致
的条目收在 `mismatches` 里供人工 review judge 的错法。

### judge 使用与校准（工作流）

`output_judge` 是唯一的非确定性断言——judge 本身是个会犯错的 LLM，它的漏判会直接
变成门禁的假绿。所以 judge 断言的生命周期比结构断言多两步：

1. **写 rubric**：写出「必须/不许」的可判定标准，避免主观词（「回答要好」这类只会
   放大抖动）。能落成 `output_contains` / `output_matches` 的期望不要用 judge。
2. **攒标注集**：从已有报告的 `finalText` 里抽真实输出，每条亲手标 PASS/FAIL 存成
   JSONL（格式与示例见 `examples/judge-labels.example.jsonl`）。通过的、失败的样本
   都要有——缺了 fail 样本就验证不了「judge 会不会抓失败」。
3. **校准**：`eval_judge_validate` 跑标注集，TPR / TNR 都 ≥0.9（默认阈值）才算
   calibrated；不达标先看 `mismatches` 里 judge 的错法，调 rubric 措辞再校。
4. **进门禁**：校准通过后，`output_judge` 的判定才可以信。
5. **重新校准的触发时机**：judge 模型更换（`EVAL_JUDGE_MODEL`）、harness 升级动了
   judge prompt、被评输出的数据分布明显变化（比如换了被测模型）。

### eval_gate

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `before` | string | 否 | - | baseline report.json 路径；缺省或文件不存在 → N/A |
| `after` | string | 是 | - | 本次 report.json 路径 |
| `strict` | boolean | 否 | `false` | strict 模式下 WARN 退出码为 2 |
| `gate_json` | boolean | 否 | `false` | true 时输出单条 JSON（供 CI 解析），否则 key=value 文本 |
| `max_token_increase_pct` | integer | 否 | `50` | token total（与 max_tokens 同口径）涨幅阈值百分比：状态不变的用例超阈值记 token 回归（WARN）；0 关闭 |

## gate 协议

判定规则（优先级从高到低；软信号的设计理由见 [docs/gate-signals.md](docs/gate-signals.md)）：

| 条件 | 判定 | 退出码 |
| --- | --- | --- |
| 有用例 PASS → FAIL/error，或新增用例即 FAIL/error | `FAIL` | 1 |
| 有用例 FAIL/error → PASS，或用例数量变化（新增通过/移除） | `WARN` | 0（strict 为 2） |
| 状态不变但 token total 涨幅超阈值（默认 +50%，`max_token_increase_pct` 可调，0 关闭） | `WARN` | 0（strict 为 2） |
| `skippedLines` 较 baseline 增长（trace 解析漏帧增多，断言可能基于残缺数据） | `WARN` | 0（strict 为 2） |
| 新增 flaky 用例（重跑后才过）较 baseline 增多；baseline 已有 flaky 不重复告警 | `WARN` | 0（strict 为 2） |
| pass 但带工具硬错误的用例（agent 自我纠正）较 baseline 新增 | `WARN` | 0（strict 为 2） |
| 同一 stderr 错误签名跨用例/跨 attempt 出现 ≥2 次（崩在同一处，疑似共享态事故） | `WARN` | 0（strict 为 2） |
| dsh 版本较 baseline 变化 | 仅 informational reason + `DSH_VERSION_CHANGED` 行，不影响判定 | - |
| 全部与 baseline 一致 | `PASS` | 0 |
| 无 baseline | `N/A` | 2 |

文本输出（key=value 行 + 明细行）：

```
OVERALL=FAIL
EXIT_CODE=1
STRICT=false
REGRESSIONS=1
NEW_FAILURES=0
IMPROVEMENTS=0
ADDED=0
REMOVED=0
TOKEN_REGRESSIONS=0
SKIPPED_LINE_INCREASES=0
FLAKY=0
TOOL_ERROR_RECOVERIES=0
REPEATED_ERROR_SIGNATURES=0
BASELINE_FLAKY=0
REASON regression: echo-hello pass -> fail
REGRESSION echo-hello: pass -> fail
```

`gate_json=true` 时输出单条 JSON（含 `verdict`/`exitCode`/`reasons`/`regressions` 等字段）。

## CI 集成

快速质量 workflow 见 [.github/workflows/ci.yml](.github/workflows/ci.yml)：每次 push / PR
执行 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm test`、`pnpm lint`，不需要真实
LLM 或 API key。真实 agent 回归 workflow 见 [.github/workflows/eval.yml](.github/workflows/eval.yml)：
`pnpm build && pnpm test` 后直调 `lib/runner.js` 的 `runEval` 跑 `cases/real/` 全量（真实 LLM，需仓库 secret
`DEEPSEEK_API_KEY`），再用 `lib/gate.js` 的 `computeGate` 对比 `baseline/report.json`，
按 `EXIT_CODE` 拦截；report 作为 artifact 留存。评测步开 `concurrency: 3` 与
`retries: 1`（偶发网络/模型抖动重跑一次，flaky 标记留在报告里供排查）。
用例或 harness 代码变更会触发重跑，
另有每日定时跑（近 24h 无新 commit 则跳过）。

baseline 更新走 [.github/workflows/update-baseline.yml](.github/workflows/update-baseline.yml)：
Actions 页手动触发 → 全量重跑 → 覆盖 `baseline/report.json` 并开 PR（附报告摘要），
人工复核后合并，不自动合入。

`baseline/report.json` 已入库（12 条全量重跑人工复核：全 PASS；`read-image` 仅在无视觉能力的模型上预期 fail，见上）。用例/断言口径变更时须重跑全量、人工复核后更新 baseline，否则 gate
会把口径变化判成 WARN/FAIL。

## session trace 说明

评测依赖 DSH 落盘的会话 trace（默认 `$DSH_HOME/sessions/<cwd编码>/<session-id>/session.jsonl[.zstd]`，
每行一帧信封 `{ type, seq, time, data }`）。`eval_run` 不污染环境变量，而是为每条用例生成一个 `--patch` overlay
（`<output_dir>/eval-overlay-<序号>-<用例名>.patch.yml`），按 row id 整体替换 base bundle 的
`session-persistence-jsonl` 配置：把 `root` 切到该用例的隔离目录
（`<session_root>/<序号>-<用例名>`，`session_root` 默认 `<output_dir>/.sessions`；序号是加载序，
因为 slug 化不是唯一键，如 `read image` 与 `read-image` 同 slug）；每条用例再以
独立 workspace 作 cwd。per-case session 根 + workspace 让用例可以并行跑（`concurrency`），
互不干扰；subagent/workflow 的子会话也落在同一用例的根下。用例名重名会直接报错
（gate 按 name 对比 baseline）。
子进程命令形如 `dsh --profile headless --patch <overlay> <prompt>`（launcher flags 在前，
prompt 是 app 位置参数放最后）。

collector 按文件头魔数自动识别编码：默认的多帧 zstd（`session.jsonl.zstd`）走
`decodeZstdLog` 直读（结构扫描帧边界 + 逐帧解压，零外部依赖，仅 Node 内置 `node:zlib`），
纯文本 `session.jsonl` 走 UTF-8。两种编码都能读，eval_run 不再依赖 overlay 强制
`compression: none`。真实落盘帧的契约快照见 `tests/fixtures/` 与 `tests/zstd.spec.ts`。

会话发现（findSessionFile）：subagent/workflow 用例会在同一 root 额外落下
`delegationDepth > 0` 的子会话日志；多候选时按 header 行的 `delegationDepth` 分档，
父会话（0）优先于不可解析、再优先于子会话（>0），同档取最新 mtime。

超时兜底：用例子进程超时（SIGKILL）时不再只记 error，而是尽力采集已落盘的部分
trace（残缺尾帧由 `decodeZstdLog` 恢复）写进 report，供排查超时原因；采集失败
不掩盖超时本身。

## 开发命令

```sh
pnpm install   # 安装 devDependencies（typescript / vitest / biome / @types/node）
pnpm build     # tsc → lib/（含类型声明 lib/types/）
pnpm test      # vitest run tests
pnpm lint      # biome check --error-on-warnings（仅 lint，format 未启用）
```

## 插件管理

已装插件用 plugin-registry 的**薄控制台**管理（浏览器面板）：管理 profile
插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：
`dsh plugin --profile web add <plugin-registry>/packages/plugin/console`
