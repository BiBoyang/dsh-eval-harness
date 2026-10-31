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
tags: [fast]                     # 可选：标签，eval_run 的 tags 筛选按任一命中匹配
retries: 1                       # 可选：失败重跑次数（缺省用 eval_run 全局值）
trials: 3                        # 可选：可靠性测量的独立 trial 次数（>1 时忽略 retries，
                                 # 报告给 successRate / pass@k / pass^k）
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
  output_judge:                  # 可选，LLM 语义断言（结构断言全过才调；先校准再用，见编写要点）
    rubric: "必须解释原因，不许只给结论"
```

## 编写要点

- **断言写可观测行为，不写实现细节**：`tools_called` 断「必须调用什么」，不要断
  完整调用序列（保序子序列即可，agent 多调别的工具不算失败）。
  确实需要「恰好这些调用、一次不多」时才用 `tools_exact`；反向禁用某工具用
  `tools_not_called`；锁工具入参/返回内容用 `tool_args_contains` /
  `tool_result_contains`（按工具名匹配至少一次调用/结果，子串包含即可）。
- **prompt 自包含，期望串由工具的真实结果证明**：headless 一次性会话，没有上下文；
  把插件名、输入数据都写进 prompt。期望串常常也会出现在 prompt 里（如「最终回复里
  必须包含 X」），而 `output_contains` / `output_matches` / `tool_args_contains` 都是
  字面匹配——不调工具、原样复述 prompt 的 agent 照样能过。所以每条真实 API 用例至少
  要有一条**结果型断言**：首选 `tool_result_contains`，把期望串绑到被测工具的真实返回上
  （写之前先在一次真实运行的 report.json `toolResults` 里核对原文，不要凭想象写）；
  或者让 `output_contains` / `output_matches` / `tool_args_contains` 的期望串不出现在
  prompt 字面里（必须真实执行才能得到）。`no_tool_errors`、`tools_called` 只认调用
  成功与工具名，不算结果型断言。
- **`output_contains` 选稳定关键词**：挑 agent 正常完成时几乎必出现的词
  （如确定的结果串），避免整句匹配导致 flaky。它只证明最终回复写了什么，证明不了
  工具真的执行过——期望串在 prompt 里时，必须再配一条 `tool_result_contains`。
- **断言强度有静态检查与白名单**：本仓库的 `tests/probes.spec.ts` 用
  `assessAssertionStrength`（`src/strength.ts`）扫描 `cases/` 下的用例：真实 API 用例
  没有结果型断言即判弱（期望串都能从 prompt 复述得到为 `answer-in-prompt`，只断言
  工具名 / 终态 / 资源上限为 `no-outcome-assertion`）；mock 用例没有同时声明
  `exit_code` 与 `turn_end` 即判弱。同一文件还用 parrot 探针（复述 prompt、工具结果
  一律报错）跑 `cases/real`，必须一条都过不了。判弱名单 `KNOWN_WEAK_CASES` 与实测
  **完全相等**：新用例判弱先加固，不要往名单里加；只有静态误判（期望串在 prompt 里、
  但语义上确实要执行才能得到）才留在名单里，并在该行旁写明理由；用例修好后同一个
  PR 从名单移除。另有 `tests/baseline-replay.spec.ts` 用 baseline 的真实轨迹回放当前
  断言：期望串抄错、断言收得过紧会直接变红。维护规则见 `docs/abc-checklist.md` §5。
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
- **易抖用例设 `retries: 1~2` 兜底，而不是放宽断言**：LLM 评测非确定，结构
  断言（如 `tools_exact`、正则匹配）偶发抖动时，用失败重跑保持断言严格性；
  重跑后才过的用例会在 report 里标 `flaky`，提醒排查抖动来源。
- **`output_judge` 只用于写不出正则的语义期望**：能落成 `output_contains` /
  `output_matches` 的先用结构断言（可复现、零成本）；judge 兜「解释原因而非
  只给结论」这类语义判分。rubric 要可判定（写出「必须/不许」的具体标准），
  避免主观词（如「回答要好」）——judge 按二元 PASS/FAIL 评，模糊标准只会放大抖动。
- **judge 先校准再信任**：judge 本身是个会犯错的 LLM，它的漏判会直接变成门禁的
  假绿。给任何用例挂上 `output_judge` 之前，先用 `eval_judge_validate` 在人工标注集
  上验证：标注集是 JSONL，每行 `{"rubric": "...", "output": "...", "expect": "pass"|"fail"}`，
  样本从已有报告的真实 finalText 里抽（通过的、失败的都要）。看 TPR（真失败抓到率）
  和 TNR（真通过不冤枉率）两个数，默认都要 ≥0.9；agreement 不可信（样本里 pass 占
  多数时橡皮图章 judge 也能拿高 agreement）。judge 模型更换、judge prompt 变化、
  数据分布变化后都要重新校准。
- **想量可靠性用 `trials`，想遮抖动用 `retries`**：`retries` 失败即重跑、过了就停
  （门禁不被偶发抖动打红）；`trials: n` 跑满 n 次独立尝试（每次清空 workspace、不
  重试），报告给出单次成功率与 pass@k/pass^k。两者语义互斥：trials > 1 时 retries
  被忽略。
- **用例名稳定**：gate 按 `name` 对比 baseline，改名 = 旧名缺席 + 新增；baseline
  里的用例本次缺席直接判 FAIL（exit 1）。删用例 / 改名须同 PR 刷新 baseline
  （触发 update-baseline），理由见 `docs/gate-signals.md` §6。

## 跑评测与门禁

1. `eval_run`：`cases_dir` 指用例目录，`output_dir` 收 report.json/report.md；
   可选 `session_root`（默认 `<output_dir>/.sessions`）、`profile`（默认 headless）、
   `concurrency`（并行数，默认 1）、`tags` / `only`（逗号分隔筛选，交集，无命中报错）。
2. 首轮结果人工复核后把 report.json 存为 baseline（如 `baseline/report.json` 入库）。
3. 回归时 `eval_gate`：`before` 指 baseline、`after` 指本次 report.json；
   文本输出 `OVERALL=PASS|WARN|FAIL|N/A`，`gate_json=true` 输出单条 JSON 供 CI 解析；
   `max_token_increase_pct`（默认 50，0 关闭）控制 token 涨幅回归判定（WARN）。
   gate 另有几路软信号（均较 baseline 增多才 WARN，防告警疲劳）：新增 flaky 用例、
   pass 但带工具硬错误的用例、同一 stderr 错误签名出现 ≥2 次（崩在同一处，
   疑似共享态事故）；dsh 版本切换只留 informational 痕迹（`DSH_VERSION_CHANGED` 行）。
   设计理由见 `docs/gate-signals.md`；纪律：flaky 用例不收编进 baseline。

## 解析约束（重要）

harness 用零依赖 YAML 子集解析器：支持块级 map、`- ` 标量/map 序列（map 项续行
缩进对齐到 `- ` 之后）、`[a, b]` flow 序列、单双引号、数字/布尔/null、`|`/`>`
块标量、注释。**不支持**锚点/别名、多文档——写用例时避免。解析失败会报带行号的错误。
