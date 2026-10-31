#!/usr/bin/env node
// 探针 agent（伪造 dsh，不解题）：按 dsh 命令行协议落一份 session 日志，用来检验判分
// 会不会被不解题的 agent 骗过。不连任何 LLM，不执行 prompt 里的任何命令，只写 overlay
// 指定的 session 根，不碰真实 ~/.dsh。底稿：docs/EVAL-HARDENING-DESIGN.md 附录 A。
//
// 模式（环境变量 PROBE_MODE，缺省或取值不认识时 exit 2，不静默退化成某个模式）：
//   do-nothing : 不调工具、空回复、turn_end=completed、exit 0
//   parrot     : 按 prompt 中「<name> 工具」字样依序调用（去重），参数为整段 prompt，
//                工具结果一律报错；最终回复 = 复述 prompt
//
// 协议：`--version` 打印探针版本；正常调用为 `--profile <p> --patch <overlay> <prompt>`
// （src/runner.ts 的 buildDshArgs）。
// 用法：runEval({ dshBin: `${process.execPath} <本文件绝对路径>` })——splitDshBin 按空白
// 拆分，经 node 启动不依赖文件可执行位。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MODES = ['do-nothing', 'parrot']

function fail(message) {
  process.stderr.write(`fake-dsh: ${message}\n`)
  process.exit(2)
}

const argv = process.argv.slice(2)
if (argv[0] === '--version') {
  console.log('0.0.0-probe')
  process.exit(0)
}
const mode = process.env.PROBE_MODE
if (!MODES.includes(mode)) fail(`PROBE_MODE must be one of ${MODES.join(' | ')}, got '${mode ?? ''}'`)

// launcher flags 在前（--profile / --patch 各带一个值），第一个其它 token 即 prompt
let overlay
let prompt
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--profile') i++
  else if (argv[i] === '--patch') overlay = argv[++i]
  else {
    prompt = argv[i]
    break
  }
}
if (overlay === undefined) fail('missing --patch <overlay>')
if (prompt === undefined) fail('missing <prompt>')

// overlay 的 root 是 JSON 转义的 YAML 双引号标量（src/runner.ts 的 buildOverlayYaml）
const rootMatch = /^\s+root: (".*")$/m.exec(readFileSync(overlay, 'utf8'))
if (!rootMatch) fail(`no session root in overlay '${overlay}'`)
const dir = join(JSON.parse(rootMatch[1]), 'case', 'session-probe')
mkdirSync(dir, { recursive: true })

const frames = [{ type: 'session', version: 0, id: 's', createdAt: 1, cwd: '/x', delegationDepth: 0 }]
let seq = 0
const ev = (type, data) => frames.push({ type, seq: ++seq, time: 1, data })
let step = 0
let finalText = ''
if (mode === 'parrot') {
  const tools = [...new Set([...prompt.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*工具/g)].map((m) => m[1]))]
  for (const name of tools) {
    step++
    const callId = `c${step}`
    ev('tool/call', { turn: 1, step, callId, name, arguments: JSON.stringify({ input: prompt }) })
    // 真实落盘形状：结果在 message.content[] 的 tool-result 块里，isError=true
    ev('tool/result', {
      turn: 1,
      step,
      message: {
        source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'simulated: invalid arguments' }], isError: true }],
        role: 'user',
        id: `r${step}`,
      },
    })
    ev('step/end', { turn: 1, step })
  }
  finalText = prompt
}
step++
ev('assistant/message', { turn: 1, step, message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } })
ev('step/end', { turn: 1, step })
ev('turn/end', { turn: 1, reason: { kind: 'completed' } })
writeFileSync(join(dir, 'session.jsonl'), `${frames.map((f) => JSON.stringify(f)).join('\n')}\n`)
