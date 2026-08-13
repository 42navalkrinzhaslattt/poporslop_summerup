import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type LmsrState,
  MICRO,
  applyTrade,
  cost,
  prices,
  pricesMicro,
  seedFromPriors,
  sharesForBudget,
  tradeCost,
  worstCaseLoss,
  worstCaseLossForPriors,
} from "../src/index.js";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? (process.env.CI ? 1000 : 200));

// b tiers from the spec: 100 / 250 / 1000 pts.
const arbB = fc.constantFrom(100n * MICRO, 250n * MICRO, 1000n * MICRO);

const arbPriors = (n: number) =>
  fc
    .array(fc.double({ min: 0.005, max: 1, noNaN: true }), { minLength: n, maxLength: n })
    .map((raw) => {
      const sum = raw.reduce((a, v) => a + v, 0);
      return raw.map((v) => v / sum);
    });

/** A seeded market plus a raw trade tape (deltas in ±[1, 500] whole shares). */
const arbMarketAndTrades = fc
  .integer({ min: 2, max: 12 })
  .chain((n) =>
    fc.record({
      b: arbB,
      priors: arbPriors(n),
      trades: fc.array(
        fc.record({
          outcome: fc.integer({ min: 0, max: n - 1 }),
          shares: fc.bigInt({ min: 1n, max: 500n }).map((s) => s * MICRO),
          sell: fc.boolean(),
        }),
        { minLength: 1, maxLength: 200 },
      ),
    }),
  )
  .map(({ b, priors, trades }) => ({
    b,
    priors,
    trades,
    q0: seedFromPriors(priors, b),
  }));

/**
 * Run a tape as one aggregated no-short trader: sells are clamped to current
 * holdings (and dropped if flat). Returns final state, µpts collected by the
 * house, and the trader's holdings per outcome.
 */
function runTape(
  q0: bigint[],
  b: bigint,
  tape: { outcome: number; shares: bigint; sell: boolean }[],
) {
  let state: LmsrState = { q: q0, b };
  let collected = 0n;
  const holdings = q0.map(() => 0n);
  const executed: { outcome: number; delta: bigint }[] = [];
  for (const t of tape) {
    let delta = t.shares;
    if (t.sell) {
      delta = -(t.shares < holdings[t.outcome]! ? t.shares : holdings[t.outcome]!);
      if (delta === 0n) continue;
    }
    const { q, cost: c } = applyTrade(state, t.outcome, delta);
    state = { q, b };
    collected += c;
    holdings[t.outcome] = holdings[t.outcome]! + delta;
    executed.push({ outcome: t.outcome, delta });
  }
  return { state, collected, holdings, executed };
}

