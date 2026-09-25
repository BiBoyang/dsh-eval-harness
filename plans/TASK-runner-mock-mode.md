# TASK-runner-mock-mode：runner 接入 mock 模式 + exit_code 断言

> 任务契约（长期保留）。配套派发提示词：/Users/boyang/Desktop/dsh-eval-harness/prompts/TASK-runner-mock-mode.prompt.md
> 创建：2026-09-26 ｜ 状态：pending ｜ 依赖：TASK-mock-core ｜ 批次：2

## 目标

让 `eval_run` 支持用例级 `mock:` 声明：跑该用例时自动起 per-case mock server、生成隔离 DSH_HOME 指向它、把 mock 送达证明附进报告；同时补上 `exit_code` 断言缺口（横评证明 dsh F4/F5 的唯一用户可见信号是 exit 1，runner 已记录 exitCode 但断言层没接）。

## 需求规格（Owner 已拍板）

- per-case 起独立 mock server（ephemeral port），不用共享 server——并发用例零串扰，确定性优先于省端口
- DSH_HOME 隔离生成，不碰用户真实 `~/.dsh`
- v1 用例 `mock:` 段只声明 `fault`（F0-F5），不支持 script
- 送达证明进报告（信息层），暂不做 `mock_witness` 断言（v2）
- 断网可跑列为验收标准

## 范围（In Scope）

修改：
- `/Users/boyang/Desktop/dsh-eval-harness/src/types.ts` —— case schema 加 `mock?: { fault?: 'F0'|...|'F5' }`；断言类型加 `exit_code?: number`
- `/Users/boyang/Desktop/dsh-eval-harness/src/runner.ts` —— mock 模式接线（见设计要点）
- `/Users/boyang/Desktop/dsh-eval-harness/src/assert.ts` —— `exit_code` 断言（与 CaseResult.exitCode 比对；未声明不断言）
- `/Users/boyang/Desktop/dsh-eval-harness/src/report.ts` —— attemptResults 附 mock 送达证明摘要（仅 mock 用例有此字段）
- `/Users/boyang/Desktop/dsh-eval-harness/src/gate.ts` —— 若报告校验对新字段过严则放行（保持 legacy 兼容策略）
- 对应测试：tests/runner.spec.ts、tests/assert.spec.ts、tests/report.spec.ts、tests/gate.spec.ts（按需）

不改：yaml-mini.ts——`mock:` 段规定用块级 map 写法（yaml-mini 已支持块级 map），不为其扩展语法。

## 设计要点（接口形状，非实现）

- runner 检测用例带 `mock` 段 → 调 `startMockServer({ fault, port: 0 })`（来自 src/mock.ts）→ 生成 `<outputDir>/.mock-home-<case>/` 作为 DSH_HOME：
  - `settings.yaml`：`llm-pi-ai.providers.mock`（api 按三协议之一、baseURL 指向 ephemeral port、apiKeyEnv MOCK_API_KEY、models: mock-model）+ `agent-default-model` 指向 mock/mock-model
  - 子进程 env 注入 `DSH_HOME` 与 `MOCK_API_KEY=mock`（现有 `env: {...process.env}` 透传基础上覆盖这两项）
  - 用例结束 close() server；异常路径也要回收（try/finally）
- 协议选择：v1 默认 `openai-completions`（三协议里 dsh 最常用路径）；用例可加 `mock.api` 覆盖（openai-completions / openai-responses / anthropic-messages）
- attemptResults 新增可选字段 `mockDelivery`：{ bytesSent, eventsCount, terminalWitnesses, closeMode } 数组（每 LLM 请求一条）
- spike 先行（示踪弹）：正式铺开前先打通最小路径——一条带 `mock: {fault: F0}` 的文本用例在 mock 模式下跑出 PASS。spike 不通则回炉，不在错误地基上继续

## 已验证的参照实现（横评实测跑通，直接照抄结构）

/Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/run/dsh-home/ —— 一个能工作的隔离 DSH_HOME（settings.yaml.imported + profiles/headless/）。注意文件名是 `.imported`（dsh 首次运行会 import 改名），生成逻辑与 dsh 的兼容细节以实测为准；dsh 仓库文档 /Users/boyang/deepseek-harness/docs/user/guide/providers.zh.md 有 providers 配置权威说明。

## DoD

1. spike 证据：mock 模式 F0 用例 PASS（命令 + 输出贴进上报）
2. 断网验收：环境无 DEEPSEEK_API_KEY 时 mock 用例照常 PASS
3. `exit_code` 断言单测：匹配/不匹配/未声明三态
4. 端口与 DSH_HOME 生命周期：并发 2 个 mock 用例互不串扰（单测或集成测试证明）；用例结束后无残留监听端口
5. `pnpm build` / `pnpm test` / `pnpm lint` 全绿；现有测试（真实 API 路径）不因本改动破裂——涉及真实 API 的测试若本机无 key 可跳过，但必须在上报中说明哪些没跑

## 风险与回滚点

- gate.ts 报告校验严格（未知字段可能报错）——新字段要同步进校验白名单并补测试；不许用放宽校验的方式糊过去
- DSH_HOME 生成细节与 dsh 版本耦合（当前钉 0.1.7-rc.2）——在生成代码里注释标注版本锚点
- 回滚点：spike 通过前为天然回滚点；之后按文件粒度 revert

## 参考素材（绝对路径）

- 上游模块：/Users/boyang/Desktop/dsh-eval-harness/src/mock.ts（TASK-mock-core 产出）
- dsh 仓库（协议/settings 参考，只读）：/Users/boyang/deepseek-harness
- 横评矩阵 dsh 结果（行为基线）：/Users/boyang/Documents/kimi/tasks/2026-09-24/00-58-40-2ddbe2bf/mock-provider/matrix/RESULTS-dsh-cc.md

## 执行变更记录（2026-09-26，Executor 上报 + Planner 复核确认）

1. **范围扩展（Owner 已知情）**：用例 `mock:` 段增加 `once?: boolean`——横评矩阵的基线行为（F1-F3 静默自愈）是在 once 注入语义下测得的；持续注入下重试必失败、基线不可复现。实现与横评同构：server 起在 F0，故障经控制面 once 武装。改动落在本任务清单文件内（runner/types），mock.ts 未动
2. **计划外必要修复 ①**：`findSessionFile` 原只认 session.jsonl(.zstd)，dsh 0.1.7-rc.2 落盘为 session.v4.jsonl.zstd（代际命名）——按 dsh 源码 session-format/filename.ts 修正则匹配，否则真实 dsh 采集全灭
3. **计划外必要修复 ②**：声明 `exit_code` 的非零退出进断言层比对（原逻辑非零即 error，chaos 用例断言不可达）
4. mock 模式子进程 env 额外清理代理变量（http_proxy 等六个），防本机代理劫持 localhost mock 流量
