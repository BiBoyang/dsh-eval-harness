/**
 * 迷你 YAML 子集解析器（零依赖，dependencies 按 dsh bundle 契约留空）。
 *
 * 仅支持评测用例文件需要的子集：
 * - 块级 map（`key: value` / `key:` + 缩进子节点）
 * - 块级序列（`- item`；元素为标量/flow，或以 `- key: value` 起头的 map，map 续行缩进对齐到 `- ` 之后）
 * - flow 序列（`[a, b, "c"]`，元素为标量，不支持嵌套 flow）
 * - 标量：双引号（\" \\ \n \t 转义）、单引号（'' 转义）、plain string、number、true/false/null
 * - 块标量 `|`（保留换行）/ `>`（折叠为空格），支持 `-`/`+` chomping
 * - 注释（整行 `#` 与行尾空白后的 `#`，引号内不生效）
 *
 * 不支持的结构抛出带行号的 Error（由 runner 包上 `eval_run:` 前缀）。
 */
export function parseYamlSubset(src: string): unknown {
  const lines = src.split(/\r?\n/)
  const state = { i: 0 }

  function fail(no: number, msg: string): never {
    throw new Error(`line ${no}: ${msg}`)
  }

  function skipBlank(pos: number): number {
    while (pos < lines.length) {
      const t = lines[pos].trim()
      if (t === '' || t.startsWith('#')) pos++
      else break
    }
    return pos
  }

  function indentOf(line: string, no: number): number {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('\t') || line.slice(0, line.length - trimmed.length).includes('\t')) {
      fail(no, 'tab indentation not allowed')
    }
    return line.length - trimmed.length
  }

  /** 去掉行尾注释（引号外、前面是空白的 #），返回 trimEnd 后的内容 */
  function stripComment(s: string): string {
    let inS = false
    let inD = false
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (inD && c === '\\') {
        i++
        continue
      }
      if (!inD && c === "'") inS = !inS
      else if (!inS && c === '"') inD = !inD
      else if (!inS && !inD && c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) {
        return s.slice(0, i).trimEnd()
      }
    }
    return s.trimEnd()
  }

  function parseDoubleQuoted(s: string, no: number): string {
    let out = ''
    for (let i = 1; i < s.length; i++) {
      const c = s[i]
      if (c === '\\') {
        const n = s[++i]
        if (n === 'n') out += '\n'
        else if (n === 't') out += '\t'
        else if (n === '"') out += '"'
        else if (n === '\\') out += '\\'
        else fail(no, `unsupported escape '\\${n}'`)
      } else if (c === '"') {
        const rest = s.slice(i + 1).trim()
        if (rest !== '') fail(no, `unexpected content after closing quote: '${rest}'`)
        return out
      } else {
        out += c
      }
    }
    fail(no, 'unterminated double-quoted string')
  }

  function parseSingleQuoted(s: string, no: number): string {
    let out = ''
    for (let i = 1; i < s.length; i++) {
      const c = s[i]
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'"
          i++
          continue
        }
        const rest = s.slice(i + 1).trim()
        if (rest !== '') fail(no, `unexpected content after closing quote: '${rest}'`)
        return out
      }
      out += c
    }
    fail(no, 'unterminated single-quoted string')
  }

  function parseFlowSeq(s: string, no: number): unknown[] {
    if (!s.endsWith(']')) fail(no, `unterminated flow sequence: '${s}'`)
    const inner = s.slice(1, -1).trim()
    if (inner === '') return []
    const items: string[] = []
    let cur = ''
    let inS = false
    let inD = false
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]
      if (inD && c === '\\') {
        cur += c + inner[++i]
        continue
      }
      if (!inD && c === "'") inS = !inS
      else if (!inS && c === '"') inD = !inD
      if (!inS && !inD && c === '[') fail(no, 'nested flow sequence not supported')
      if (!inS && !inD && c === ',') {
        items.push(cur)
        cur = ''
      } else {
        cur += c
      }
    }
    items.push(cur)
    return items.map((it) => parseScalar(it.trim(), no))
  }

  function parseScalar(s: string, no: number): unknown {
    if (s === '') return null
    if (s.startsWith('"')) return parseDoubleQuoted(s, no)
    if (s.startsWith("'")) return parseSingleQuoted(s, no)
    if (s.startsWith('[')) return parseFlowSeq(s, no)
    if (s === 'null' || s === '~') return null
    if (s === 'true') return true
    if (s === 'false') return false
    if (/^-?\d+$/.test(s)) return parseInt(s, 10)
    if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s)
    return s
  }

  /** 块标量：header 为 `|` 或 `>`（可带 -/+ chomping），内容从 pos 起、缩进大于 parentIndent */
  function parseBlockScalar(header: string, pos: number, parentIndent: number, no: number): [string, number] {
    const folded = header.startsWith('>')
    const chomp = header.slice(1)
    if (!/^[-+]?$/.test(chomp)) fail(no, `unsupported block scalar header '${header}'`)
    // 收集所有缩进大于 parentIndent 的原始行（含空行）
    const raw: { blank: boolean; text: string }[] = []
    let blockIndent = -1
    let p = pos
    while (p < lines.length) {
      const line = lines[p]
      if (line.trim() === '') {
        raw.push({ blank: true, text: '' })
        p++
        continue
      }
      const ind = indentOf(line, p + 1)
      if (ind <= parentIndent) break
      if (blockIndent === -1) blockIndent = ind
      raw.push({ blank: false, text: line.slice(Math.min(blockIndent, ind)) })
      p++
    }
    // 去掉尾部空行（clip 基准）
    while (raw.length > 0 && raw[raw.length - 1].blank) raw.pop()
    let out: string
    if (folded) {
      const parts: string[] = []
      for (const l of raw) parts.push(l.blank ? '\n' : l.text)
      out = parts
        .join(' ')
        .replace(/ \n /g, '\n')
        .replace(/ \n/g, '\n')
    } else {
      out = raw.map((l) => (l.blank ? '' : l.text)).join('\n')
    }
    if (chomp === '-') {
      // strip：不加尾换行
    } else if (chomp === '+') {
      out += '\n'
      let q = p
      while (q < lines.length && lines[q].trim() === '') {
        out += '\n'
        q++
      }
    } else {
      if (raw.length > 0) out += '\n' // clip：单个尾换行
    }
    return [out, p]
  }

  /** 从 pos 解析缩进为 indent 的节点，返回 [值, 下一个未消费行号] */
  function parseNode(pos: number, indent: number): [unknown, number] {
    const j = skipBlank(pos)
    if (j >= lines.length) return [null, j]
    const content = stripComment(lines[j].slice(indentOf(lines[j], j + 1)))
    if (content === '-' || content.startsWith('- ')) return parseSeq(j, indent)
    return parseMap(j, indent)
  }

  function parseMap(pos: number, indent: number): [Record<string, unknown>, number] {
    const result: Record<string, unknown> = {}
    let i = pos
    for (;;) {
      const j = skipBlank(i)
      if (j >= lines.length) return [result, j]
      const ind = indentOf(lines[j], j + 1)
      if (ind < indent) return [result, j]
      if (ind > indent) fail(j + 1, `unexpected indentation (expected ${indent} spaces)`)
      const content = stripComment(lines[j].slice(ind))
      if (content === '-' || content.startsWith('- ')) return [result, j]
      const colon = content.indexOf(':')
      if (colon <= 0) fail(j + 1, `expected 'key: value', got '${content}'`)
      const key = content.slice(0, colon).trim()
      if (key === '') fail(j + 1, 'empty key')
      if (key in result) fail(j + 1, `duplicate key '${key}'`)
      const rest = content.slice(colon + 1).trim()
      i = j + 1
      if (rest === '|' || rest === '>' || rest.startsWith('|-') || rest.startsWith('|+') || rest.startsWith('>-') || rest.startsWith('>+')) {
        const [v, next] = parseBlockScalar(rest, i, ind, j + 1)
        result[key] = v
        i = next
      } else if (rest !== '') {
        result[key] = parseScalar(rest, j + 1)
      } else {
        // 无行内值：看下一非空行是否为子节点（更深缩进，或同缩进的 `-` 序列）
        const k = skipBlank(i)
        if (k >= lines.length) {
          result[key] = null
          i = k
        } else {
          const kInd = indentOf(lines[k], k + 1)
          const kContent = stripComment(lines[k].slice(kInd))
          const isSeq = kContent === '-' || kContent.startsWith('- ')
          if (kInd > ind || (isSeq && kInd === ind)) {
            const [v, next] = parseNode(k, kInd)
            result[key] = v
            i = next
          } else {
            result[key] = null
            i = k
          }
        }
      }
    }
  }

  function parseSeq(pos: number, indent: number): [unknown[], number] {
    const result: unknown[] = []
    let i = pos
    for (;;) {
      const j = skipBlank(i)
      if (j >= lines.length) return [result, j]
      const ind = indentOf(lines[j], j + 1)
      if (ind < indent) return [result, j]
      if (ind > indent) fail(j + 1, `unexpected indentation in sequence (expected ${indent} spaces)`)
      const content = stripComment(lines[j].slice(ind))
      if (content !== '-' && !content.startsWith('- ')) return [result, j]
      const after = content.slice(1).trim()
      i = j + 1
      if (after === '') {
        const [v, next] = parseNode(i, indent + 1)
        result.push(v)
        i = next
      } else if (/^[^"'\[][^:]*:\s/.test(after) || /^[^"'\[][^:]*:$/.test(after)) {
        // 序列项 map：`- key: value`。把 `- ` 改写为两个空格（map 内容列 = ind + 2），
        // 原地按 map 重解析本行及其续行；行号不变，错误定位不受影响。
        lines[j] = ' '.repeat(ind + 2) + after
        const [v, next] = parseMap(j, ind + 2)
        result.push(v)
        i = next
      } else {
        result.push(parseScalar(after, j + 1))
      }
    }
  }

  const start = skipBlank(0)
  if (start >= lines.length) return null
  const [value] = parseNode(start, indentOf(lines[start], start + 1))
  return value
}
