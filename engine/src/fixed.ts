/**
 * Fixed-point conventions for the whole system:
 * - Points and shares are bigint micro-units (1 pt = 1_000_000 µpts).
 * - Probabilities on the wire are integer µprob in [0, 1_000_000].
 * - Floats exist only transiently inside the cost function; they never
 *   reach storage, the ledger, or payouts.
 */

export const MICRO = 1_000_000n;
export const MICRO_N = 1_000_000;

/** Whole points → µpts. */
export function pts(n: number | bigint): bigint {
  if (typeof n === "bigint") return n * MICRO;
  if (!Number.isSafeInteger(n)) throw new Error(`pts() wants an integer, got ${n}`);
  return BigInt(n) * MICRO;
}

/** µpts → float points, display only. */
export function toPts(micro: bigint): number {
  return Number(micro) / MICRO_N;
}

/**
 * Ceil a float to bigint. Guards the float→bigint boundary of the engine:
 * rejects non-finite input and magnitudes past 2^53 where float integers
 * lose unit precision.
 */
export function ceilToBigInt(x: number): bigint {
  if (!Number.isFinite(x)) throw new Error(`non-finite value at fixed-point boundary: ${x}`);
  if (Math.abs(x) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`value exceeds safe integer range: ${x}`);
  }
  return BigInt(Math.ceil(x));
}

/** Round-to-nearest a float to bigint, same guards as ceilToBigInt. */
export function roundToBigInt(x: number): bigint {
  if (!Number.isFinite(x)) throw new Error(`non-finite value at fixed-point boundary: ${x}`);
  if (Math.abs(x) > Number.MAX_SAFE_INTEGER) {
    throw new Error(`value exceeds safe integer range: ${x}`);
  }
  return BigInt(Math.round(x));
}
