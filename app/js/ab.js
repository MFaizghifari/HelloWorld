// A/B test statistics: pure functions, unit-tested.
//
// The test is fixed-horizon: the sample size is decided up front from the
// baseline conversion and the smallest lift worth detecting, and a winner is
// only declared once both variants reach it. Checking a running test and
// stopping at the first "significant" moment inflates false positives
// (Evan Miller, "How Not To Run an A/B Test").

export const MIN_DAYS = 7; // one full weekly cycle: weekday and weekend visitors behave differently
export const DEFAULT_MDE = 0.05; // smallest absolute lift worth detecting: 5 percentage points
const Z_ALPHA = 1.959964; // two-sided α = 0.05
const Z_POWER = 0.841621; // power = 0.80

/** Standard normal CDF (Abramowitz & Stegun 7.1.26, |error| < 1.5e-7). */
export function normCdf(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

/**
 * Visitors needed per variant to detect an absolute lift of `mde` from
 * baseline rate `p` (two-sided α 5%, power 80%).
 */
export function sampleSizePerVariant(p, mde = DEFAULT_MDE) {
  const p1 = Math.min(0.99, Math.max(0.01, Number(p) || 0));
  const p2 = Math.min(0.999, p1 + mde);
  const pbar = (p1 + p2) / 2;
  const top = Z_ALPHA * Math.sqrt(2 * pbar * (1 - pbar)) + Z_POWER * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((top * top) / ((p2 - p1) ** 2));
}

/**
 * Compares conversion (completions / views) of A and B.
 * @param a,b   { views, completions }
 * @param opts  { mde, days } days = how long the test has run
 * @returns rates, lift with 95% CI, two-sided p-value, probability that B
 *   converts better (Beta posteriors, normal approximation), the sample size
 *   each variant needs, and a verdict:
 *   'collecting' | 'winner' (winner: 'A'|'B') | 'no-difference'
 */
export function compareVariants(a, b, { mde = DEFAULT_MDE, days = 0 } = {}) {
  const nA = Math.max(0, Number(a?.views) || 0);
  const nB = Math.max(0, Number(b?.views) || 0);
  const cA = Math.min(nA, Math.max(0, Number(a?.completions) || 0));
  const cB = Math.min(nB, Math.max(0, Number(b?.completions) || 0));
  const rateA = nA ? cA / nA : 0;
  const rateB = nB ? cB / nB : 0;
  const diff = rateB - rateA;

  const seDiff = nA && nB ? Math.sqrt((rateA * (1 - rateA)) / nA + (rateB * (1 - rateB)) / nB) : 0;
  const ci = [diff - Z_ALPHA * seDiff, diff + Z_ALPHA * seDiff];

  const pooled = nA + nB ? (cA + cB) / (nA + nB) : 0;
  const seZ = nA && nB ? Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB)) : 0;
  const z = seZ ? diff / seZ : 0;
  const pValue = seZ ? 2 * (1 - normCdf(Math.abs(z))) : 1;

  // Beta(1 + conversions, 1 + non-conversions) posteriors.
  const post = (c, n) => {
    const al = c + 1; const be = n - c + 1; const s = al + be;
    return { m: al / s, v: (al * be) / (s * s * (s + 1)) };
  };
  const pa = post(cA, nA);
  const pb = post(cB, nB);
  const probBBetter = normCdf((pb.m - pa.m) / Math.sqrt(pa.v + pb.v));

  // Baseline for planning: the pooled rate once there is some data, else a typical lead-form rate.
  const baseline = nA + nB >= 100 ? pooled : 0.3;
  const needed = sampleSizePerVariant(baseline, mde);
  const reached = Math.min(nA, nB) >= needed;
  let verdict = 'collecting';
  let winner = null;
  if (reached && days >= MIN_DAYS) {
    if (pValue < 0.05) { verdict = 'winner'; winner = diff > 0 ? 'B' : 'A'; } else verdict = 'no-difference';
  }
  return {
    rateA, rateB, diff, ci, pValue, probBBetter, needed, baseline, mde,
    progress: needed ? Math.min(1, Math.min(nA, nB) / needed) : 0,
    remaining: Math.max(0, needed - nA) + Math.max(0, needed - nB),
    verdict, winner,
  };
}

/** Random assignment by split (percent of visitors who get B). */
export function assignVariant(split = 50, rand = Math.random) {
  const pctB = Math.min(100, Math.max(0, Number(split)));
  return rand() * 100 < (Number.isFinite(pctB) ? pctB : 50) ? 'B' : 'A';
}
