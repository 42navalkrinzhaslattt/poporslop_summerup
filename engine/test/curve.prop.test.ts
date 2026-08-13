import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type CurveState,
  MICRO,
  listingDefaults,
  tokenPrice,
  tokenTradeCost,
  tokensForBudget,
} from "../src/index.js";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? (process.env.CI ? 1000 : 200));

const arbCurve = fc
  .record({
    paymentUsd: fc.integer({ min: 0, max: 100_000 }),
    buys: fc.array(fc.bigInt({ min: 1n, max: 2000n }).map((v) => v * MICRO), {
      minLength: 0,
      maxLength: 50,
    }),
  })
  .map(({ paymentUsd, buys }) => {
    const { p0, slope } = listingDefaults(paymentUsd);
    return { p0, slope, buys };
  });

/** Run buys from zero supply, tracking pool intake and one trader's holdings. */
function runBuys(p0: bigint, slope: bigint, buys: readonly bigint[]) {
  let supply = 0n;
  let pool = 0n;
  for (const b of buys) {
    const cost = tokenTradeCost({ supply, p0, slope }, b);
    pool += cost;
    supply += b;
  }
  return { supply, pool };
}

describe("bonding curve properties", () => {
  it("no-arb: buy δ then sell δ never profits the trader", () => {
    fc.assert(
      fc.property(arbCurve, fc.bigInt({ min: 1n, max: 5000n }), ({ p0, slope, buys }, deltaRaw) => {
        const { supply } = runBuys(p0, slope, buys);
        const delta = deltaRaw * MICRO;
        const state: CurveState = { supply, p0, slope };
        const buy = tokenTradeCost(state, delta);
        const sell = tokenTradeCost({ supply: supply + delta, p0, slope }, -delta);
        expect(buy + sell >= 0n).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("pool solvency: selling everything back never withdraws more than was paid in", () => {
    fc.assert(
      fc.property(arbCurve, ({ p0, slope, buys }) => {
        const { supply, pool } = runBuys(p0, slope, buys);
        if (supply === 0n) return;
        const refund = -tokenTradeCost({ supply, p0, slope }, -supply);
        expect(refund <= pool).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("price is positive and non-decreasing in supply", () => {
    fc.assert(
      fc.property(arbCurve, fc.bigInt({ min: 1n, max: 5000n }), ({ p0, slope, buys }, deltaRaw) => {
        const { supply } = runBuys(p0, slope, buys);
        const before = tokenPrice({ supply, p0, slope });
        const after = tokenPrice({ supply: supply + deltaRaw * MICRO, p0, slope });
        expect(before > 0n).toBe(true);
        expect(after >= before).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("tokensForBudget is maximal: result fits, one more µtoken does not", () => {
    fc.assert(
      fc.property(
        arbCurve,
        fc.bigInt({ min: 1n, max: 100_000n }).map((v) => v * MICRO),
        ({ p0, slope, buys }, budget) => {
          const { supply } = runBuys(p0, slope, buys);
          const state: CurveState = { supply, p0, slope };
          const got = tokensForBudget(state, budget);
          expect(tokenTradeCost(state, got) <= budget).toBe(true);
          expect(tokenTradeCost(state, got + 1n) > budget).toBe(true);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("listing defaults scale with payment", () => {
    const small = listingDefaults(0);
    const big = listingDefaults(50_000);
    expect(small.p0).toBe(1_000_000n); // 1 pt floor
    expect(big.p0).toBe(50_000_000n); // $50k → 50 pts launch price
    expect(big.slope > small.slope).toBe(true);
  });
});
