import type { AttemptResult, CaseReliability } from './types.js'

/** 组合数 C(n, k)（循环乘法避免阶乘溢出；评测场景 n 很小） */
export function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  const m = Math.min(k, n - k)
  let result = 1
  for (let i = 0; i < m; i++) {
    result = (result * (n - i)) / (i + 1)
  }
  return result
}

/**
 * 无偏 pass@k 估计（human-eval 口径）：n 次独立 trial 过 c 次时，
 * k 次尝试至少过一次的概率 = 1 - C(n-c, k)/C(n, k)。
 * 不用 naive 的 1-(1-c/n)^k：小 n 下它有偏。
 */
export function estimatePassAtK(trials: number, passes: number, k: number): number {
  if (!Number.isInteger(trials) || trials < 1) throw new Error(`trials must be a positive integer, got ${trials}`)
  if (!Number.isInteger(passes) || passes < 0 || passes > trials) throw new Error(`passes must be an integer in [0, ${trials}], got ${passes}`)
  if (!Number.isInteger(k) || k < 1 || k > trials) throw new Error(`k must be an integer in [1, ${trials}], got ${k}`)
  return 1 - binomial(trials - passes, k) / binomial(trials, k)
}

/**
 * pass^k：k 次独立尝试全部通过的概率。用无偏组合估计 C(c,k)/C(n,k)
 * （随机抽 k 个不同 trial 全过的比例），c < k 时为 0。
 * 不用 plug-in 的 (c/n)^k：x^k 在 [0,1] 上凸，Jensen 不等式保证它向上偏
 * （n=3,c=2,k=2 时 plug-in 得 4/9，无偏估计得 1/3）。k 的校验与 estimatePassAtK 相同
 */
export function estimatePassPowK(trials: number, passes: number, k: number): number {
  if (!Number.isInteger(k) || k < 1 || k > trials) throw new Error(`k must be an integer in [1, ${trials}], got ${k}`)
  return binomial(passes, k) / binomial(trials, k)
}

/** 从 attempt 历史聚合一出一条用例的可靠性测量（trials 由调用方保证等于 results.length） */
export function buildReliability(results: readonly AttemptResult[], k: number): CaseReliability {
  const trials = results.length
  const passes = results.filter((r) => r.status === 'pass').length
  return {
    trials,
    passes,
    successRate: passes / trials,
    passAtK: estimatePassAtK(trials, passes, k),
    passPowK: estimatePassPowK(trials, passes, k),
    k,
  }
}

/**
 * 单侧 95% Wilson 下置信界（z = 1.645）。
 * 门禁语义是「成功率不低于阈值」——单侧问题，用单侧下界而不是对称区间；
 * 小样本下点估计再好看，下界也会把它打回现实。
 */
export function wilsonLowerBoundOneSided95(passes: number, trials: number): number {
  if (!Number.isInteger(trials) || trials < 1) throw new Error(`trials must be a positive integer, got ${trials}`)
  if (!Number.isInteger(passes) || passes < 0 || passes > trials) throw new Error(`passes must be an integer in [0, ${trials}], got ${passes}`)
  const z = 1.645
  const z2 = z * z
  const p = passes / trials
  const denominator = 1 + z2 / trials
  const center = p + z2 / (2 * trials)
  const margin = z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))
  return (center - margin) / denominator
}
