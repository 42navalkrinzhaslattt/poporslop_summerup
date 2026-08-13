import { roundToBigInt, ceilToBigInt } from "./fixed";
import { LmsrError } from "./lmsr";

/**
 * Initial q so opening prices equal the prior: qᵢ = b · ln(priorᵢ).
 * Priors must be positive and sum to ~1 (we normalize defensively).
 * All entries come out ≤ 0; LMSR only cares about relative q.
 */
export function seedFromPriors(priors: readonly number[], b: bigint): bigint[] {
  if (priors.length < 2) throw new LmsrError(`need ≥ 2 priors, got ${priors.length}`);
  const sum = priors.reduce((a, v) => a + v, 0);
  if (!Number.isFinite(sum) || sum <= 0) throw new LmsrError(`bad prior sum: ${sum}`);
  const bN = Number(b);
  return priors.map((p) => {
    const norm = p / sum;
    if (!(norm > 0) || norm >= 1) throw new LmsrError(`prior out of (0,1): ${p}`);
    return roundToBigInt(bN * Math.log(norm));
  });
}

/**
 * Worst-case house subsidy for a uniform-prior market: b · ln(n), µpts.
 * This is the number the SEED_SUBSIDY ledger entry budgets per market.
 */
export function worstCaseLoss(b: bigint, n: number): bigint {
  if (!Number.isInteger(n) || n < 2) throw new LmsrError(`need ≥ 2 outcomes, got ${n}`);
  return ceilToBigInt(Number(b) * Math.log(n));
}

/**
 * Worst-case house subsidy for a prior-seeded market: b · ln(1 / min prior).
 * Strictly larger than b·ln(n) whenever any prior is below 1/n — use THIS,
 * not worstCaseLoss, to budget prior-seeded markets.
 */
export function worstCaseLossForPriors(priors: readonly number[], b: bigint): bigint {
  if (priors.length < 2) throw new LmsrError(`need ≥ 2 priors, got ${priors.length}`);
  const sum = priors.reduce((a, v) => a + v, 0);
  const minNorm = Math.min(...priors.map((p) => p / sum));
  if (!(minNorm > 0)) throw new LmsrError(`priors must be positive`);
  return ceilToBigInt(Number(b) * Math.log(1 / minNorm));
}
