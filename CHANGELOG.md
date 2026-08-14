# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

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
