import { describe, expect, it } from 'vitest'
import { binomial, buildReliability, estimatePassAtK, estimatePassPowK, wilsonLowerBoundOneSided95 } from '../src/reliability.ts'
import type { AttemptResult } from '../src/types.ts'

/** 最小 AttemptResult：只有 status 影响可靠性聚合 */
const attempt = (status: AttemptResult['status']): AttemptResult => ({
  index: 1,
  status,
  failures: [],
  toolsCalled: [],
  toolCalls: [],
  toolResults: [],
  finalText: '',
  steps: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
  toolErrors: [],
  events: 0,
  skippedLines: 0,
  durationMs: 1,
})

describe('binomial', () => {
  it('computes small combinations and returns 0 out of range', () => {
    expect(binomial(3, 2)).toBe(3)
    expect(binomial(10, 3)).toBe(120)
    expect(binomial(5, 0)).toBe(1)
    expect(binomial(3, 4)).toBe(0)
    expect(binomial(3, -1)).toBe(0)
  })
})

describe('estimatePassAtK', () => {
  it('matches the human-eval unbiased estimator on known values', () => {
    // n=3, c=2, k=2: 1 - C(1,2)/C(3,2) = 1 - 0/3 = 1
    expect(estimatePassAtK(3, 2, 2)).toBe(1)
    // n=3, c=2, k=1: 1 - C(1,1)/C(3,1) = 1 - 1/3 = 2/3 = c/n
    expect(estimatePassAtK(3, 2, 1)).toBeCloseTo(2 / 3)
    // n=4, c=3, k=2: 1 - C(1,2)/C(4,2) = 1
    expect(estimatePassAtK(4, 3, 2)).toBe(1)
    // n=10, c=7, k=2: 1 - C(3,2)/C(10,2) = 1 - 3/45 ≈ 0.9333
    expect(estimatePassAtK(10, 7, 2)).toBeCloseTo(1 - 3 / 45)
  })

  it('is 0 when nothing passed and 1 when everything passed', () => {
    expect(estimatePassAtK(5, 0, 2)).toBe(0)
    expect(estimatePassAtK(5, 5, 2)).toBe(1)
  })

  it('rejects k > trials (small-n extrapolation would be falsely precise)', () => {
    expect(() => estimatePassAtK(3, 2, 10)).toThrow(/k must be an integer/)
    expect(() => estimatePassAtK(3, 2, 0)).toThrow(/k must be an integer/)
    expect(() => estimatePassPowK(3, 2, 4)).toThrow(/k must be an integer/)
  })
})

describe('estimatePassPowK', () => {
  it('is the unbiased combinatorial estimate C(c,k)/C(n,k)', () => {
    // n=3, c=2, k=2: C(2,2)/C(3,2) = 1/3（plug-in (c/n)^k 会给 4/9，向上偏）
    expect(estimatePassPowK(3, 2, 2)).toBeCloseTo(1 / 3)
    // k=1 时退化为 c/n
    expect(estimatePassPowK(10, 7, 1)).toBeCloseTo(0.7)
    // c < k 时必然为 0
    expect(estimatePassPowK(3, 2, 3)).toBe(0)
    // 可靠性叙事的极端形态：n=10, c=8, k=10 → C(8,10)/C(10,10) = 0
    expect(estimatePassPowK(10, 8, 10)).toBe(0)
    // 全过时为 1
    expect(estimatePassPowK(10, 10, 10)).toBe(1)
  })
})

describe('wilsonLowerBoundOneSided95', () => {
  it('matches hand-computed values', () => {
    // n=10, c=9：点估计 0.9，单侧 95% 下界约 0.652——小样本下界远低于点估计
    expect(wilsonLowerBoundOneSided95(9, 10)).toBeCloseTo(0.652, 2)
    // n=100, c=96：下界约 0.914
    expect(wilsonLowerBoundOneSided95(96, 100)).toBeCloseTo(0.914, 2)
  })

  it('is 0 when nothing passed and below 1 even when everything passed', () => {
    expect(wilsonLowerBoundOneSided95(0, 10)).toBe(0)
    const perfect = wilsonLowerBoundOneSided95(10, 10)
    expect(perfect).toBeLessThan(1)
    expect(perfect).toBeGreaterThan(0.7)
  })

  it('rejects invalid inputs', () => {
    expect(() => wilsonLowerBoundOneSided95(4, 3)).toThrow(/passes must be an integer/)
    expect(() => wilsonLowerBoundOneSided95(1, 0)).toThrow(/trials must be a positive integer/)
  })
})

describe('buildReliability', () => {
  it('aggregates attempt history into a reliability block', () => {
    const r = buildReliability([attempt('fail'), attempt('pass'), attempt('pass')], 2)
    expect(r.trials).toBe(3)
    expect(r.passes).toBe(2)
    expect(r.k).toBe(2)
    expect(r.successRate).toBeCloseTo(2 / 3)
    expect(r.passAtK).toBe(1)
    expect(r.passPowK).toBeCloseTo(1 / 3)
  })
})
