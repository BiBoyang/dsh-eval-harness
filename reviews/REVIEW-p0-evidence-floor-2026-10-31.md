# REVIEW: TASK-p0-evidence-floor（2026-10-31）

- Reviewer: Planner
- Executor: ClaudeCode（独立 worktree `/Users/boyang/Desktop/dsh-eval-harness-p0-evidence-floor`）
- 分支: `feat/p0-evidence-floor` @ c58d647（未提交，等 Owner review）
- 结论: **Approved**

## 审计表（Planner 实跑）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 分支与基点 | Done | 基于 `main@c58d647`；改动 12 文件 = 契约 11 + Owner 批准的 SKILL.md |
| E3 送达对账 | Done | `checkMockDelivery`（src/runner.ts:438）实现 + 124 行新测试块；**端点映射与 src/mock.ts 实际路由逐一比对一致**（cc/responses/anthropic——上轮挂起的核验项关闭）；forge-f5 先证"改前 pass"再改代码，DoD-1 证据链完整 |
| E4 judge 留痕 | Done | `judgeConfig()` 抽取复用；PASS/FAIL 双留痕；**key 不进报告的断言明确存在**（`not.toContain('judge-test-key')`）；`:928`/`:951`/`:973` 翻转与保留均按契约 |
| E7 缺席即 FAIL | Done | Planner 实跑验收②：`FAIL 1`；`REMOVED=` 保留；gate-signals.md 锚点信号仍 WARN（无关信号未误伤） |
| E8 不跑不是绿 | Done（静态） | Planner 实跑验收③：两 step 就位（eval.yml:87/94）；执行者对照 GitHub 官方文档逐项核对表达式（含 fork payload 缺属性的空串回退推演），desk-check 8 场景；live 验证留 Owner |
| 全量三件套 | Done | Planner 实跑：build OK、**361/361**（343+18）、lint 30 文件零警告 |
| SKILL.md:85 | Done | 恰一处 hunk，内容为 Owner 中途批准的 E7 口径同步；与 P0-3 的 ：53-54 改动区隔确认无冲突 |

## 两个契约外改动的裁定

1. **第 4 处测试 `allowbuilds-unlock` 的 fixture**：**接受，算"语义不变"**。核查 hunk：改动仅在 `writeBlockingFakeDsh` 脚本中加一行 `curl` 打 mock（F0），测试断言零字改动；执行者先实测"无此补丁则 E3 下红"留证。该测试的意图（build 拦截→harvest key→重试解锁）完整保留。这正是契约 blind spot 的正确处置：发现→实证→最小修复→上报拍板。
2. **SKILL.md:85**：Owner 已中途批准（"本分支一起改"），核查无误。

## 已知限制（记录在案，不阻塞）

- E3 非流式请求会记 fault 但 mock 返回健康响应——按字面规则算"送达"。收紧（记录并校验响应形态）归 P1。
- E8 未在真实 GitHub 上跑过：**DoD-5 fork 实跑是 Owner 动作**（推送后观察一次 fork PR 或 workflow_dispatch）。
- 原有行为：schedule 触发时 24h 无提交则 job 跳过仍显绿——不在 E8 范围，记 P1 backlog。
- E4 `baseUrl` 原样进报告：勿在 `EVAL_JUDGE_BASE_URL` 放凭据（README 已同步）。

## 流程事件：共用检出事故（与 probe-agents 上报互证）

两份上报的叙述与 reflog/worktree 记录完全吻合：evidence-floor 09:27 误切共享 HEAD，09:30 自行发现、切回、转独立 worktree 重做基线。**双方处置正确，本单全部验证在 worktree 内独立完成。**证据：worktree list、reflog、两分支文件零重叠（probe-agents 只新增文件，本单只改文件）。

## 变更摘要

12 文件（src×5、tests×3、eval.yml、README、gate-signals、SKILL.md），+18 测试（E3 四态 + forge-f5 + E4 三态 + E7 + judgeConfig 单测）。回滚：四规则独立，可按 hunk revert。
