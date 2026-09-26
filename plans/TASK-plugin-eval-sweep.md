# TASK-plugin-eval-sweep：三个高星插件的四层漏斗测评

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-plugin-eval-sweep.prompt.md
> 创建：2026-09-26 ｜ 状态：pending ｜ 依赖：TASK-mock-plugin-mount ｜ 批次：2
> **前置条件（Owner 负责）**：DEEPSEEK_API_KEY 可用（来源 ~/.dsh/.env，bin/dsh-with-key.sh 同口径）。

## 目标

对三个高星社区插件执行「人气 → 可装 → 行为正确 → 故障韧性」四层漏斗测评，产出可复现证据与逐格归因记录。测评结果是博客系列第 7 篇的证据链——**证据质量就是文章质量**。

## 被测对象（2026-09-26 GitHub API 实测星数；版本以安装时钉死为准）

| 插件 | ★ | 类型 | 测它的理由 |
|---|---|---|---|
| yjh051108/dsh-routing-suite | 7000 | 路由/注入器 | 唯一直接碰 LLM 请求管线的头部插件，chaos 对照组最有区分度 |
| liustack/modlens | 4041 | 工具（视觉） | 工具型代表；社区点名安装须锁版本（@3.17.2），版本敏感性本身是数据 |
| NanmiCoder/dsh-agent-teams | 1806 | 多 agent 编排 | 失败面最丰富；多并发 LLM 请求是对 once/match 语义的压力测试 |

替补：liustack/modsearch（552★）——agent-teams 的 spike 不过时换上，并记录换装理由。

## 执行顺序（按此优先级，便于限额中断后保留最大价值）

1. dsh-routing-suite → 2. modlens → 3. dsh-agent-teams（先 spike 后全量）
每完成一个插件即落盘该插件的全部产物并上报一次，不攒到最后。

## 每插件的四层漏斗

**L1 安装**：记录安装方式（npm/github）、钉死的版本、安装是否一次成功、失败时的安装器输出。安装失败本身是数据，记入漏斗表后继续下一个插件。

**L2 结构性冒烟（真实 API，1-2 条用例）**：oracle 从 README 承诺反推——把插件宣称的核心功能落成可判定断言（工具型：tools_called + output_contains；路由型：路由行为断言；编排型：trace 事件序列）。写不出可判定断言的承诺，记为「不可判定」并在归因表注明——不许为了凑数写橡皮图章断言。prompt 尽量短，控制 token 开销。

**L3 chaos 韧性（mock 模式，挂载插件）**：F0 对照 + F1/F4/F5 三格（不必全六格）。判定口径：与裸 chaos 基线（cases/chaos/，dsh 0.1.7-rc.2 已固化行为）对比——挂载后宿主行为不变为绿，变了为红。

**L4 归因记录**：每个红格必须给归因判定：插件 / 宿主 dsh / 模型 / harness 自身。纪律：先跑同条件裸对照（无插件）再下结论；归因证据（trace 片段、mock 送达证明、stderr 尾部）引用进记录；归不出因的标「未决」，不许猜。

## 产物落盘

