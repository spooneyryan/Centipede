// A tiny xorshift64* generator, ported from the Rust original (src/rng.rs).
//
// The internal state is a BigInt masked to 64 bits, so the sequence matches the
// Rust implementation bit for bit — and, just as importantly for internet
// co-op, it is exactly reproducible on every JavaScript engine. The host seeds
// it once and everything after that is deterministic.

const MASK64 = (1n << 64n) - 1n;
const MUL = 0x2545f4914f6cdd1dn;
const SEED_XOR = 0x9e3779b97f4a7c15n;

export class Rng {
  private state: bigint;

  constructor(seed: number) {
    // The xor constant guarantees a non-zero state for any u32 seed, which
    // xorshift requires.
    this.state = (BigInt(seed >>> 0) ^ SEED_XOR) & MASK64;
  }

  private nextU64(): bigint {
    let x = this.state;
    x ^= x >> 12n;
    x = (x ^ (x << 25n)) & MASK64;
    x ^= x >> 27n;
    this.state = x;
    return (x * MUL) & MASK64;
  }

  /** Uniform integer in `0..n`. Returns 0 if `n <= 0`. */
  below(n: number): number {
    if (n <= 0) return 0;
    return Number(this.nextU64() % BigInt(n));
  }

  /** Uniform integer in `lo..=hi`. */
  range(lo: number, hi: number): number {
    return lo + this.below(hi - lo + 1);
  }

  /** Uniform float in `[0, 1)`. */
  unit(): number {
    return Number(this.nextU64() >> 40n) / (1 << 24);
  }

  /** The raw state, for snapshot/restore in rollback netcode. */
  save(): bigint {
    return this.state;
  }

  restore(state: bigint): void {
    this.state = state;
  }
}
