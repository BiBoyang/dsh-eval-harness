<h1 align="center">dsh-eval-harness</h1>

<p align="center">DSH 插件/skill 作者的回归评测门禁：写 yaml 用例 → headless 驱动真实 agent 跑 → 解析 session trace 断言 → 对比 baseline 出 PASS/WARN/FAIL 报告与 CI 退出码。</p>

## 简介

给 DSH 插件/skill 的回归评测流程提供一个可进 CI 的门禁工具：

1. 用 yaml 写评测用例（prompt + 期望行为断言）；
2. `eval_run` 逐条 fork `dsh --profile headless --patch <overlay> <prompt>` 子进程跑真实 agent（overlay 把会话落盘切到隔离目录，每条用例独立 workspace），解析落盘的 `session.jsonl` / `session.jsonl.zstd` trace（多帧 zstd 直读），执行断言，写 `report.json` + `report.md`；
3. `eval_gate` 把本次报告与 baseline 报告对比，输出 `OVERALL=PASS|WARN|FAIL|N/A` 与退出码，供 CI 拦截回归。

## 安装

```sh
dsh plugin --profile headless add github:boyang/dsh-eval-harness
# 验证挂载
dsh --profile headless --dump-config | grep dsh-eval-harness
```

## 能力面

### Tools

| 工具 | 说明 |
| --- | --- |
| `eval_run` | 跑 cases_dir 下全部用例：headless 驱动真实 agent → 采集 session trace → 断言 → 写 report.json/report.md |
| `eval_gate` | 对比 baseline 与本次报告，输出门禁判定（OVERALL/EXIT_CODE），strict 模式收紧 WARN 退出码 |

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
```

报告里的 token 是分字段聚合：`total (in X+out Y+reas Z; cacheR A+cacheW B)`——prompt cache
命中时 `inputTokens` 只剩零头、真实输入在 `cacheReadTokens`，分字段展示让 cache
命中情况一眼可见。`max_tokens` 对 `total`（input+output+reasoning）生效：cacheRead 是
多步会话里同一段缓存的重复读回，计入会让上限随步数膨胀，故只展示、不计入。

示例见 [`cases/example.case.yml`](cases/example.case.yml)。
[`cases/real/`](cases/real/) 收录了 11 条针对真实插件（bash/fs/search/todo/web_search/subagent/workflow 等）的实测用例，全部在真实 agent 回合中验证过；
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

输出：JSON 文本（summary + 报告路径 + 各用例状态）。错误一律 throw
`eval_run:` 前缀消息（找不到 dsh 可执行文件、用例解析失败等）。

### eval_gate

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `before` | string | 否 | - | baseline report.json 路径；缺省或文件不存在 → N/A |
| `after` | string | 是 | - | 本次 report.json 路径 |
| `strict` | boolean | 否 | `false` | strict 模式下 WARN 退出码为 2 |
| `gate_json` | boolean | 否 | `false` | true 时输出单条 JSON（供 CI 解析），否则 key=value 文本 |

## gate 协议

判定规则（优先级从高到低）：

| 条件 | 判定 | 退出码 |
| --- | --- | --- |
| 有用例 PASS → FAIL/error，或新增用例即 FAIL/error | `FAIL` | 1 |
| 有用例 FAIL/error → PASS，或用例数量变化（新增通过/移除） | `WARN` | 0（strict 为 2） |
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
REASON regression: echo-hello pass -> fail
REGRESSION echo-hello: pass -> fail
```

`gate_json=true` 时输出单条 JSON（含 `verdict`/`exitCode`/`reasons`/`regressions` 等字段）。

## CI 集成

真实 workflow 见 [.github/workflows/eval.yml](.github/workflows/eval.yml)：`pnpm build && pnpm test`
后直调 `lib/runner.js` 的 `runEval` 跑 `cases/real/` 全量（真实 LLM，需仓库 secret
`DEEPSEEK_API_KEY`），再用 `lib/gate.js` 的 `computeGate` 对比 `baseline/report.json`，
按 `EXIT_CODE` 拦截；report 作为 artifact 留存。用例或 harness 代码变更会触发重跑。

`baseline/report.json` 已入库（首轮全量评测人工复核：`read-image` 在无视觉能力模型上
预期 fail，见上）。用例/断言口径变更时须重跑全量、人工复核后更新 baseline，否则 gate
会把口径变化判成 WARN/FAIL。

## session trace 说明

评测依赖 DSH 落盘的会话 trace（默认 `$DSH_HOME/sessions/<cwd编码>/<session-id>/session.jsonl[.zstd]`，
每行一帧信封 `{ type, seq, time, data }`）。`eval_run` 不污染环境变量，而是生成一个
`--patch` overlay（`<output_dir>/eval-overlay.patch.yml`），按 row id 整体替换 base bundle 的
`session-persistence-jsonl` 配置：把 `root` 切到隔离目录（默认 `<output_dir>/.sessions`，可用
`session_root` 覆盖）；每条用例再以独立 workspace 作 cwd（session 按 cwd 编码分目录）。
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
pnpm lint      # biome check（仅 lint，format 未启用）
```

## 插件管理

已装插件用 plugin-registry 的**薄控制台**管理（浏览器面板）：管理 profile
插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：
`dsh plugin --profile web add <plugin-registry>/packages/plugin/console`
