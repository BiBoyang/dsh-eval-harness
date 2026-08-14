# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

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
