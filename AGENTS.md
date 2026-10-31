# dsh-eval-harness — Agent Quick Context

> 本文件写给在此仓库工作的任何 agent（2026-10-31 由协作模式 Planner 留下）。
> 协作流水线：Owner（boyang）派发 + Planner（ZCode 会话）规划/评审 + Executor（独立会话，ClaudeCode/Opus）编码。

## 当前状态（2026-10-31）

**P0 加固批次已全部完成并合入 main @ `395873c`**（422/422 测试、lint 干净）：

- 探针与静态检查：`src/strength.ts`、`tests/probes/fake-dsh.mjs`、`tests/probes.spec.ts`（双白名单棘轮）、`tests/baseline-replay.spec.ts`（baseline 回放防线）
- 证据下限：E3 送达对账 / E4 judge 留痕 / E7 缺席即 FAIL / E8 主仓库无 key 即红（eval.yml）
- 哨兵：`cases/_sentinels/`（S1 必过 / S2 必不过）+ `src/sentinel.ts` + 报告 `calibration` 段 + gate 对哨兵破判 FAIL
- 用例加固：`cases/real` 10 条全部有结果型断言（parrot 探针 0/12）
- CI：`chaos.yml` 离线常跑 chaos + 哨兵（dsh 0.1.7-rc.2，零 API key）
- 活清单：`docs/abc-checklist.md`（现状数字已同步；**判定列未改判，见下"授权未完成"**）

四轮评审记录在 `reviews/REVIEW-*-2026-10-31.md`；任务契约与过程记录在 `plans/`、`prompts/`。

## 改动前三件套（必须全绿再交）

```bash
cd /Users/boyang/Desktop/dsh-eval-harness && pnpm build && CI=1 pnpm test && pnpm lint
# 探针/哨兵专项：
CI=1 pnpm exec vitest run tests/probes.spec.ts tests/sentinel.spec.ts tests/baseline-replay.spec.ts
```

## 纪律（违反会破坏测量可信度）

1. **不许手改 `baseline/`**——它由 `update-baseline.yml` 刷新（Owner 触发，真实 API，~122k token 量级，烧钱先问 Owner）。
2. **不许为了变绿改 `tests/probes.spec.ts` 白名单而不写理由**；用例修好须同 PR 从名单移除（完全相等棘轮）。
3. **哨兵不许删、不许被 tags/only 筛掉**；`sentinels: false` 只给程序调用，报告会记 `skipped` 且 gate 仍 FAIL——不存在"跳过但放行"。
4. **verifier / 断言键 / 用例类别变动**：同 PR 同步 `docs/abc-checklist.md` 与白名单（PR 模板有勾选项）。
5. 期望串写法：必须由工具真实结果证明（`tool_result_contains`），见 `skills/eval/SKILL.md`——不要回退到"期望关键词写进 prompt"。
6. `EVAL_JUDGE_BASE_URL` 勿放凭据（会原样进报告）。

## 授权未完成（Planner 已批准，尚未执行——下次可内联做掉）

1. **D1 改判**：`docs/abc-checklist.md` §1 的 D1 行 判定 `缺失` → `已关闭（P0）`，同步更新 §1 核心证据与 §2 进展（关闭条件已满足：活文档入库 + PR 模板引用）。
2. **update-baseline 预检跳过回放**：`update-baseline.yml` 目前先跑全量 `pnpm test`，回放测试会让"有意改写期望串"的 baseline 刷新死锁。改为预检排除 `tests/baseline-replay.spec.ts`（PR 上 `ci.yml` 仍对新 baseline 全量回放），并在 `docs/gate-signals.md` 补一句绕法。

## Owner 专属动作（agent 不要代跑）

- 真实 API 复核 + `gh workflow run update-baseline.yml --ref main`（烧 token）
- `gh workflow run chaos.yml`（零 token，已可触发）
- E8 fork 实跑观察 `EVAL_SKIPPED=1`

## 后续路线（设计文档 §8）

P1 = 三通道 schema v2 + run manifest + 真实哨兵 S3/S4 + 全量对账 + R2 隔离；P2 = report schema 全量 + 台账互通（repo-quake ledger）+ judge 强制校准 + oracle 回放。已知 P1 backlog：E3 非流式收紧、schedule 24h 无提交跳过仍显绿、S2 对纯 output_contains 放水不敏感、插件冒烟用例的 collector 提取缺口。

## 相关仓库

`/Users/boyang/repo-quake`（进攻面方法论）：phase3 正交探针物料已就绪（`witness/factorial/`，--dry-run 全绿），**开火**（宿主矩阵 72/136/168 发，烧宿主 API）是 Owner 专属决策；缺陷台账在 `ledger/`（schema v1.1）。两仓库通过 `docs/EVAL-HARDENING-DESIGN.md` §8.1 的台账互通设计连接。
