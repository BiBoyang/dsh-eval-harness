// 黄金样本抓取：对真实 DeepSeek API 抓三协议 F0 正常流 + 三协议真实截断流，
// SSE 原文落盘为 tests/fixtures/golden/<name>.sse.txt，并写 manifest.json
// （每份标注抓取日期、API 端点、关键请求参数）。
//
// 这是全套 mock 工作流里唯一允许连真实 API 的路径；key 只从环境变量
// DEEPSEEK_API_KEY 读取——不入库、不进任何产物文件。抓取量：6 个流式请求
// （三个正常流 + 三个 max_tokens=1/16 的截断流），token 量级在几百以内。
//
// 用法：DEEPSEEK_API_KEY=sk-... node scripts/capture-golden.mjs [输出目录]
// 可选环境变量：GOLDEN_MODEL（默认 deepseek-chat）

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const KEY = process.env.DEEPSEEK_API_KEY
if (!KEY) {
  console.error('capture-golden: DEEPSEEK_API_KEY 未设置（key 只从环境变量读取，不入库）')
  process.exit(2)
}
const OUT_DIR = process.argv[2] ?? 'tests/fixtures/golden'
const MODEL = process.env.GOLDEN_MODEL ?? 'deepseek-chat'
const CC_URL = 'https://api.deepseek.com/v1/chat/completions'
const RS_URL = 'https://api.deepseek.com/v1/responses'
const AN_URL = 'https://api.deepseek.com/anthropic/v1/messages'

const F0_PROMPT = '用中文写一段关于秋天果园的短文，大约一百五十字，分两段。'
const TRUNC_PROMPT = '从 1 逐个数到 100，每行一个阿拉伯数字，不要省略任何一行。'

/** 发起流式请求并把 SSE 原文完整读回 */
async function captureSse(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    out += dec.decode(value, { stream: true })
  }
  return out + dec.decode()
}

const bearer = { authorization: `Bearer ${KEY}` }
const anthropic = { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' }

const CAPTURES = [
  {
    name: 'cc-f0',
    note: 'Chat Completions F0 正常流',
    url: CC_URL,
    headers: bearer,
    request: { model: MODEL, stream: true, messages: [{ role: 'user', content: F0_PROMPT }] },
  },
  {
    name: 'cc-truncated',
    note: 'Chat Completions 真实截断（max_tokens=1 诱发 finish_reason=length）',
    url: CC_URL,
    headers: bearer,
    request: { model: MODEL, stream: true, max_tokens: 1, messages: [{ role: 'user', content: TRUNC_PROMPT }] },
  },
  {
    name: 'responses-f0',
    note: 'Responses F0 正常流',
    url: RS_URL,
    headers: bearer,
    request: { model: MODEL, stream: true, input: F0_PROMPT },
  },
  {
    name: 'responses-truncated',
    note: 'Responses 真实截断（max_output_tokens=16 诱发 response.incomplete）——方言锚点',
    url: RS_URL,
    headers: bearer,
    request: { model: MODEL, stream: true, max_output_tokens: 16, input: TRUNC_PROMPT },
  },
  {
    name: 'anthropic-f0',
    note: 'Anthropic Messages F0 正常流',
    url: AN_URL,
    headers: anthropic,
    request: { model: MODEL, stream: true, max_tokens: 1024, messages: [{ role: 'user', content: F0_PROMPT }] },
  },
  {
    name: 'anthropic-truncated',
    note: 'Anthropic Messages 真实截断（max_tokens=1 诱发 stop_reason=max_tokens）',
    url: AN_URL,
    headers: anthropic,
    request: { model: MODEL, stream: true, max_tokens: 1, messages: [{ role: 'user', content: TRUNC_PROMPT }] },
  },
]

await mkdir(OUT_DIR, { recursive: true })
const capturedAt = new Date().toISOString()
const manifest = []
for (const c of CAPTURES) {
  const text = await captureSse(c.url, c.headers, c.request)
  const file = `${c.name}.sse.txt`
  await writeFile(join(OUT_DIR, file), text)
  manifest.push({
    file,
    capturedAt,
    endpoint: c.url,
    protocol: c.name.startsWith('cc') ? 'openai-completions' : c.name.startsWith('responses') ? 'openai-responses' : 'anthropic-messages',
    model: MODEL,
    note: c.note,
    request: { ...c.request, stream: true },
    bytes: Buffer.byteLength(text),
  })
  console.log(`captured ${file}: ${Buffer.byteLength(text)} bytes (${c.note})`)
}
await writeFile(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`manifest -> ${join(OUT_DIR, 'manifest.json')}`)
