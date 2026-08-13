---
name: eval
description: Use this skill when the user wants to write regression eval cases (*.case.yml) for a DSH plugin/skill — prompt plus expected-behavior assertions consumed by the dsh-eval-harness eval_run / eval_gate tools.
metadata:
  version: "0.1.0"
---

# 编写 DSH 评测用例

帮用户为 DSH 插件/skill 写回归评测用例（yaml），由 dsh-eval-harness 的
`eval_run`（headless 驱动真实 agent 跑用例）与 `eval_gate`（baseline 门禁）消费。

## 用例文件

放 `cases/` 目录，一个文件一条用例，`*.yml` / `*.yaml`：

```yaml
name: 用例名（唯一，gate 按名字对比）
prompt: "发给 agent 的内容"
require_plugins: [some-plugin]   # 可选：声明依赖的插件（仅元信息，供阅读/环境核对）
assert:
  turn_end: completed            # turn/end 事件的 reason.kind
  tools_called: [tool_a, tool_b] # tool/call 名称序列须按序包含（保序子序列，不要求连续）
  output_contains: ["关键词1"]    # 最终 assistant 文本须包含全部关键词
  max_steps: 8                   # 可选，step/end 数上限
  max_tokens: 50000              # 可选，token 上限（input+output+reasoning；cacheRead/cacheWrite 不计入，防多步膨胀）
  no_tool_errors: true           # 可选，任何工具硬错误（tool/result 带 error/isError）即 fail
  tools_exact: [tool_a]          # 可选，工具调用名称序列须完全一致（长度+顺序+内容）
  tools_not_called: [tool_b]     # 可选，列出的工具一次都不能被调用
  output_not_contains: ["抱歉"]   # 可选，最终文本不得包含任一子串
  output_matches: ["^okay"]      # 可选，最终文本须匹配全部正则（解析期预编译，非法正则报错）
  tool_args_contains:            # 可选，指定工具至少一次调用的参数 JSON 串包含子串
    - name: tool_a
      contains: '"path"'
  tool_result_contains:          # 可选，指定工具至少一次结果的文本包含子串
    - name: tool_a
      contains: total
```

## 编写要点

- **断言写可观测行为，不写实现细节**：`tools_called` 断「必须调用什么」，不要断
  完整调用序列（保序子序列即可，agent 多调别的工具不算失败）。
  确实需要「恰好这些调用、一次不多」时才用 `tools_exact`；反向禁用某工具用
  `tools_not_called`；锁工具入参/返回内容用 `tool_args_contains` /
  `tool_result_contains`（按工具名匹配至少一次调用/结果，子串包含即可）。
- **prompt 自包含**：headless 一次性会话，没有上下文；把插件名、输入数据、
  期望输出关键词都写进 prompt。
- **`output_contains` 选稳定关键词**：挑 agent 正常完成时几乎必出现的词
  （如工具名、确定的结果串），避免整句匹配导致 flaky。
- **多行 prompt 用块标量**：
  ```yaml
  prompt: |
    第一行
    第二行
  ```
- **资源上限兜底**：每条用例都设 `max_steps` / `max_tokens`，防 agent 死循环
  烧额度；阈值取正常运行值的 2-3 倍。
- **turn_end 常规取 `completed`**；其他 kind（如 aborted/error）只在专门测
  异常路径的用例里断言。
- **用例名稳定**：gate 按 `name` 对比 baseline，改名 = 删除 + 新增（WARN）。

## 跑评测与门禁

1. `eval_run`：`cases_dir` 指用例目录，`output_dir` 收 report.json/report.md；
   可选 `session_root`（默认 `<output_dir>/.sessions`）、`profile`（默认 headless）。
2. 首轮结果人工复核后把 report.json 存为 baseline（如 `baseline/report.json` 入库）。
3. 回归时 `eval_gate`：`before` 指 baseline、`after` 指本次 report.json；
   文本输出 `OVERALL=PASS|WARN|FAIL|N/A`，`gate_json=true` 输出单条 JSON 供 CI 解析。

## 解析约束（重要）

harness 用零依赖 YAML 子集解析器：支持块级 map、`- ` 标量/map 序列（map 项续行
缩进对齐到 `- ` 之后）、`[a, b]` flow 序列、单双引号、数字/布尔/null、`|`/`>`
块标量、注释。**不支持**锚点/别名、多文档——写用例时避免。解析失败会报带行号的错误。
