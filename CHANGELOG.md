# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.4.0] - 2026-08-26

### Fixed

- `passPowK` 改用无偏组合估计 C(c,k)/C(n,k)（旧版为 plug-in (c/n)^k：x^k 上凸，
  Jensen 不等式保证向上偏，如 n=3,c=2,k=2 时旧值 4/9 vs 无偏 1/3）——与 pass@k
  的估计口径对齐。**口径变化**：新旧报告的 passPowK 数值不可直接比。
- 每次 attempt 使用独立的 session 根与 overlay（`.sessions/<用例>/attempt-<N>`）：
  不再靠 wall-clock 时间窗（sinceMs）隔离不同 attempt 的 trace——被 kill 进程的
  延迟落盘可能越过时间窗边界；sinceMs 过滤保留为第二道防线。

### Added

- 可靠性测量（trials / pass@k / pass^k）：用例 yaml 新增 `trials`（正整数，缺省用
  `eval_run` 的全局 `trials`，默认 1）。`trials > 1` 时用例跑满 n 次独立 attempt
  （每次前清空 workspace、忽略 retries——测量必须是无重试干预的原始单次成功率），
  `CaseResult` 新增 `reliability`（successRate / passAtK / passPowK，pass@k 用无偏
  组合估计而非小 n 下有偏的 naive 公式），report.md 用例表新增可靠性列。用例状态
  语义与 retries 对齐（任一通过即 pass），gate 判定不变——可靠性只测量展示。
  `eval_run` 新增 `pass_k`（默认 2），k 不得超过被测量用例的有效 trials。
- judge 校准：新增 `eval_judge_validate` 工具——在人工标注 JSONL（每行
  `{"rubric", "output", "expect"}`）上跑 judge，报混淆矩阵并**分开**给 TPR
  （真失败抓到率）与 TNR（真通过不冤枉率），双指标达标（默认 0.9/0.9）才算
  calibrated；agreement 不作为依据（高 pass 占比下橡皮图章 judge 也能拿高分），
  缺样本的维度记 null 且整体不达标。判定与标注不一致的条目进 `mismatches`。
- 新用例 `12-read-image-oversized`：钉死 deepseek-harness#2626 的修复契约——边长超
  2000px 的图片须在准入时降采样并在结果文本声明（`downscaled from …`）。红绿已实测：
  dsh 0.1.1-rc.2 PASS（降采样并标注），0.1.0-rc.6 FAIL（原尺寸入历史、无标注）。
- 报告记录 dsh 版本：`RunReport` 新增 `dshVersion`（`dsh --version` 探针 stdout 首行，
  写入 report.json 与 report.md 头部）；排障时可直接区分「dsh 变了」还是「模型变了」。
  legacy / 旧 schema 1 报告缺省该字段，loader 兼容读取。
- gate 新增 skippedLines 回归告警：用例 `skippedLines` 较 baseline 增长（trace 解析
  漏帧增多，断言可能基于残缺数据通过）记 WARN；文本输出新增 `SKIPPED_LINE_INCREASES` /
  `SKIPPED_LINE_INCREASE` 行，JSON 新增 `skippedLineIncreases` 字段。
- gate 新增四路「软信号」，把抓上游并发 bug（deepseek-harness Discussions #4312）
  过程中的人肉环节固化成自动告警（设计理由与权衡见 `docs/gate-signals.md`）：
  - flaky 门禁级告警：新增 flaky 用例（重跑后才过）较 baseline 增多记 WARN；
    baseline 残留的 flaky 用例以 `baselineFlakyCases` 提示（纪律：flaky 不收编进
    baseline）。文本输出 `FLAKY` / `FLAKY_CASE` 行。
  - 工具错误自我纠正告警：pass 但 `toolErrors` 非空（agent 吞掉/绕过工具硬错误）
    的用例较 baseline 新增记 WARN。文本输出 `TOOL_ERROR_RECOVERIES` /
    `TOOL_ERROR_RECOVERY` 行。
  - stderr 错误签名聚合：新增 `src/error-signature.ts`，从失败 attempt 的
    `stderrTail` 提取 `<错误码>@<栈顶应用帧函数>` 签名并跨用例/跨 attempt 聚合，
    同一签名 ≥2 次记 WARN（「崩在同一处」的共享态事故信号）且 report.md 出
    「错误签名聚合」小节。文本输出 `REPEATED_ERROR_SIGNATURES` / `ERROR_SIGNATURE` 行。
  - dsh 版本切换提示：`dshVersion` 较 baseline 变化时输出 informational reason 与
    `DSH_VERSION_CHANGED=X -> Y` 行（不影响判定——跨版本结果不可直接比，但版本
    切换是高频合法事件）。
  - report.md 汇总行在存在 flaky 用例时附 flaky 计数。
  - 端到端验证锚点：以 `.eval/v0.3.2-candidate` → `v0.3.2-candidate2` 的历史报告
    跑 gate，可自动报出 `ENOENT@ensureSymlink` 聚合签名、2 条新 flaky 与版本切换——
    即 #4312 若发生在本版本之后，门禁会自己喊出来。