- 用例：/Users/boyang/Desktop/dsh-eval-harness/cases/plugins/<插件名>/*.yml（版本钉死，可复用资产，会进 git）
- 证据：/Users/boyang/Desktop/dsh-eval-harness/.eval/plugin-check-2026-09-26/<插件名>/（report.json/md、安装日志、归因笔记；.eval 不入 git）
- 汇总：/Users/boyang/Desktop/dsh-eval-harness/.eval/plugin-check-2026-09-26/SUMMARY.md（四层漏斗表 + 归因记录表 + dsh/harness/插件版本与测试日期）

## 非目标（Out of Scope）

- 不改 harness 或 dsh 任何代码（发现必须改时停止上报）
- 不测 UI/web-only 行为；不进 judge 语义断言（本轮全结构性）
- 不做安全/破甲类插件；不发布任何结论到外部渠道

## DoD

1. 三个插件（或替补换装记录）× 四层漏斗全部落盘，SUMMARY.md 齐全
2. agent-teams 的 spike 结论有明确记录（headless 可行/不可行 + 证据）
3. 每个红格有归因判定或「未决」标注，无裸红
4. 所有用例版本钉死；报告带 dshVersion；测试日期入 SUMMARY
5. `pnpm build` / `pnpm test` / `pnpm lint` 全绿（本任务应零代码改动，跑一遍证明没碰坏）

## 风险与回滚点

- 真实 API 抖动：结构性用例红于网络原因时不计插件账上，重试或记「未决-环境」；LLM 输出抖动用 retries: 1 吸收
- 插件安装器对隔离 home 的兼容性（上游任务已 spike）；装不上 = L1 数据，不是阻塞
- 回滚：cases/plugins/ 与 .eval/ 均为新增，删除即可

## 参考素材（绝对路径）

- harness 用法：/Users/boyang/Desktop/dsh-eval-harness/README.md（mock 模式与 chaos 包一节）
- 裸 chaos 基线：/Users/boyang/Desktop/dsh-eval-harness/cases/chaos/
- 现有插件用例风格：/Users/boyang/Desktop/dsh-eval-harness/cases/real/
- key 口径：/Users/boyang/Desktop/dsh-eval-harness/bin/dsh-with-key.sh

## 执行情报补充（2026-09-26 Review Gate 期间 Planner 核查，覆盖/收紧契约相应口径）

1. **routing-suite 禁止 npm 形态安装**：npm 上的 `dsh-routing-suite@0.1.2` repository 指向
   `dragonbaba/dsh-routing-suite`（同名错位，非 7000★ 的 yjh051108 仓库）。必须
   `github:yjh051108/dsh-routing-suite#<sha>` 形态钉死，并在 SUMMARY 记录此错位（它是文章素材）。
2. **modlens**：npm 形态可用，装时钉 `@liustack/modlens@3.26.5`（2026-09-26 实测最新；
   旧文说的 3.17.2 是当时快照，不是兼容性结论）。
3. **agent-teams**：npm 无包（E404），只能 `github:NanmiCoder/dsh-agent-teams#<sha>`。
   其 package.json 无 `prepare` script（有 `prepublishOnly`）——pnpm 对 git 依赖的构建拦截
   （allowBuilds）是否触发未实测，spike 见分晓；若命中 allowBuilds 拦截，属 harness 能力边界，
   按硬停止上报（本任务零代码改动约束优先），不现场绕过。附带观察：该仓库自带
   `verify:harness-contract` 等 TDD 链，高星插件里少见的自带验证，可记入归因笔记。

## 执行变更记录（2026-09-26，Executor 上报 + Planner 复核确认）

1. **顺序偏离**：github 通道中断 40+ 分钟，routing-suite（github 形态）受阻，执行序改为
   modlens → routing-suite → agent-teams；价值取向不变，SUMMARY 有记录。
2. **情报修正**：契约执行情报的「agent-teams npm 无包」系查裸名之误，真包为 scoped
   `@nanmicoder/dsh-agent-teams@0.1.21`（npm 一次装成）——Planner 情报失误，Executor 修正正确。
3. **routing-suite L1 红**：prepare 构建被 pnpm 11 默认拦截 → injector/lib 缺失 → 插件未激活；
   真实 profile 与隔离 home 两地一致复现。归因为 harness 能力边界（allowBuilds 未预置），
   Executor 按契约「不现场绕过」未手工解锁。后续任务候选。
4. **两个未修缺陷（只记录，未改代码）**：
   a. harness：runOne 超时 SIGKILL 只杀直接子进程，包装器 dsh_bin 的孙进程孤儿化占住管道 →
      runner 永挂（实撞 34 分钟）；本轮以 exec 包装器绕开，根治候选=进程组杀/detached。
   b. dsh 宿主：真实 home 新建 profile 首启挂起（老 profile/隔离 home 正常），机制未决，
      建议携 sample/lsof 证据向上游报障。
5. **modlens 归因 v1→v1 推翻**：Executor 初判「插件启动阻塞」，用全新空 profile 对照后推翻
   并改写为宿主层挂起——归因推翻过程保留在 modlens/ATTRIBUTION.md。
6. **Review 新发现（Planner）**：pnpm-lock.yaml 被污染（+66 行 .eval/... importer 条目）——
   证据目录在仓库内，安装器 pnpm 向上发现根 workspace 并注册 mock-home profile 为 importer。
   非 Executor 代码错误，属「证据目录位置 × pnpm 工作区发现」结构性碰撞。处置见 Review Card。
