# TASK-p0-probe-agents：探针 agent + 断言强度静态检查 + ABC 活清单

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-p0-probe-agents.prompt.md
> 创建：2026-10-30 ｜ 状态：pending（待 Owner 确认）｜ 依赖：无 ｜ 批次：P0-1（与 TASK-p0-evidence-floor 并行，文件零重叠）

## 目标

把"判分会不会被不解题的 agent 骗过"从一次性人工核实，变成 CI 里常驻的回归测试：

1. 交付两个探针 agent（do-nothing、parrot）和断言强度静态检查 `assessAssertionStrength`；
2. 用"白名单完全相等"的棘轮测试锁住当前状态（parrot 可过 10 条、静态弱用例 14 条）。此后新增弱用例会让 `pnpm test` 变红，修好的用例也必须同 PR 从白名单移除；
3. 把 ABC 13 条对照表和已知放水方式表落成可维护的活文档。

本任务只新增测试、纯函数模块和文档，不改判分行为，不改用例。

## 背景（证据已落盘）

设计依据：`docs/EVAL-HARDENING-DESIGN.md` §2.7（K1–K3、K15）、§6.2（E2）、§6.3、附录 A。该文档待 Owner 合入；本契约已摘录本任务需要的全部事实。

- parrot 探针（按 prompt 中"<name> 工具"字样依序调用、参数为整段 prompt、工具结果全部报错、最终复述 prompt）在 `cases/real` 通过 10/12，只有 `read-image`、`read-image-oversized` 因 `tool_result_contains` 被拦下。
- do-nothing 探针在 `cases/real` 上 0/12；但只断言 `turn_end` 的弱用例，do-nothing 即可通过——`parseCase` 不设断言下限（`src/runner.ts:119-121`）。
- 2026-10-30 已在仓库外用原型验证本契约的静态规则：`cases/real` 10/12 判弱（answer-in-prompt），`cases/chaos` 0/6，`cases/plugins` 3 条冒烟判弱（no-outcome-assertion），`cases/example.case.yml` 判弱（answer-in-prompt），合计 14 条；与 parrot 的动态结果一致。

## 需求规格（Planner 建议，待 Owner 拍板）

- 棘轮用"完全相等"而不是"子集"：新增弱用例与修好的用例都必须同 PR 更新白名单，白名单永远等于真实状态。
- 探针 agent 不依赖真实 dsh：它是一个按 dsh 命令行协议落 session 日志的 node 脚本（`--version` 探针；`--profile <p> --patch <overlay> <prompt>`）。
- 静态规则 `assessAssertionStrength(evalCase)`：
  - 带 `mock` 的用例（宿主为被测）：同时声明 `exit_code` 与 `turn_end` → 强；否则弱，原因 `host-without-exit-and-turn-end`。送达证据由 TASK-p0-evidence-floor 在运行期强制。
  - 真实 API 用例为强，当且仅当满足任一条件：① `tool_result_contains` 非空；② 某条 `tool_args_contains.contains` 不在 prompt 字面中；③ 某条 `output_contains` 不在 prompt 字面中；④ 某条 `output_matches` 正则不匹配 prompt 全文。
  - 否则为弱：有 `output_contains` / `output_matches` / `tool_args_contains` 时原因为 `answer-in-prompt`，三者都没有时为 `no-outcome-assertion`。
  - 这是对设计文档 §6.2 中"V5（工具证据）"的细化：`tool_args_contains` 的期望串若在 prompt 里，parrot 照样命中（K2 中 01-bash-tool 被穿透即此），所以不算结果信号。`no_tool_errors` 也不算：调用成功但答非所问的 agent 能过它。

## 范围（In Scope）

新建（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：

- `src/strength.ts` —— `assessAssertionStrength` 及其返回类型（纯函数，不接入 runner）
- `tests/probes/fake-dsh.mjs` —— 探针 agent，`PROBE_MODE=do-nothing|parrot`（可直接以设计文档附录 A 为底稿；forge-f5 模式不在本任务）
- `tests/probes.spec.ts` —— 见"测试规格"
- `docs/abc-checklist.md` —— 活清单：13 条对照总表（当前判定 + 证据指针）、已知放水方式表、维护规则
- `.github/pull_request_template.md` —— 一条勾选项：如果改动新增或修改了 verifier、断言键或用例类别，已同步 `docs/abc-checklist.md` 与 `tests/probes.spec.ts` 白名单