- gate 新增 trials 可靠性门禁（`eval_gate` 参数 `min_trial_success_rate`，0-1，
  缺省关闭）：带 reliability 的用例若 successRate 的**单侧 95% Wilson 下界**低于
  阈值记 WARN（`unreliableCases`；文本输出 `UNRELIABLE` / `UNRELIABLE_CASE` 行）。
  判下界不判点估计（「成功率不低于阈值」是单侧问题）；默认关闭以保留「trials
  只测量」语义，strict 模式下 WARN 退出码为 2 即硬门槛。设计理由见
  `docs/gate-signals.md` 第 5 节。

### Changed

- judge 输出格式翻转为「先简短分析、末行 PASS/FAIL」（CoT 在前）：先下结论再补理由
  的格式会让理由沦为事后粉饰。`parseJudgeReply` 取最后一个非空行作判定。
  **行为变化**：同一回答的判定可能与旧格式不同，上 judge 前先用 `eval_judge_validate`
  校准。
- 教学渠道同步：README 新增「judge 使用与校准」工作流（写 rubric → 攒标注集 →
  校准 → 进门禁 → 重校时机）；eval skill 新增 judge 校准与 trials/retries 语义
  辨析；`cases/example.case.yml` 附 output_judge 注释示例，新增
  `examples/judge-labels.example.jsonl` 标注集格式示例（随包发布）。
- `package.json` 声明 `engines.node >= 22.15.0`：采集层依赖 `node:zlib` 内置的
  zstd 解压（22.15/23.8 起可用），旧 LTS 上会直接不可用。
- CI 评测的 dsh 版本钉 0.1.0-rc.6 → **0.1.1-rc.2**（eval.yml / update-baseline.yml，
  含 npm 缓存 key）；#2626 修复在该版本合入，是 `12-read-image-oversized` 的前置条件。
- CI 评测步开 `retries: 1`（eval.yml 与 update-baseline.yml 口径一致）：偶发网络/模型
  抖动重跑一次，flaky 标记与 attempt 历史仍留在报告里供排查。

## [0.3.1] - 2026-08-24

### Fixed

- dsh 子进程非零退出不再可能判 PASS：trace 断言全过但进程 `exitCode !== 0` 时按
  `error` 处理（错误消息附 stderr 尾部），走正常 `retries` 重跑逻辑；version probe
  被信号杀死或非零退出时也会在跑用例前直接报错，不再拖到逐条用例失败。
- 超时用例的部分 trace 采集现在同时带进程诊断字段（`exitCode` / `timedOut` /
  `stderrTail`），排查超时原因不用再去翻子进程日志。

### Added

- report schema 版本化：`report.json` 写入 `schemaVersion: 1`。`eval_gate` 严格校验
  当前 schema——未知未来 schema、重复用例名、非法状态、token 字段或 summary 不一致
  一律以 `eval_gate: invalid report:` 前缀报错拒绝比较；未带 `schemaVersion` 的旧版
  baseline 按 legacy schema 0 兼容读取，并为新增诊断字段补安全默认值。
- `CaseResult` 新增 `attemptResults`（`AttemptResult[]`）：按执行顺序保存每次 attempt
  的状态、断言失败、进程诊断、trace 摘要（events/skippedLines）、token 与耗时；顶层
  字段继续表示最后一次 attempt，兼容现有 gate 与报告消费者。report.md 失败明细新增
  exit code / timed out / stderr 行与「Attempt 历史」小节，汇总表新增 events/skipped
  列与结束时间、总耗时。
- CI：新增快速质量 workflow `.github/workflows/ci.yml`（push / PR 跑
  `pnpm install --frozen-lockfile` + build + test + lint，无需真实 LLM 与 API key）。
- `baseline/report.json` 更新为 schemaVersion 1 全量重跑结果（11 条全 PASS，人工复核通过）。

### Changed

- 用例口径：`cases/real/08-read-image.yml` 由刻意的负向用例转正——`tool_result_contains`
  改为断言 `read_image` 成功结果文本含 `1x1`（此前硬编码期待「模型无视觉能力」报错文本，
  在具备图像能力的模型上永远 FAIL）。视觉模型上应 PASS；无视觉模型上 `read_image` 报错，
  `no_tool_errors` 与本断言同时 FAIL，回归拦截语义不变。
- lint 收紧：`pnpm lint` 改为 `biome check --error-on-warnings`，存量 warning 清零；
  `biome.json` 适配新版 `preset: "recommended"` 写法。

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
