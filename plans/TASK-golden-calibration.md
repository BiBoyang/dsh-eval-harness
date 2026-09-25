# TASK-golden-calibration：真实 API 黄金样本 + mock 保真校准

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-golden-calibration.prompt.md
> 创建：2026-09-26 ｜ 状态：pending ｜ 依赖：TASK-mock-core（快照比对）、TASK-runner-mock-mode（对撞）｜ 批次：3（与 TASK-chaos-pack 并行）
> **前置条件（Owner 负责）**：提供一个可用的 DeepSeek API key（环境变量 DEEPSEEK_API_KEY）。这是全套任务里唯一允许连真实 API 的任务；key 不入库、不进任何文件。

## 目标

把「mock 方言必须对齐真实 API」从教训变成机制：抓取真实 API 的黄金响应样本固化为 fixture，mock 输出与之做事件骨架快照比对；并对同一批结构性用例做 mock/真实 API 双跑对撞，判定一致才算 mock 合格。

## 背景

横评翻案教训：mock 把 Responses 的截断终态发成 `response.completed`+status 字段（真实方言是独立 `response.incomplete` 事件），直接制造假阴性结论。mock 的权威性和被测客户端的严格性成反比——客户端越宽容，方言错误藏得越深。唯一可靠的锚是真实 API 的字节。

## 范围（In Scope）

新建：
- `/Users/boyang/Desktop/dsh-eval-harness/tests/fixtures/golden/` —— 黄金样本（每文件标注抓取日期、API 端点、关键请求参数）
- `/Users/boyang/Desktop/dsh-eval-harness/scripts/capture-golden.mjs`（或 .ts，随仓库惯例）—— 抓取脚本
- 快照比对测试：tests/mock.spec.ts 增补（或独立 spec 文件）

抓取清单（每条一小节，脚本里实现）：
- 三协议 F0 正常流各一份（chat/completions、responses、messages；SSE 原文落盘）
- 三协议「真实截断」各一份：用极小输出上限诱发——Responses 用 `max_output_tokens: 16` 配长输出 prompt；Anthropic 用 `max_tokens: 1`；Chat Completions 用 `max_tokens: 1`。记录真实终态事件的确切形状（事件名、字段名、嵌套层级）

## 对撞测试

- 选取 cases/ 下 2-3 条纯结构性用例（无 judge），同一用例分别在 mock 模式与真实 API 模式各跑一遍，判定（PASS/FAIL 与关键断言结果）须一致
- 对撞是手动/本地校准步骤（需 key），不进 CI；CI 只跑离线快照比对

## 非目标（Out of Scope）

- 不改动 mock 行为去"迎合" fixture 而不上报——发现方言不一致时，正确动作是修 mock 并在上报中写明差异点；发现真实 API 与横评记录不一致时停下上报（可能上游变了）

## DoD

1. 黄金样本落盘且每份带来源标注；`.gitignore`/提交内容确认无 key 泄漏（抓取脚本只从环境变量读 key）
2. 快照比对测试离线可跑且绿：mock 各协议 F0/F4/F5 的事件骨架（事件名序列 + 终态事件关键字段路径）与黄金样本一致
3. 对撞结果写入上报：用例名 × 两模式 × 判定，全部一致；不一致项列出并停下
4. `pnpm build` / `pnpm test` / `pnpm lint` 全绿

## 风险与回滚点

- 真实 API 的事件形状可能与横评时记录不同（上游漂移）——这正是本任务要抓的东西；抓到时停下上报，不擅自"修齐"
- 回滚：新增文件删除即可

## 参考素材（绝对路径）

- 方言教训记录：/Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/matrix/interactive-appendix/APPENDIX.md（Reconciliation 一节）
- 横评 mock 的修正后事件序列：/Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/mock.mjs（2026-09-25 方言修正版）

## 执行变更记录（2026-09-26，Executor 上报 + Planner 复核确认）

1. 真实 API 抓取 8 个小请求（6 抓取 + 2 对撞），token 量级数百；key 只读环境变量，凭据扫描无入库
2. 方言锚点全部证实：cc=finish_reason:length+[DONE]；responses=独立 response.incomplete 事件（2026-09-25 修正正确）；anthropic=stop_reason:max_tokens
3. 发现并修齐：真实 Responses 流多 response.in_progress 与 response.content_part.done 两事件（按契约"修 mock 并写明差异"执行）
4. 遗留边界（如实）：responses F5 reasoning 流形状未经黄金样本验证（真实 reasoning 流未抓）；golden 只覆盖文本流
