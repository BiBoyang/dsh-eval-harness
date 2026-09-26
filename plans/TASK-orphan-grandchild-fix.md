# TASK-orphan-grandchild-fix：超时杀进程树（修孙进程孤儿化）

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-orphan-grandchild-fix.prompt.md
> 创建：2026-09-27 ｜ 状态：pending ｜ 依赖：无 ｜ 批次：1（与 TASK-allowbuilds-preset 串行，本单先行）

## 目标

修复实测挂死 34 分钟的缺陷：runOne 超时只 `SIGKILL` 直接子进程，包装器形态 dsh_bin（如 `pnpm -C … dsh`、`bash -c …`）的孙进程孤儿化并占住 stdio 管道 → `close` 永不触发 → runner 永挂。修法：**进程组杀**——spawn 时 `detached: true` 让子进程自立进程组，超时/取消时 `kill(-pid)` 终结整棵树。

## 根因（已确认，插件测评实战撞出）

src/runner.ts 两处 spawn 点同病：
1. runOne 的评测子进程（超时 `child.kill('SIGKILL')`，runner.ts:527 附近）
2. installMockPlugin 的安装器子进程（同样形态，runner.ts:442 附近）

`pnpm`/wrapper 被杀后其 node/tsx 子孙不退出，继续握住 stdout/stderr 管道，`close` 事件等不到 EOF，Promise 永不 settle。

## 需求规格（Owner 已拍板）

- 两处 spawn 点都修（修根因，不修单一症状）
- POSIX 用进程组杀（`detached: true` + `process.kill(-child.pid, …)`）；Windows 不追求等价语义，注释标注退化路径（`taskkill /pid /T /F` 候选），不在本任务实现
- 安全红线：`detached` 只给这两处子进程用，负 pid 杀组前必须确认组 id 就是该子进程本身——绝不允许误杀 harness 自身所在组
- 行为不变量：正常路径（无超时）语义完全不变；只改超时/取消路径的终结范围

## 范围（In Scope）

修改（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：
- src/runner.ts —— 两处 spawn 点 + 抽一个 killProcessTree 辅助（或等价局部实现）
- tests/runner.spec.ts —— 回归测试（见 DoD-2）

## 非目标（Out of Scope）

- Windows 等价实现；安装器的其它健壮性改造；pnpm-lock.yaml 污染（另有处置）

## DoD

1. 回归测试（POSIX，win32 skip）：构造 wrapper→孙进程（孙进程持管道 sleep 长于此测试），触发超时，断言 (a) runner 在超时后有限时间内返回、(b) 孙进程已死（kill -0 探测）、(c) 错误消息仍含 timed out 语义
2. 真实复现验证：用 `pnpm -C /Users/boyang/deepseek-harness dsh` 形态 + 短 timeout 跑一条用例，确认不再复现永挂（命令 + 输出贴进上报）
3. 既有 308 测试全绿 + 新测试通过；`pnpm build` / `pnpm lint` 绿
4. 代码注释写明：为什么 detached、负 pid 杀组的前提、Windows 退化路径

## 风险与回滚点

- detached 子进程在父进程退出后默认脱离——runEval 正常返回路径若残留未终结子进程会变成新泄漏；实现时确保所有退出路径（含异常）都终结进程组
- 回滚：按文件 revert

## 参考素材（绝对路径）

- 案发记录：/Users/boyang/Desktop/dsh-eval-harness/.eval/plugin-check-2026-09-26/SUMMARY.md 环境节 4
- 两处 spawn 点：/Users/boyang/Desktop/dsh-eval-harness/src/runner.ts（installMockPlugin、runOne）
