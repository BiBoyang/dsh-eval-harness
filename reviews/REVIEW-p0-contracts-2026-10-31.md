# REVIEW: TASK-p0-* 四份契约评审（2026-10-31）

- Reviewer: Planner
- 契约作者: Opus 5.5（T2 Executor 越界自拟的规划产物，经本评审采纳为正式派发单）
- 结论: **四份全部 Approved，采纳为 T5-P0 派发单**

## 逐份评语

| 契约 | 批次 | 哈希（sha256 前 8） | 评语 |
|---|---|---|---|
| TASK-p0-evidence-floor | P0-1 | `5ab2be1d` | E3/E4/E7/E8 四规则精确到"现状→改后"；需翻转的既有测试（:1147、:928）点名到位；E8 表达式自带 fork 守卫且与 eval.yml 现行 `env.DEEPSEEK_API_KEY` 用法一致（:88 已核实）；四项可独立 revert |
| TASK-p0-probe-agents | P0-1 | `694a05b7` | 棘轮用"完全相等"白名单（新增弱用例即红）优于设计文档的"增量阻断"；静态规则与 parrot 动态结果交叉验证（14 条弱用例 = 10 real + echo-hello + 3 插件冒烟，echo-hello=name 已核实）；阳性对照证明棘轮能变红后还原——纪律正确 |
| TASK-p0-case-hardening | P0-2 | `8acffdf4` | 只加 `tool_result_contains` 不动 prompt（最小严格度增量）；10 条断言声称已在 baseline 真实轨迹上预验证；baseline 回放测试是 D3 oracle 的种子——设计闭环；3 条插件冒烟因疑似 collector 提取缺口诚实延期并给出证据 |
| TASK-p0-mock-sentinels | P0-2 | `fd2fdeff` | spike 先行（npm 0.1.7-rc.2 离线 6/6，`npm view` 已核实版本存在）；S2 退出码"先实测再写断言，不许照抄"；`sentinels:false` 不提供"跳过但放行"组合；chaos.yml 独立 workflow 避开 E8 冲突——并行工程意识好 |

## 协议合规

- 四份配套 prompt 均含 WORKFLOW §6.3 要素：front matter（status: pending）、绝对路径、分支要求（从 main 新建 feat/p0-*）、status 文件约定、硬停止条款（各 3 处）、只读约束（各 4 处）。
- 文件零重叠声明核实：P0-1 两单无共享文件；P0-2 两单仅共享 README.md 不同小节，已声明冲突面。
- `splitDshBin`（src/runner.ts:244）与 `writeMockFakeDsh`（tests/runner.spec.ts，curl 选项）两个实现锚点均真实存在。

## Findings

- 无 Blocker / Major。
- [Minor·无需行动] mock-sentinels 契约声称"修正了设计文档 §5.2 S2 漏写 exit_code 的问题"——不实：设计文档 :450 本来就有 `exit_code: <以 dsh 实测为准>`。契约自己的 yaml（:55）更精确（钉 0.1.7-rc.2 实测），内容无害；仅 its 修正声明不成立，记录在案。
- [Minor·实施时核验] evidence-floor E3 的端点映射（openai-completions→cc、openai-responses→responses、anthropic-messages→anthropic）来自契约摘录，Planner 未独立对照 src/mock.ts 核实——实施者须以 src/mock.ts 实际路由为准，不符时按硬停止条件 4 上报。
- [Minor·已被解决] Planner 在 T2 评审中提的 base64 派生依赖风险：case-hardening 契约明确把"执行派生（如 base64）"推迟到 P1，P0 只加 `tool_result_contains`——该风险关闭。

## 与设计文档的关系

- P0 对设计 §5.2 的两处有意降级均已声明：fail-fast 推迟到 P1；gate 判定用 FAIL(exit 1) 而非 INVALID(exit 3)（P0 不升 schema）。接受——P0 的目标是止血与量地板，不是全量三通道。
- 设计文档合并到 main 与 P0-1 分支无冲突面（设计分支只新增文档/契约文件）。

## 派发顺序（Owner 确认后执行）

1. Owner 将 `feat/eval-hardening-design` 合入 main（设计文档已 Approved；先合让 P0 执行者在含契约的检出上开工，消除"以摘录为准"的降级）。
2. 并行派发 P0-1：evidence-floor + probe-agents（两个独立执行会话）。
3. Planner Review P0-1 → Owner 合入 main。
4. 并行派发 P0-2：case-hardening + mock-sentinels。
5. Planner Review P0-2 → Owner 合入 → 真实 API 复核 + update-baseline（case-hardening DoD-4）。
