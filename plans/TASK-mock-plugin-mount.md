# TASK-mock-plugin-mount：mock 模式支持挂载被测插件

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-mock-plugin-mount.prompt.md
> 创建：2026-09-26 ｜ 状态：pending ｜ 依赖：无（在 v0.5.0 之上工作）｜ 批次：1

## 目标

用例 `mock:` 段支持声明 `plugins: [...]`：eval_run 在生成隔离 DSH_HOME 后，把声明的插件用 dsh 自己的安装器装进该 home 的 headless profile，再进行子进程评测。这是"插件在场时跑 chaos/结构性用例"的前置缺口（v0.5.0 的 writeMockHome 只写 base+headless 两个 bundle，见 src/runner.ts writeMockHome）。

## 需求规格（Owner 已拍板）

- 安装走 **dsh 自己的安装器**（对隔离 DSH_HOME 执行 plugin add），不手写 bundle 行——保真度最高，且天然验证「安装成功率」这层数据
- 插件 spec 支持 npm 包名与 github:spec 两种形态；README 写明**版本必须钉死**（`@x.y.z` 或 `#<sha>`），不钉的版本漂移自己负责
- 安装失败要用例级可见：记入该用例 error，消息带插件 spec 与安装器输出尾部——安装失败是数据，不是崩溃
- 安装需要网络属预期（本任务不做离线安装）

## 范围（In Scope）

修改（仓库根：/Users/boyang/Desktop/dsh-eval-harness）：
- src/types.ts —— `mock.plugins?: string[]`
- src/runner.ts —— mock home 生成后、子进程前，逐 spec 调安装器（复用 resolveDshCommand 的 dsh_bin；env 用同一套隔离 env；失败捕获得用例级 error）
- tests/runner.spec.ts —— 安装器调用构造的单测（纯函数级别）；失败路径单测
- README.md —— mock 段文档补 `plugins`；版本钉死纪律

## 非目标（Out of Scope）

- 新断言类型（挂载后的 chaos 断言复用现有 turn_end/exit_code）
- 插件功能用例的编写（TASK-plugin-eval-sweep 的事）
- 离线安装、本地路径插件（如 dsh 安装器原生支持则可顺带提及，不支持不补）

## 设计要点（接口形状，非实现）

- 顺序：writeMockHome →（如有 plugins）逐 spec 安装 → 生成 overlay → 起 mock server → fork 子进程
- 安装命令形态：`dsh plugin --profile <profile> add <spec>`，env 与评测子进程同构（DSH_HOME 指向隔离 home、清代理、MOCK_API_KEY）
- 注意 dsh 首次运行会把 settings.yaml import 改名 .imported（0.5.0 已兼容）；安装发生在 import 之后还是之前由 spike 实测决定，两种顺序都可行但必须在注释里写明实测结论
- spike 先行：用一个 npm 形态的小插件（建议 `dsh-find-plugin`，MIT、npm 已发布）验证「隔离 home 里装插件 → headless 跑通 F0 用例 → 报告可见」全链路；spike 不通立即上报

## DoD

1. spike 证据：带 `mock.plugins` 的 F0 用例 PASS，且隔离 home 内可见插件安装痕迹（命令 + 输出贴进上报）
2. 安装失败路径：钉一个不存在/不兼容的 spec，用例记 error 且消息含 spec 与安装器输出尾部（不 crash 整个 run）
3. `pnpm build` / `pnpm test` / `pnpm lint` 全绿
4. README 更新（plugins 字段 + 版本钉死纪律 + 安装失败的语义）

## 风险与回滚点

- dsh 安装器在隔离 home 的行为未实测过（可能要求先完成某次初始化）——spike 即为此设；不通则上报，不擅自改 dsh
- 回滚：按文件 revert；spike 前为天然回滚点

## 参考素材（绝对路径）

- 现有实现：/Users/boyang/Desktop/dsh-eval-harness/src/runner.ts（writeMockHome、resolveDshCommand、mock 子进程 env）
- dsh 仓库（安装器行为只读参考）：/Users/boyang/deepseek-harness
