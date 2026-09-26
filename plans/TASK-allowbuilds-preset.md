# TASK-allowbuilds-preset：mock home 预置 allowBuilds（解锁需构建插件）

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-allowbuilds-preset.prompt.md
> 创建：2026-09-27 ｜ 状态：pending ｜ 依赖：TASK-orphan-grandchild-fix（串行，修其后再做本单）｜ 批次：2

## 目标

解除实测确认的阻断：「需 prepare 构建」的插件（routing-suite 类 tarball/github 形态）在 pnpm 11 默认配置下装完即死（构建被拦截 → lib 缺失 → import 失败）。让 mock.plugins 挂载这类插件时，隔离 home 预置正确的 allowBuilds 配置，使构建正常执行、插件可激活。

## 背景（证据已落盘）

plugin-check-2026-09-26 实测：yjh051108/dsh-routing-suite（7000★，实发包 @dsh-external/dsh-super-injector 0.3.3）经 codeload tarball 安装，命令成功但 injector/lib 缺失 → 插件未激活；dsh 提示手工 allowBuilds 解锁。证据：/Users/boyang/Desktop/dsh-eval-harness/.eval/plugin-check-2026-09-26/dsh-routing-suite/（install-l1.log、ATTRIBUTION.md）。

## 需求规格（Owner 已拍板）

- **最小授权**：allowBuilds 只覆盖本用例 `mock.plugins` 声明的包名（声明即授权该插件的构建脚本在本机运行），不做全局放行
- 机制以实现时核查为准：先读 dsh 安装器源码（/Users/boyang/deepseek-harness/apps/cli/src/plugin.ts 81-83 附近的提示逻辑）与当前 pnpm 版本文档，确认 allowBuilds 的确切配置形态（pnpm-workspace.yaml 的字段名/结构），不凭记忆写
- 预置时机：writeMockHome 生成 profile 时写入（安装发生在此之后，顺序天然成立）
- README 写明风险语义：声明 mock.plugins 即授权其构建脚本在本机执行——只声明信得过的插件

## 范围（In Scope）

修改（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：
- src/runner.ts —— writeMockHome 预置 allowBuilds（按声明的插件包名生成）
- tests/runner.spec.ts —— 预置内容单测（包名提取：npm 形态 @scope/name@ver、name@ver；tarball/github URL 形态的包名解析策略——解析不出时的行为要在注释与测试里钉死）
- README.md —— mock.plugins 小节补 allowBuilds 语义与风险句

## 非目标（Out of Scope）

- dsh 安装器本身的自动处理（上游事）；routing-suite 的 L2 冒烟（其引擎依赖另行评估）
- 全局 allowBuilds 开关；对未声明插件的构建放行

## DoD

1. 解锁证据：重跑 cases/plugins/dsh-routing-suite/ 的 chaos 挂载四格（F0/F1/F4/F5），结果从「4×安装失败 error」变为**行为可判定**（红绿不论——fault 行为本身成为结论），报告落 /Users/boyang/Desktop/dsh-eval-harness/.eval/plugin-check-2026-09-26/dsh-routing-suite/l3-chaos-mounted-v2/
2. 最小授权证明：预置配置中只出现声明的包名（单测断言）
3. 包名解析单测覆盖三类形态（scoped npm / 裸名 npm / URL 形态）
4. `pnpm build` / `pnpm test` / `pnpm lint` 全绿；README 已更新

## 风险与回滚点

- 构建脚本真实执行 = 任意代码运行：本任务的授权边界（仅声明包名）就是全部防线，文档必须写透
- routing-suite 解锁后其 chaos 行为可能本身就是红（那才是真发现）——红不视为任务失败，无法激活/无法判定才视为任务失败
- 回滚：按文件 revert

## 参考素材（绝对路径）

- 案发证据：/Users/boyang/Desktop/dsh-eval-harness/.eval/plugin-check-2026-09-26/dsh-routing-suite/
- 既有用例：/Users/boyang/Desktop/dsh-eval-harness/cases/plugins/dsh-routing-suite/
- dsh 安装器提示逻辑：/Users/boyang/deepseek-harness/apps/cli/src/plugin.ts
