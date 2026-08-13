import { ceilToBigInt } from "./fixed";
import { LmsrError } from "./lmsr";

/**
 * Linear bonding curve for startup tokens (points-denominated):
 *
 *   price(s) = p0 + slope · s        [µpts per token; s in whole tokens]
 *   cost(s → s+t) = p0·t + slope·(s·t + t²/2)
 *
 * Same fixed-point discipline as the LMSR: supply/deltas are bigint µtokens,
 * money is bigint µpts, the integral is evaluated in float64 and rounded
 * toward +∞ at the boundary (buyers pay ceil, sellers receive floor). With
 * house rounding, a buy-then-sell round trip can never profit the trader and
 * the pool that collected the buys always covers the sells.
 */

export interface CurveState {
  /** Outstanding supply, µtokens. */
  readonly supply: bigint;
  /** Launch price, µpts per whole token. */
  readonly p0: bigint;
  /** Price increase per whole token of supply, µpts/token². */
  readonly slope: bigint;
}

function assertState(state: CurveState): void {
  if (state.p0 <= 0n) throw new LmsrError(`p0 must be positive, got ${state.p0}`);
  if (state.slope < 0n) throw new LmsrError(`slope must be ≥ 0, got ${state.slope}`);
  if (state.supply < 0n) throw new LmsrError(`supply must be ≥ 0, got ${state.supply}`);
}

/** Instantaneous price, µpts per whole token. */
export function tokenPrice(state: CurveState): bigint {
  assertState(state);
  const s = Number(state.supply) / 1e6;
  return ceilToBigInt(Number(state.p0) + Number(state.slope) * s);
}

/**
 * Cost in µpts of buying (δ > 0) or selling (δ < 0) δ µtokens.
 * Positive = trader pays; negative = trader receives |cost|.
 */
export function tokenTradeCost(state: CurveState, deltaTokens: bigint): bigint {
  assertState(state);
  if (deltaTokens === 0n) return 0n;
  if (deltaTokens < 0n && -deltaTokens > state.supply) {
    throw new LmsrError("cannot sell below zero supply");
  }
  const s = Number(state.supply) / 1e6;
  const t = Number(deltaTokens) / 1e6;
  const raw = Number(state.p0) * t + Number(state.slope) * (s * t + (t * t) / 2);
  return ceilToBigInt(raw);
}

/** Largest δ ≥ 0 (µtokens) whose buy cost fits within budget (µpts). */
export function tokensForBudget(state: CurveState, budget: bigint): bigint {
  assertState(state);
  if (budget <= 0n) return 0n;
  // Upper bound: at constant launch price alone, budget buys budget/p0 tokens.
  let lo = 0n;
  let hi = (budget * 1_000_000n) / state.p0 + 1_000_000n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (tokenTradeCost(state, mid) <= budget) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

/**
 * Listing defaults from the off-ledger payment (admin-overridable):
 *   launch price p0 = max(1, usd/1000) pts per token
 *   slope: price doubles after the first 1,000 tokens bought
 * Returns µ-unit values ready for token_state.
 */
export function listingDefaults(paymentUsd: number): { p0: bigint; slope: bigint } {
  if (!Number.isFinite(paymentUsd) || paymentUsd < 0) throw new LmsrError("bad payment");
  const p0Pts = Math.max(1, paymentUsd / 1000);
  const p0 = ceilToBigInt(p0Pts * 1e6);
  const slope = ceilToBigInt((p0Pts / 1000) * 1e6);
  return { p0, slope };
}
