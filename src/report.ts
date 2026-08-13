import type { RunReport } from './types.js'

/** JSON 报告（report.json） */
export function renderJson(report: RunReport): string {
  return JSON.stringify(report, null, 2)
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** tokens 单元格：`total (in+out+reas; cacheR+cacheW)`，total 不含缓存命中 */
function formatTokens(t: RunReport['cases'][number]['tokens']): string {
  return `${t.total} (in ${t.input}+out ${t.output}+reas ${t.reasoning}; cacheR ${t.cacheRead}+cacheW ${t.cacheWrite})`
}

/** Markdown 报告（report.md）：汇总 + 用例表 + 失败明细 */
export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [
    '# dsh-eval-harness 评测报告',
    '',
    `- 开始时间：${report.startedAt}`,
    `- profile：${report.profile}`,
    `- 汇总：共 ${report.summary.total} 条，PASS ${report.summary.passed} / FAIL ${report.summary.failed} / ERROR ${report.summary.errored}`,
    '',
    '| 用例 | 结果 | steps | tokens total (in+out+reas; cacheR+cacheW) | turn_end | 耗时 ms |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const c of report.cases) {
    lines.push(
      `| ${mdEscape(c.name)} | ${c.status.toUpperCase()} | ${c.steps} | ${formatTokens(c.tokens)} | ${c.turnEnd ?? '-'} | ${c.durationMs} |`,
    )
  }
  const failed = report.cases.filter((c) => c.status !== 'pass')
  if (failed.length > 0) {
    lines.push('', '## 失败明细', '')
    for (const c of failed) {
      lines.push(`### ${c.name}`, '')
      if (c.error) lines.push(`- error: ${mdEscape(c.error)}`)
      for (const f of c.failures) lines.push(`- ${mdEscape(f)}`)
      for (const e of c.toolErrors) lines.push(`- tool error: ${mdEscape(e.name)}: ${mdEscape(e.error)}`)
      lines.push('')
    }
  }
  return lines.join('\n') + '\n'
}
