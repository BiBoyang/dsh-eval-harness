# TASK-p0-case-hardening：cases/real 结果信号加固

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-case-hardening.prompt.md
> 创建：2026-10-30 ｜ 状态：pending（待 Owner 确认）｜ 依赖：TASK-p0-probe-agents（其棘轮测试与静态检查须已合入 main）｜ 批次：P0-2（与 TASK-p0-mock-sentinels 并行，仅 README 不同小节可能冲突）

## 目标

让 `cases/real` 的每条用例都有"结果型"断言：只有被测插件的工具真实执行、并返回了期望内容，用例才能通过。

成功标准：parrot 探针 0/12；静态弱用例只剩 4 条（3 条插件冒烟 + 示例用例）；加固后的断言在 baseline 记录的真实轨迹上全部通过。

## 背景（证据已落盘）

设计依据：`docs/EVAL-HARDENING-DESIGN.md` §2.7（K2、K15）、§6.2（E2 与用例改写方向）。该文档待 Owner 合入；本契约已摘录本任务需要的全部事实。

- K2 / K15：parrot 在 `cases/real` 通过 10/12；todo、fs-search、web、subagent、workflow 五组插件即使整体损坏，用例仍 PASS，gate 只给 WARN，CI 退出码为 0。
- 根源：`skills/eval/SKILL.md:53-54` 要求"把期望输出关键词都写进 prompt"，而 `output_contains` 是子串匹配（`src/assert.ts:62`）。
- 2026-10-30 已用原型验证下表的加固断言：10/10 在 `baseline/report.json` 记录的真实轨迹（harness 0.3.1、dsh 0.1.1-rc.2）上通过，在 parrot 轨迹上失败，静态检查判强。

## 需求规格（Planner 建议，待 Owner 拍板）

- 只**新增** `tool_result_contains`：不改 prompt，不删已有断言，不加 `no_tool_errors`。严格度增量保持最小；工具自愈另有 gate 软信号覆盖。
- 期望串以 baseline 中该工具的真实返回文本为准（下表已核对）：

| 用例文件 | 新增 `tool_result_contains` | baseline 真实返回（摘录） |
| --- | --- | --- |
| `01-bash-tool.yml` | bash → `BASHOK-7f3a` | `BASHOK-7f3a` |
| `02-fs-write-read.yml` | read → `FSMARK-9c2e` | `…<content>\n1: FSMARK-9c2e…` |
| `03-fs-search.yml` | grep → `GAMMA-3e8f` | `Found 1 match … Line 3: GAMMA-3e8f` |
| `04-todo-tool.yml` | todo_write → `2 pending` | `Updated todo list: 2 pending, 0 in progress, 0 completed.` |
| `05-edit-tool.yml` | read → `hello there` | `…1: hello there…` |
| `06-glob-tool.yml` | glob → `foo-1.txt`；glob → `foo-2.txt` | `foo-1.txt\nfoo-2.txt` |
| `07-web-search.yml` | web_search → `DeepSeek` | `Sources:\n- [DeepSeek发布…` |
| `09-subagent.yml` | subagent → `SUBAOK-5b1d` | `SUBAOK-5b1d` |
| `10-workflow.yml` | workflow → `(2 agents)`；workflow → `AAA`；workflow → `BBB` | `workflow "minimal-fanout" completed (2 agents). … "first": "AAA", "second": "BBB" …` |
| `11-bash-only.yml` | bash → `EXACTOK-42` | `EXACTOK-42` |

- 写断言前，在 baseline 里再核对一次实际文本（用 `node -e` 读 `baseline/report.json` 的 `toolResults`），不许不验证就照抄本表。
- 新增 baseline 回放测试：用 `baseline/report.json` 中每条用例的轨迹字段构造 `CollectedTrace`，以当前用例的 assert 跑 `checkAssertions`，必须全部通过——即"已知正确解必被 verifier 接受"，这是 D3 oracle 回放的种子。

## 范围（In Scope）

修改（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：

- `cases/real/` 上表中的 10 个文件（只在 assert 块中新增条目）
- `tests/probes.spec.ts` —— `KNOWN_PARROT_PASSABLE` 改为空；`KNOWN_WEAK_CASES` 移除这 10 条（剩 4 条）
- `skills/eval/SKILL.md` —— 改写 `:53-54`（"prompt 自包含"）与 `:55-56`（"output_contains 选稳定关键词"）两条：输入数据写进 prompt，期望串必须由工具的真实结果证明（`tool_result_contains`）；并说明静态检查与白名单规则
- `README.md` —— `cases/real` 段（`:98-99`）补充"结果型断言"的口径，并链接 `docs/abc-checklist.md`

新建：

- `tests/baseline-replay.spec.ts` —— baseline 回放（见上）

## 非目标（Out of Scope）

- 3 条插件冒烟用例：本地 L2 报告（`.eval/plugin-check-2026-09-26/dsh-agent-teams/l2-smoke`、`modlens/l2-smoke-isolated`）中这些工具的结果文本是空串，没有可绑定的证据。疑似 collector 对非 text 结果块的提取缺口，需要单独排查（后续任务）。
- `cases/example.case.yml`：它是语法示例，保留在白名单中并注明原因。
- 改 prompt，或把期望串改为执行派生（如 base64 解码）：P1 视需要再做。

## DoD

1. `CI=1 pnpm exec vitest run tests/probes.spec.ts tests/baseline-replay.spec.ts` 通过：parrot 0/12；静态弱用例恰为 4 条；baseline 回放 12/12。
2. 阳性对照：把任一新增的 `contains` 临时改成错误的串 → baseline 回放变红 → 还原后复绿。
3. `pnpm build` / `pnpm test` / `pnpm lint` 全绿。
4. （Owner）真实 API 复核：以与 CI 相同的口径（dsh 0.1.1-rc.2、concurrency 3）跑 `cases/real` 全绿后，触发 `update-baseline.yml` 刷新 baseline；复核该 PR 时，除 FAIL / ERROR / flaky 外，至少抽查 3 条 PASS 用例的 `toolResults`。

验收命令（实施后可执行）：

```bash
CI=1 pnpm exec vitest run tests/probes.spec.ts tests/baseline-replay.spec.ts
pnpm build && pnpm test && pnpm lint
gh workflow run update-baseline.yml   # Owner 执行，真实 API
```

## 风险与回滚点

- 工具输出文案会随 dsh 版本变化（如 todo_write 的 "2 pending"）。dsh 升级时 baseline 回放与真实评测会一起变红——这是期望行为（口径变化必须人工确认），但会增加升级时的工作量。
- web_search 查的是实时网页：结果不含 "DeepSeek" 的概率很低，但不为零。真实复核若出现抖动，用 `trials` 量成功率，不放宽断言。
- 加固后，CI 评测可能暴露此前被"粉饰"的真实失败。那是真发现，按回归处理，不视为本任务失败。
- 回滚：按文件 revert。

## 参考素材（绝对路径）

- baseline 真实轨迹：/Users/boyang/Desktop/dsh-eval-harness/baseline/report.json
- 设计文档：/Users/boyang/Desktop/dsh-eval-harness/docs/EVAL-HARDENING-DESIGN.md（§2.7、§6.2、§6.3）
- 原型脚本（仓库外，可能已被清理）：/tmp/ehd-probe/probes/p0-grounding.mjs
