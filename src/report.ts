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
    `- 结束时间：${report.finishedAt}`,
    `- 总耗时：${report.durationMs} ms`,
    `- profile：${report.profile}`,
    ...(report.dshVersion === undefined ? [] : [`- dsh 版本：${mdEscape(report.dshVersion)}`]),
    `- 汇总：共 ${report.summary.total} 条，PASS ${report.summary.passed} / FAIL ${report.summary.failed} / ERROR ${report.summary.errored}`,
    '',
    '| 用例 | 结果 | steps | events/skipped | tokens total (in+out+reas; cacheR+cacheW) | turn_end | 可靠性 (trials) | 耗时 ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const c of report.cases) {
    // flaky 用例（重跑后才过）在状态列标记实际 attempt 数，提醒排查抖动来源
    const status = c.flaky === true ? `${c.status.toUpperCase()} (flaky, ${c.attempts} attempts)` : c.status.toUpperCase()
    // 可靠性列仅 trials > 1 时有值：p=单次成功率 + pass@k/pass^k（括号里是通过数/trial 数）
    const reliability =
      c.reliability === undefined
        ? '-'
        : `p=${c.reliability.successRate.toFixed(2)} pass@${c.reliability.k}=${c.reliability.passAtK.toFixed(2)} pass^${c.reliability.k}=${c.reliability.passPowK.toFixed(2)} (${c.reliability.passes}/${c.reliability.trials})`
    lines.push(
      `| ${mdEscape(c.name)} | ${status} | ${c.steps} | ${c.events}/${c.skippedLines} | ${formatTokens(c.tokens)} | ${c.turnEnd ?? '-'} | ${reliability} | ${c.durationMs} |`,
    )
  }
  const failed = report.cases.filter((c) => c.status !== 'pass')
  const withHistory = report.cases.filter((c) => c.attemptResults.length > 1)
  if (failed.length > 0 || withHistory.length > 0) {
    lines.push('', '## 失败明细', '')
    for (const c of [...failed, ...withHistory.filter((c) => !failed.includes(c))]) {
      lines.push(`### ${c.name}`, '')
      if (c.error) lines.push(`- error: ${mdEscape(c.error)}`)
      if (c.exitCode !== undefined) lines.push(`- exit code: ${c.exitCode ?? 'signal/unknown'}`)
      if (c.timedOut === true) lines.push('- timed out: true')
      if (c.stderrTail) lines.push(`- stderr: ${mdEscape(c.stderrTail)}`)
      for (const f of c.failures) lines.push(`- ${mdEscape(f)}`)
      for (const e of c.toolErrors) lines.push(`- tool error: ${mdEscape(e.name)}: ${mdEscape(e.error)}`)
      if (c.attemptResults.length > 1) {
        lines.push('', '#### Attempt 历史', '')
        for (const attempt of c.attemptResults) {
          const details = [
            attempt.status.toUpperCase(),
            `${attempt.durationMs} ms`,
            `events ${attempt.events}`,
            `skipped ${attempt.skippedLines}`,
            `tokens ${attempt.tokens.total}`,
            ...(attempt.timedOut === true ? ['timeout'] : []),
            ...(attempt.exitCode !== undefined && attempt.exitCode !== 0 ? [`exit ${attempt.exitCode ?? 'signal'}`] : []),
          ]
          lines.push(`- attempt ${attempt.index}: ${details.join(', ')}`)
          for (const failure of attempt.failures) lines.push(`  - ${mdEscape(failure)}`)
          if (attempt.error) lines.push(`  - error: ${mdEscape(attempt.error)}`)
        }
      }
      lines.push('')
    }
  }
  return `${lines.join('\n')}\n`
}
