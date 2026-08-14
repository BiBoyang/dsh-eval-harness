# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.3.0] - 2026-08-15

### Added

- LLM-as-judge 语义断言：用例 yaml 的 `assert.output_judge.rubric`（必填非空）。
  定位「结构断言优先、judge 兜语义」——attempt 只有结构性断言全过后才调 judge
  （判 FAIL 理由进 `failures`，判 PASS 不留痕迹）；judge 调用失败（HTTP 错误/
  超时/解析失败/无 key）按 `error` 处理，可被 `retries` 覆盖。实现零依赖
  （Node 内置 fetch 调 OpenAI 兼容接口），配置走环境变量 `EVAL_JUDGE_API_KEY`
  （回落 `DEEPSEEK_API_KEY`）/ `EVAL_JUDGE_BASE_URL` / `EVAL_JUDGE_MODEL`，
  `eval_run` 工具参数面不变。
- flaky 治理（失败才重跑）：用例 yaml 新增 `retries`（非负整数，缺省用
  `eval_run` 的全局 `retries`，默认 0 不重跑）。单条用例最多跑 `retries+1`
  次，任一 attempt 断言全过即停；fail 和 error（含超时）都触发重跑，最终
  状态取最后一次 attempt。每次 attempt 前清空重建该用例的 workspace（防
  上一次 attempt 的 fs 副作用让重跑假通过），session 根复用并按 attempt
  起点过滤只采集本次 trace。`CaseResult` 新增 `attempts`（实际执行次数）
  与 `flaky`（最终 pass 但中途有失败 attempt 时 true），report.md 状态列
  标记 `PASS (flaky, N attempts)`。
  - 口径变化：`durationMs` 改为全 attempt 总耗时（含重跑），让 flaky 的真实
    成本可见；gate 不读该字段，不受影响。
- CI：eval workflow 增加每日定时跑（02:00 Asia/Shanghai，近 24h 无新 commit 则跳过）；
  新增 update-baseline workflow（workflow_dispatch 手动触发：全量重跑 → 覆盖
  `baseline/report.json` → 开 PR 附报告摘要供人工复核，不自动合入）。
- 并行跑用例：`eval_run` 新增 `concurrency`（默认 1 串行）。每条用例改为独占一份
  overlay（`eval-overlay-<序号>-<用例名>.patch.yml`）与 session 根（`<session_root>/<序号>-<用例名>`，
  序号是加载序——slug 化不是唯一键），并行时互不干扰；report 用例顺序仍与 cases
  目录文件序一致。用例名重名直接报错（gate 按 name 对比 baseline）。
- 用例筛选：用例 yaml 新增 `tags` 字段；`eval_run` 新增 `tags` / `only`（逗号分隔，
  交集，筛选后无命中直接报错防 CI 空跑假绿）。
- token 回归门禁：`eval_gate` 新增 `max_token_increase_pct`（默认 50，0 关闭）——
  状态不变的用例 token total 涨幅超阈值记 token 回归（WARN），文本输出新增
  `TOKEN_REGRESSIONS` / `TOKEN_REGRESSION` 行，JSON 新增 `tokenRegressions` 字段。
- CI 评测步开 `concurrency: 3`。

## [0.2.0] - 2026-08-14

### Added

- 多帧 zstd 直读：`session.jsonl.zstd`（拼接帧容器）由 collector 按魔数自动识别、
  逐帧解压直读（零外部依赖，仅 Node 内置 `node:zlib`）；残缺尾帧用 `ZSTD_e_flush`
  尽力恢复。eval_run 的 overlay 不再强制 `compression: none`。
- 真实落盘帧契约快照：`tests/fixtures/real-session.jsonl(.zstd)`（真实会话脱敏）
  + 快照测试锁死 `tool/result` 三种形状（成功 / `data.error{name,code}` / 纯
  `isError`）、`assistant/message` usage、`tool/call` 序列。
- 超时兜底：用例子进程超时（SIGKILL）时尽力采集已落盘的部分 trace 写进 report，
  供排查超时原因。
- 断言增强（0.1.0 之后陆续合入）：`tools_exact` / `tools_not_called` /
  `output_not_contains` / `output_matches` / `tool_args_contains` /
  `tool_result_contains`。
- `cases/real/`：11 条针对真实插件的实测用例；`baseline/report.json` 首轮基准。
- CI：`.github/workflows/eval.yml`（真实 LLM 评测 + baseline 门禁）。

### Fixed

- `tool/result` 按真实落盘形状提取错误（`message.content[]` 的 `tool-result` 块）；
  token `total` 剔除 cache 字段防多步膨胀。
- 会话发现不再纯靠 mtime：subagent/workflow 用例会在同一 root 落下
  `delegationDepth > 0` 的子会话，多候选时父会话（depth 0）优先，避免错捡子会话
  导致假失败。
- report.json 的 `version` 改为构建时读 package.json（消除硬编码漂移）。

## [0.1.0]

首个可用版本：yaml 用例 → headless 驱动真实 agent → 采集 session trace（要求
overlay 强制 `compression: none`）→ 断言 → baseline 门禁（eval_run / eval_gate）。