describe("LMSR property suite", () => {
  it("1. path independence: same trades in any order → identical q; collected cost differs only by per-trade rounding", () => {
    fc.assert(
      fc.property(
        arbMarketAndTrades,
        fc.infiniteStream(fc.nat()),
        ({ q0, b, trades }, shuffleSeeds) => {
          const a = runTape(q0, b, trades);
          // Reorder the *executed* deltas (already clamped) with a Fisher–Yates
          // driven by the seed stream, then replay without clamping.
          const perm = a.executed.slice();
          const seeds = shuffleSeeds[Symbol.iterator]();
          for (let i = perm.length - 1; i > 0; i--) {
            const j = Number(seeds.next().value) % (i + 1);
            [perm[i], perm[j]] = [perm[j]!, perm[i]!];
          }
          let state: LmsrState = { q: q0, b };
          let collectedB = 0n;
          for (const t of perm) {
            const { q, cost: c } = applyTrade(state, t.outcome, t.delta);
            state = { q, b };
            collectedB += c;
          }
          expect(state.q).toEqual(a.state.q);
          const diff = collectedB - a.collected;
          const bound = BigInt(perm.length);
          expect(diff <= bound && diff >= -bound).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("2. no-arb: buy δ then sell δ never profits the trader, from any reachable state", () => {
    fc.assert(
      fc.property(
        arbMarketAndTrades,
        fc.integer({ min: 0, max: 11 }),
        fc.bigInt({ min: 1n, max: 500n }),
        ({ q0, b, trades }, outcomeRaw, sharesRaw) => {
          const { state } = runTape(q0, b, trades);
          const outcome = outcomeRaw % state.q.length;
          const delta = sharesRaw * MICRO;
          const buy = tradeCost(state, outcome, delta);
          const after = applyTrade(state, outcome, delta);
          const sell = tradeCost({ q: after.q, b }, outcome, -delta);
          // Trader pays `buy`, then pays `sell` (negative = receives).
          expect(buy + sell >= 0n).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("3. bounded loss: house never loses more than b·ln(1/min prior) whichever outcome wins", () => {
    fc.assert(
      fc.property(arbMarketAndTrades, ({ q0, b, priors, trades }) => {
        const { collected, holdings } = runTape(q0, b, trades);
        const bound = worstCaseLossForPriors(priors, b);
        for (let i = 0; i < holdings.length; i++) {
          // If outcome i wins, house pays 1 µpt per µshare held.
          const houseNet = collected - holdings[i]!;
          // Small slack for float error at the ceil boundary (≪ 1 µpt/trade).
          expect(houseNet >= -bound - BigInt(trades.length)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("4. price sanity: p ∈ (0,1), µprob sums exactly to 1e6, buying i raises pᵢ and never raises pⱼ", () => {
    fc.assert(
      fc.property(
        arbMarketAndTrades,
        fc.integer({ min: 0, max: 11 }),
        fc.bigInt({ min: 1n, max: 500n }),
        ({ q0, b, trades }, outcomeRaw, sharesRaw) => {
          const { state } = runTape(q0, b, trades);
          const p = prices(state);
          for (const v of p) expect(v > 0 && v < 1).toBe(true);
          const pm = pricesMicro(state);
          expect(pm.reduce((a, v) => a + v, 0)).toBe(1_000_000);
          for (const v of pm) expect(v >= 0 && v <= 1_000_000).toBe(true);

          const outcome = outcomeRaw % state.q.length;
          const { q } = applyTrade(state, outcome, sharesRaw * MICRO);
          const p2 = prices({ q, b });
          expect(p2[outcome]! > p[outcome]!).toBe(true);
          for (let j = 0; j < p.length; j++) {
            if (j !== outcome) expect(p2[j]! <= p[j]!).toBe(true);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("5. sharesForBudget: maximal — result fits the budget, one more µshare does not", () => {
    fc.assert(
      fc.property(
        arbMarketAndTrades,
        fc.integer({ min: 0, max: 11 }),
        fc.bigInt({ min: 1n, max: 2000n }).map((v) => v * MICRO),
        ({ q0, b, trades }, outcomeRaw, budget) => {
          const { state } = runTape(q0, b, trades);
          const outcome = outcomeRaw % state.q.length;
          const delta = sharesForBudget(state, outcome, budget);
          expect(delta >= 0n).toBe(true);
          expect(tradeCost(state, outcome, delta) <= budget).toBe(true);
          expect(tradeCost(state, outcome, delta + 1n) > budget).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("6. seeding: opening µprob prices reproduce the priors", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 12 }).chain((n) => fc.record({ b: arbB, priors: arbPriors(n) })),
        ({ b, priors }) => {
          const q0 = seedFromPriors(priors, b);
          const pm = pricesMicro({ q: q0, b });
          for (let i = 0; i < priors.length; i++) {
            expect(Math.abs(pm[i]! - priors[i]! * 1_000_000)).toBeLessThanOrEqual(2);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("LMSR unit sanity", () => {
  const b = 250n * MICRO;

  it("uniform seed opens at uniform prices and C(q0) ≈ 0 for prior-normalized seed", () => {
    const q0 = seedFromPriors([0.25, 0.25, 0.25, 0.25], b);
    expect(pricesMicro({ q: q0, b })).toEqual([250_000, 250_000, 250_000, 250_000]);
    expect(Math.abs(cost({ q: q0, b }))).toBeLessThan(1); // µpts
  });

  it("zero delta costs zero; buys cost > 0", () => {
    const state: LmsrState = { q: [0n, 0n], b };
    expect(tradeCost(state, 0, 0n)).toBe(0n);
    expect(tradeCost(state, 0, MICRO) > 0n).toBe(true);
  });

  it("worstCaseLoss matches b·ln(n) and priors variant dominates it", () => {
    expect(worstCaseLoss(b, 2)).toBe(173_286_796n); // 250e6 · ln 2, ceil'd
    const skewed = worstCaseLossForPriors([0.01, 0.99], b);
    expect(skewed > worstCaseLoss(b, 2)).toBe(true);
  });

  it("budget of zero or negative buys nothing", () => {
    const state: LmsrState = { q: [0n, 0n], b };
    expect(sharesForBudget(state, 0, 0n)).toBe(0n);
    expect(sharesForBudget(state, 0, -5n)).toBe(0n);
  });
});
