# 契约快照 fixture

这两个文件是 **真实 dsh 落盘帧** 的脱敏快照，用来锁定 collector 对帧形状的
假设，防止「形状假设翻车」回归（上一轮 `tool/result` 的真实形状是
`data.message.content[]` 里的 `tool-result` 块，而非顶层 `content`/`error`，
就是缺这种快照测试才没拦住）。

## 来源

- `real-session.jsonl`：从本机真实会话
  `$DSH_HOME/sessions/.../session.jsonl.zstd`（多帧 zstd）解压后，抽取
  代表性帧、按 key 脱敏得到。结构（字段名/嵌套/类型/枚举值）与真实落盘
  字节一致；内容字符串替换为 `<key>` 占位，`id`/`callId`/`toolCallId` 保持
  相等关系映射为 `call-N`（保证 collector 的 callId→工具名关联仍可验证）。
- `real-session.jsonl.zstd`：上述 JSONL 按
  `dsh-session-persistence-jsonl` 的帧布局重新编码（首帧恰为 header 行，
  后续每帧一个事件批，checksum 开启），供 zstd 直读路径测试。

生成脚本：`scripts/gen-fixtures.mjs`（一次性，输入是真实 `.zstd` 文件；
因脱敏后产物已入库，无需在 CI 里重跑）。

## 覆盖的真实帧形状

| 帧 | 关键契约 |
| --- | --- |
| `session` | header 行，非事件信封（无 `seq`/`data`） |
| `turn/start` `user/message` | 事件信封 `{ type, seq, time, data }`；surface 事件带 `surfaceOp`/`sourceEventSeqs` |
| `assistant/message` | `data.message.content[]` 内容块 + `data.usage` 分字段（含 cacheRead/reasoning） |
| `tool/call` | `data.{ turn, step, callId, name, arguments(string) }` |
| `tool/result`（成功） | `data.message.content[]` 的 `tool-result` 块（`isError:false`） |
| `tool/result`（带 error 身份） | 顶层 `data.error { name, code }` + 块内 `isError:true` |
| `tool/result`（纯 isError） | 无 `data.error`，仅块内 `isError:true`（08-read-image 类） |
| `step/end` `turn/end` | `data.{ turn, step }` / `data.reason.kind` |
| `text-chunks` `tool-call-chunks` | 打包行（collector 应忽略、不误计） |

快照测试见 `tests/zstd.spec.ts` 的 `real on-disk contract fixture (P2)`。
