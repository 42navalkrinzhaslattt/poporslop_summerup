import { MICRO_N, ceilToBigInt } from "./fixed";

/**
 * LMSR (Hanson) market maker over n outcomes.
 *
 * C(q)  = b · ln( Σᵢ exp(qᵢ / b) )
 * pᵢ(q) = exp(qᵢ / b) / Σⱼ exp(qⱼ / b)
 *
 * q is µshares (may be negative after prior seeding), b is µpts.
 * Transcendentals run in float64 on the dimensionless ratios qᵢ/b via
 * log-sum-exp; every µpt at the boundary is rounded in the house's favor
 * (cost rounds toward +∞), so buy-then-sell round trips can never profit
 * the trader and the bounded-loss guarantee holds with margin.
 * Payouts (1 µshare of the winner = 1 µpt) are pure bigint elsewhere and
 * never enter this module.
 */

export interface LmsrState {
  /** Outstanding shares per outcome, µshares. */
  readonly q: readonly bigint[];
  /** Liquidity parameter, µpts. */
  readonly b: bigint;
}

export class LmsrError extends Error {}

function ratios(state: LmsrState): number[] {
  const b = Number(state.b);
  if (!(b > 0)) throw new LmsrError(`b must be positive, got ${state.b}`);
  if (state.q.length < 2) throw new LmsrError(`need ≥ 2 outcomes, got ${state.q.length}`);
  return state.q.map((qi) => Number(qi) / b);
}

/** log-sum-exp of qᵢ/b, stable for any magnitudes. */
function lse(x: number[]): number {
  let m = -Infinity;
  for (const v of x) if (v > m) m = v;
  let s = 0;
  for (const v of x) s += Math.exp(v - m);
  return m + Math.log(s);
}

/** C(q) in float µpts. Diagnostic / internal — costs that reach users go through tradeCost. */
export function cost(state: LmsrState): number {
  return Number(state.b) * lse(ratios(state));
}

/** Instantaneous prices as float probabilities (UI convenience; sums ≈ 1). */
export function prices(state: LmsrState): number[] {
  const x = ratios(state);
  let m = -Infinity;
  for (const v of x) if (v > m) m = v;
  const e = x.map((v) => Math.exp(v - m));
  const s = e.reduce((a, v) => a + v, 0);
  return e.map((v) => v / s);
}

/**
 * Prices as integer µprob summing to exactly 1_000_000, via largest-remainder
 * assignment of the residual. This is what goes into trades.p_* and
 * odds_snapshots.prices.
 */
export function pricesMicro(state: LmsrState): number[] {
  const p = prices(state);
  const scaled = p.map((v) => v * MICRO_N);
  const floors = scaled.map((v) => Math.floor(v));
  let residual = MICRO_N - floors.reduce((a, v) => a + v, 0);
  // Hand out the residual µprobs to the largest fractional remainders.
  const order = scaled
    .map((v, i) => ({ frac: v - floors[i]!, i }))
    .sort((a, b) => b.frac - a.frac);
  const out = floors.slice();
  for (let k = 0; residual > 0; k = (k + 1) % order.length, residual--) {
    out[order[k]!.i]!++;
  }
  return out;
}

function assertOutcome(state: LmsrState, outcomeIdx: number): void {
  if (!Number.isInteger(outcomeIdx) || outcomeIdx < 0 || outcomeIdx >= state.q.length) {
    throw new LmsrError(`outcome index ${outcomeIdx} out of range [0, ${state.q.length})`);
  }
}

/**
 * Cost in µpts of trading deltaShares (µshares, signed) of one outcome.
 * Positive = trader pays, negative = trader receives |cost|.
 * Rounds toward +∞ (house-favoring: buyers pay ceil, sellers receive floor).
 */
export function tradeCost(state: LmsrState, outcomeIdx: number, deltaShares: bigint): bigint {
  assertOutcome(state, outcomeIdx);
  if (deltaShares === 0n) return 0n;
  const b = Number(state.b);
  const x = ratios(state);
  const before = lse(x);
  const xAfter = x.slice();
  xAfter[outcomeIdx] = Number(state.q[outcomeIdx]! + deltaShares) / b;
  const after = lse(xAfter);
  return ceilToBigInt(b * (after - before));
}

/** Apply a trade: returns the new q vector and the house-rounded cost. */
export function applyTrade(
  state: LmsrState,
  outcomeIdx: number,
  deltaShares: bigint,
): { q: bigint[]; cost: bigint } {
  const c = tradeCost(state, outcomeIdx, deltaShares);
  const q = state.q.slice();
  q[outcomeIdx] = q[outcomeIdx]! + deltaShares;
  return { q, cost: c };
}

/**
 * Largest δ ≥ 0 (µshares) whose buy cost fits within budget (µpts).
 * Bigint binary search; powers the "spend N points" trade panel UX.
 */
export function sharesForBudget(state: LmsrState, outcomeIdx: number, budget: bigint): bigint {
  assertOutcome(state, outcomeIdx);
  if (budget <= 0n) return 0n;
  // cost(δ) ≥ δ − b·ln(n) − (C(q) − qᵢ) slack; δ never needs to exceed
  // budget + b · (ln n + spread). 64·b is a lazy but safe over-bound for n ≤ 64.
  let lo = 0n;
  let hi = budget + state.b * 64n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (tradeCost(state, outcomeIdx, mid) <= budget) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}
