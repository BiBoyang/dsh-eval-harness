# TASK-mock-core：内置确定性 mock provider（核心模块）

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-mock-core.prompt.md
> 创建：2026-09-26 ｜ 状态：pending ｜ 依赖：无 ｜ 批次：1

## 目标

把横评项目验证过的 mock provider（/Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/mock.mjs，约 400 行、零依赖）以 TypeScript 重写进本仓库 `src/mock.ts`，作为后续 mock 模式与 chaos 用例包的地基。本任务只做模块本体 + 单测，不接 runner。

## 背景与动机

dsh-eval-harness 目前只能驱动真实 LLM（`src/runner.ts` 子进程 `env: {...process.env}` 透传，无 provider 覆盖），导致：协议异常路径（截断/断流/半事件）不可测；CI 必须持有 API secret；结构性用例为模型不确定性支付 trials/flaky 成本。内置 mock 后获得：确定性故障注入能力 + 离线零成本结构性用例。

方言教训（必须内化）：横评初版 mock 把 Responses 的 length 截断发成 `response.completed` 事件裹 `status:"incomplete"` 字段，而真实 API 的方言是**独立事件类型** `response.incomplete` 携带 `incomplete_details.reason`——codex 的 completed 分支不解析 status，造成假阴性。**事件骨架必须与真实 API 逐字节对齐，不许凭直觉拼。**

## 需求规格（Owner 已拍板）

- v1 只支持文本流故障，**不做** tool_calls 多轮脚本（留 v2）
- 零依赖：只用 Node 内置模块（node:http 等），不新增任何 dependency
- 复用横评 mock 的故障语义与送达证明设计；协议事件骨架以其为准

## 范围（In Scope）

新建：
- `/Users/boyang/Desktop/dsh-eval-harness/src/mock.ts` —— mock 模块
- `/Users/boyang/Desktop/dsh-eval-harness/tests/mock.spec.ts` —— vitest 单测

## 非目标（Out of Scope）

- runner 集成、用例格式扩展、exit_code 断言（TASK-runner-mock-mode）
- chaos 用例包、文档（TASK-chaos-pack）
- 黄金样本 fixture 与对撞（TASK-golden-calibration）
- tool_calls 脚本模拟（v2）

## 设计要点（接口形状，非实现）

- 导出 `startMockServer(opts): Promise<MockServer>`；opts 含 `fault`（F0-F5，默认 F0）、`port`（默认 0 即 ephemeral）、`delay`（ms/事件，默认 8）、`logDir`（可选，送达证明 jsonl 落盘）
- 返回 `{ port, baseUrl, requests, close() }`；`requests` 是内存中的送达证明数组（每请求：字节数、事件序列、终止证人、关流方式、请求体摘要），供 runner 读取附进报告；`logDir` 给定时同步写 jsonl
- 同一实例挂三端点：`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`；辅助端点 `GET /health`、`GET /v1/models`、`POST /v1/messages/count_tokens`、`GET|POST /__control`（查询/切换故障，支持 `once` + `match`/`avoid` 子串条件）
- 故障优先级：URL `?fault=Fx` > 请求头 `x-mock-fault` > 控制面当前值（含 once）> 启动默认

## 故障矩阵（逐协议字节形态——以此为准重写，勿自由发挥）

| 编号 | 故障 | Chat Completions | Responses | Anthropic Messages |
|---|---|---|---|---|
| F0 | 正常完整流 | 完整 chunk 序列 + `[DONE]` | 完整事件序列 + `response.completed` | 完整事件序列 + `message_stop` |
| F1 | 中途干净关流 | 发若干 chunk 后 TCP FIN，无 `[DONE]` | 发若干事件后 FIN，无 completed | 发若干事件后 FIN，无 message_stop |
| F2 | 丢终止事件 | 内容全送，`[DONE]` 照发，但带 finish_reason 的末 chunk 缺席 | 内容全送，`response.completed` 缺席，流正常关 | 内容全送，`message_stop` 缺席，流正常关 |
| F3 | 半事件关流 | 半个 SSE 事件（无结尾空行）后 FIN | 同左 | 同左 |
| F4 | length 截断 | 正文充足 + 末 chunk `finish_reason:"length"` | 正文充足 + 独立事件 `response.incomplete`（`incomplete_details.reason:"max_output_tokens"`）**——不是 completed+status** | 正文充足 + `message_delta` `stop_reason:"max_tokens"` |
| F5 | think-only 截断（阳性对照） | 只有 reasoning 内容 + `finish_reason:"length"`，无正文 | 只有 reasoning 事件 + `response.incomplete` | 只有 thinking 块 + `max_tokens` |

正文内容：确定性多段落文本（横评用 54 段标记文本 P01–P24+Q 段；本仓库实现可简化，但每段须带可校验的段落标记，且 F4 的 `done`/`item` 汇总文本必须与 delta 流拼接严格一致——横评踩过不一致的坑）。

## DoD

1. `pnpm build`、`pnpm test`、`pnpm lint`（biome `--error-on-warnings`）全绿
2. 单测覆盖：三协议 × F0/F4/F5 事件序列快照（快照内容须与参照 mock.mjs 的实际输出逐事件比对一致）；once 语义（命中即失效、match/avoid 隔离辅助请求）；故障参数优先级；F2 终止证人缺席；送达证明字段完整
3. 纯增量：不改任何现有文件的行为（若必须动 `src/index.ts` 导出，在提审时说明）
4. Node >= 22.15（engines 约束）语法/API 兼容

## 风险与回滚点

- 方言漂移：本任务靠"快照与 mock.mjs 实测输出比对"防；真实 API 黄金样本校准在 TASK-golden-calibration
- 回滚：整任务为新增文件，`git clean` 级回滚即可

## 参考素材（绝对路径）

- 参照实现：/Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/mock.mjs
- 该 mock 的真实输出样例（送达证明日志）：/Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/logs/mock-2026-09-25.jsonl
- 故障矩阵定义出处：/Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/truncation-detection-benchmark-plan.md §4

## 执行变更记录（2026-09-26，Executor 上报 + Planner 复核确认）

1. Responses 汇总文本与 delta 流严格一致（含段尾换行）——契约点名要求，参照实现本身不一致，按契约修正
2. 客户端中断检测从 `req.on('close')` 改为 `res.on('close')` + `writableEnded` 判别（前者请求体读完即触发，监听器挂不上）
3. TASK-golden-calibration 驱动增补：Responses 流补 `response.in_progress`（created 之后）与 `response.content_part.done`（output_text.done 之后）两个事件——真实 API 有、参照实现缺
