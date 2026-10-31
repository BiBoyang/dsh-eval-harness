# REVIEW: TASK-p0-mock-sentinels（2026-10-31）

- Reviewer: Planner
- Executor: ClaudeCode（独立 worktree，P0-2 并行单之二）
- 分支: `feat/p0-mock-sentinels` @ ab574f0（基于 main@c657d06，已提交待合并）
- 结论: **Approved**

## 审计表（Planner 实跑）

| 检查项 | 结果 | 证据 |
|---|---|---|
| spike 与 S2 实测 | Done | dsh 0.1.7-rc.2 隔离安装于 /tmp（全局 npm 未动）；S2 退出码三次实测一致（exit 1）后写入断言——"先实测再写"纪律落实；Planner 复核 S1/S2 yaml 与实测一致 |
| DoD-2 本机验收 | Done | **Planner 亲手跑契约验收命令**：6/6 PASS、`healthy=true`、S1=pass、S2=fail（exit 0） |
| DoD-3 阳性对照 | Done（上报详证） | (a) S1 fault 临时改 F1 → 主体 6/6 仍 PASS 但 CI 红、gate 对同 baseline 判 FAIL、逐字节还原；(b) bypass mock 伪造【P24】→ 双哨兵 delivery-missing |
| DoD-6 三件套 | Done | Planner 实跑：build OK、**409/409**（分支基线 373+36）、lint 34 文件零警告 |
| 隔离纪律 | Done | 独立 worktree（吸取上批共用检出教训）；主检出未触碰；与 case-hardening 的 README 改动经试合并 0 冲突 |
| gate 防篡改 | Done | 读报告时拒绝手改 `healthy:true` 掩盖哨兵失败的报告；无 calibration 的旧报告判定不变 |

## 裁定与记录

1. **`SentinelResult.failures` 可选字段（契约外增补）**：**接受**。CI 只上传 report，S1 以 fail 形式失败时无此字段无法归因——这是可诊断性的必要补齐，且用户已过目。
2. **`src/index.ts` 改动（上报"没改"与现场不符）**：**接受**。上报写于该改动之前（11:19 上报，后经 Owner"并进"指示轮次追加）；内容是 `eval_run` 输出透出 `calibration` 块 + 工具描述更新，8 行，注释到位。记为"上报后增量"，流程上应在下一份上报补记。
3. **测试计数 409 vs 上报 407**：与裁定 2 的后增测试一致，吻合。
4. **S2 盲区（仅 output_contains 放水时 S2 察觉不到）**：已写入 gate-signals §7，归 P1——诚实记录，接受。
5. **DoD-5 时序**：`gh workflow run chaos.yml` 须合入 main 后可用（workflow_dispatch 只认默认分支上的文件）——本卡落笔时合并即将进行，Owner 随后触发即可；合入前可看 paths 触发的 run。
6. **status 时间戳两行估填**：执行者自纠（append 更正行，不改旧行）——append-only 纪律的正确处理。

## 变更摘要

15 文件 +1144/−38：哨兵用例×2、sentinel.ts、runner/gate/report/types 接线、chaos.yml、fake-dsh relay 模式、单测 +36、README/gate-signals 文档。回滚：`sentinels` 开关 + 新文件删除。
