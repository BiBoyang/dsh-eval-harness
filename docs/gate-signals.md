# gate 信号的设计理由

本文记录 eval_gate 四路「软信号」的设计取舍。改这些规则前请先读这里——每一条
都对着一次真实事故或一次明确的权衡，不是拍脑袋的默认值。

背景：2026-08，harness 在 dsh 0.1.0-rc.6 → 0.1.1-rc.2 升版后首次全量跑（并发 3）
抓到上游并发 bug（deepseek-harness Discussions #4312：`ensureSymlink` 的
`lstatSync → readlinkSync → unlinkSync` 序列缺并发防护，三进程同时 heal 共享
profile 目录时两个在 270ms 内 ENOENT 崩掉）。bug 的**检测**全靠既有基建（并发 +
隔离、非零退出永不 PASS、stderr 尾部采集、flaky 标记），但从「两条用例同时
flaky 且崩在同一函数」到「去查上游」这一步靠的是人肉翻 attempt 历史。这四路
信号就是把那一步人肉工作固化成自动告警。

## 共同权衡：灵敏度 vs 告警疲劳

WARN 是一种会被烧掉的信号。如果门禁长期黄着，人看到 WARN 的条件反射就从
「出事了」变成「哦又是它」，真正的新问题混进来时没人点开看——信号不是被关掉的，
是被磨平的。所以下面每一条 WARN 规则的回答都是同一个形状：**较 baseline 增多
才告警，已知的旧问题不重复告警**。代价是 baseline hygiene 变成隐性运维要求
（见下）。

## 1. flaky：较 baseline 增多才 WARN，不收编进 baseline

- 规则：after 里 `flaky === true` 且 baseline 中不 flaky 的用例 → WARN
  （`flakyCases`）；baseline 里残留的 flaky 用例以 `baselineFlakyCases`
  单独提示（informational，不影响判定）。
- 为什么不选「任何 flaky 都 WARN」：已知抖动的用例（如 todo-tool 首跑不调
  工具、重跑才过）会让门禁每次全量都 WARN，两周后 WARN 信用归零。
- 已知盲区（接受的代价）：
  - 新 flaky 若被顺手收编进 baseline，之后就哑了——所以纪律是 **flaky 用例
    不允许带标记收编进 baseline**，`baselineFlakyCases` 提示让现状可见。
  - 用例从「重跑 1 次才过」恶化成「重跑 3 次才过」，计数不变，不 WARN。
    恶化被基准吃掉；要抓这种退化请用 trials 模式的 successRate。

## 2. 工具错误自我纠正：pass 但 toolErrors 非空，较 baseline 新增才 WARN

- 规则：`status === 'pass' && toolErrors.length > 0` 且 baseline 中该用例无此
  状态 → WARN（`toolErrorRecoveries`）。
- 为什么需要：工具返回硬错误，agent 当作没看见、绕过它照样给出自信回答，
  最终文本和结构断言全绿——但链路并不干净。这条信号让「LLM 粉饰太平」可见。
  用例若显式要求零工具错误，应该用 `no_tool_errors` 断言（那是一票 FAIL）；
  本信号管的是「没用例级要求，但值得人看一眼」的中间地带。

## 3. stderr 错误签名聚合：同一签名 ≥2 次出小节 + WARN

- 规则：从失败 attempt 的 `stderrTail` 提取签名 `<错误码>@<栈顶应用帧函数>`
  （`extractErrorSignature`，保守提取，取不到 `Error:`/`XxxError:` 行就放弃），
  跨用例跨 attempt 聚合；出现 ≥2 次 → gate WARN（`repeatedErrorSignatures`）
  + report.md 出「错误签名聚合」小节。
- 为什么存在：flaky 信号告诉你「有抖动」，签名聚合告诉你「抖在同一处，去查
  共享态」。#4312 的场景（两条用例并发崩在 `ensureSymlink`）正是共享态事故
  的典型形状。一次共享资源事故（上游并发竞态、环境损坏、磁盘满）会让多条
  用例崩出同一签名——这不是用例的问题。
- 为什么接受与 flaky 信号「双倍计票」：两路信号指向同一事故时 reasons 会各写
  一条，输出偏吵。替代方案（聚合只在 flaky 未覆盖时 WARN）把两条规则耦合起来，
  复杂度上不划算；真嫌吵再改。
- 为什么阈值不做可配置：≥2 恰好是 #4312 被抓到的规模；旋钮要等「某天觉得
  太吵」才有收益，为想象中的需求加配置违反本仓的极简哲学。
- 已知局限：签名是启发式诊断视图，不是判定依据；提取规则未来调整会改变对旧
  报告的解读（签名不固化进报告 schema，是消费侧现算的）。

## 4. dsh 版本切换：informational，不影响判定

- 规则：`before.dshVersion` 与 `after.dshVersion` 都在且不同 → 加 reason +
  文本输出 `DSH_VERSION_CHANGED=X -> Y`，verdict 不变。
- 为什么不升 WARN：升版后跑全量回归是本 harness 的主用途，版本变化本身必出
  WARN 会让每次升版后的第一次 gate 永远黄色——又是告警疲劳。WARN 要留给
  「证据表明有问题」。
- 为什么又要留痕：rc.6 的 PASS 和 rc.2 的 PASS 不是同一个 PASS，跨版本结果
  不可直接比；且升版后首跑是上游共享态重建（profile 目录 heal）的高危时刻——
  #4312 恰好只在这个时刻触发。CI 想感知可 grep `DSH_VERSION_CHANGED` 行
  （gate 文本输出本来就是给 CI grep 设计的，比退出码更合本项目的习惯）。

## 5. trials 可靠性门禁：Wilson 下界、WARN、默认关闭

- 规则：`min_trial_success_rate`（0-1，缺省关闭）开启后，带 `reliability` 的用例
  若 successRate 的**单侧 95% Wilson 下界**低于阈值 → WARN（`unreliableCases`）。
- 为什么判下界不判点估计：「成功率不低于阈值」是单侧问题，该用单侧上/下界而非
  对称区间；且小样本下点估计有欺骗性——10 次过 9 次点估计 0.9，下界只有约 0.65。
  （正是 Codex review 指出的：尺子测出不可靠，门禁却不消费读数，就是另一种
  pass@k 遮羞布。）
- 为什么默认关闭：「trials 只测量不门禁」是既有语义，把它变成硬信号必须是显式
  选择，不能是静默行为变化；且阈值定多少需要各项目自己的数据积累。
- 为什么是 WARN 不是 FAIL：可靠性是趋势信号而非单点正确性——一次抖动不该拦
  合并；要硬门槛用 strict 模式（WARN 退出码变 2）。
- 口径注意：pass^k 自 0.3.x 起改用无偏组合估计 C(c,k)/C(n,k)（旧版为 plug-in
  (c/n)^k，向上偏），新旧报告的 passPowK 数值不可直接比。

## 验证锚点

历史报告可作为这四路信号的端到端回归夹具：

```
before = .eval/v0.3.2-candidate/report.json   (dsh 0.1.0-rc.6)
after  = .eval/v0.3.2-candidate2/report.json  (dsh 0.1.1-rc.2, 两条 ENOENT flaky)
```

预期输出：WARN；`FLAKY=2`、`REPEATED_ERROR_SIGNATURES=1`
（`ENOENT@ensureSymlink` x2 across [bash-tool, fs-write-read]）、
`DSH_VERSION_CHANGED=0.1.0-rc.6 -> 0.1.1-rc.2`。
即：如果这套逻辑当时存在，门禁会自己把 #4312 喊出来，不用等人翻报告。
