<h1 align="center">dsh-eval-harness</h1>

<p align="center">DSH 插件/skill 作者的回归评测门禁：写 yaml 用例 → headless 驱动真实 agent 跑 → 解析 session trace 断言 → 对比 baseline 出 PASS/WARN/FAIL 报告与 CI 退出码。</p>

## 简介

给 DSH 插件/skill 的回归评测流程提供一个可进 CI 的门禁工具：

1. 用 yaml 写评测用例（prompt + 期望行为断言）；
2. `eval_run` 逐条 fork `dsh --profile headless <prompt>` 子进程跑真实 agent（隔离 session_root/workspace），解析落盘的 `session.jsonl` trace，执行断言，写 `report.json` + `report.md`；
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
  max_tokens: 50000             # 可选，聚合 token（input+output）上限
```

示例见 [`cases/example.case.yml`](cases/example.case.yml)。

**解析约束**：harness 内置零依赖 YAML 子集解析器（块级 map、`- ` 标量序列、
flow 序列、引号、数字/布尔/null、`|`/`>` 块标量、注释）。不支持 `- key: value`
嵌套 map 序列、锚点、多文档；解析失败报带行号的 `eval_run:` 前缀错误。

## 工具参数

### eval_run

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `cases_dir` | string | 是 | - | 用例目录（*.yml/*.yaml） |
| `output_dir` | string | 是 | - | report.json / report.md 输出目录 |
| `session_root` | string | 否 | `<output_dir>/.sessions` | 隔离的 session 落盘根 |
| `profile` | string | 否 | `headless` | dsh profile |
| `timeout_ms` | integer | 否 | `600000` | 单条用例子进程超时 |

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

## CI 集成示例

```yaml
# .github/workflows/eval.yml（示意）
- name: Run eval cases
  run: dsh run "用 eval_run 跑 cases_dir=cases output_dir=.eval/out"
- name: Gate
  run: |
    OUT=$(dsh run "用 eval_gate 对比 before=baseline/report.json after=.eval/out/report.json gate_json=true")
    echo "$OUT"
    exit $(echo "$OUT" | node -e "process.stdin.on('data',d=>process.exit(JSON.parse(d).exitCode))")
```

首轮评测结果人工复核后，把 `report.json` 提交为 `baseline/report.json` 作为基准。

## session trace 说明

评测依赖 DSH 落盘的会话 trace（`$DSH_HOME/sessions/<cwd编码>/<session-id>/session.jsonl[.zstd]`，
每行一帧信封 `{ type, seq, time, data }`）。`eval_run` 通过 `DSH_SESSION_ROOT` 注入隔离的
session 根，并设置 `DSH_SESSION_COMPRESSION=none` 让落盘为纯 JSONL。**v0.1 不解析多帧
zstd**（`session.jsonl.zstd`），发现只有 zstd 产物时会明确报错。

## 开发命令

```sh
pnpm install   # 安装 devDependencies（typescript / vitest / @types/node）
pnpm build     # tsc → lib/（含类型声明 lib/types/）
pnpm test      # vitest run tests
```

## 插件管理

已装插件用 plugin-registry 的**薄控制台**管理（浏览器面板）：管理 profile
插件安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：
`dsh plugin --profile web add <plugin-registry>/packages/plugin/console`