## 非目标（Out of Scope）

- 不改任何用例（加固是 TASK-p0-case-hardening 的事）。
- 不改 `src/runner.ts`、`src/assert.ts`、`src/gate.ts`、`src/report.ts`，不往报告加字段（`calibration.weakCases` 由 TASK-p0-mock-sentinels 接入）。
- 不改 README（指向活清单的链接由 TASK-p0-case-hardening 添加）。
- 送达类探针 forge-f5（归 TASK-p0-evidence-floor）。

## 测试规格（tests/probes.spec.ts）

1. do-nothing × `cases/real`：通过数为 0（硬断言）。
2. parrot × `cases/real`：通过的用例名集合**等于** `KNOWN_PARROT_PASSABLE`。初值 10 条：bash-tool、fs-write-read、fs-search、todo-tool、edit-tool、glob-tool、web-search、subagent-delegate、workflow-fanout、bash-only。
3. 用 `assessAssertionStrength` 扫 `cases/`、`cases/real`、`cases/chaos`、`cases/plugins/*` 的全部用例：弱用例名集合**等于** `KNOWN_WEAK_CASES`，并逐条断言 reason。初值 14 条：上述 10 条（answer-in-prompt）+ echo-hello（answer-in-prompt）+ agent-teams-smoke-status、routing-suite-smoke-injected-list、modlens-smoke-read-image（no-outcome-assertion）。
4. 一致性：`KNOWN_PARROT_PASSABLE` ⊆ `cases/real` 中的静态弱用例。
5. `assessAssertionStrength` 分支单测：四种"强"条件各一例、两种弱原因各一例、mock 用例强弱各一例。

实现提示：`runEval` 的 `dshBin` 用 `` `${process.execPath} <fake-dsh 绝对路径>` ``（`splitDshBin` 按空白拆分，`src/runner.ts:244-250`），避免依赖文件可执行位；输出目录用 `mkdtemp`。

## DoD

1. `CI=1 pnpm exec vitest run tests/probes.spec.ts` 通过，两份白名单的初值与上文一致（命令与输出贴进上报）。
2. 阳性对照（证明棘轮能变红，随后还原）：
   - 从 `KNOWN_PARROT_PASSABLE` 删掉一条 → 测试变红；
   - 临时删掉 `cases/real/08-read-image.yml` 的 `no_tool_errors` 与 `tool_result_contains` 两项 → 静态检查与 parrot 两项测试都变红。
   - 两处都还原后复绿。
3. `docs/abc-checklist.md` 含 13 条（判定与设计文档 §3.1 一致）和放水方式表（每行标注对应探针，或标"计划于 P1/P2"）。
4. `pnpm build` / `pnpm test` / `pnpm lint` 全绿；`git status --short` 只出现上述新建文件（以及开工前已存在的未跟踪项）。

## 风险与回滚点

- 探针测试会经 `runEval` spawn 24 次子进程（12 条 × 2 种探针），注意给测试设置足够的超时（整体 30s 级别）。
- 静态规则是保守启发式：期望串在 prompt 里出现、但语义上确实需要执行才能得到的用例（极少数）会被误判为弱。白名单就是逃生口——误判时把用例名和理由写进白名单注释。
- 回滚：全部为新增文件，删除即回滚。

## 参考素材（绝对路径）

- 设计文档：/Users/boyang/Desktop/dsh-eval-harness/docs/EVAL-HARDENING-DESIGN.md（§2.7、§3、§6.2、§6.3、附录 A）
- 原型脚本（仓库外，可能已被清理）：/tmp/ehd-probe/bin/fake-dsh.mjs、/tmp/ehd-probe/probes/p0-grounding.mjs
- 现有 fake dsh 写法：/Users/boyang/Desktop/dsh-eval-harness/tests/runner.spec.ts（`writeFakeDsh`、`writeMockFakeDsh`）
