/**
 * Versioned, seeded, deterministic PRNG (Market Digital Twin, Phase-1 foundation). NO Math.random, NO system
 * entropy, NO module-global state — every stochastic function receives the RNG explicitly. Same (seed, algorithm
 * version) ⇒ byte-identical stream. `fork(namespace)` derives an INDEPENDENT stream so an unrelated change in one
 * part of the simulator (e.g. events) cannot shift every other random sequence (e.g. market/BTC). Algorithm:
 * xoshiro128** with splitmix32 seeding (both standard, public-domain).
 */

export type DeterministicRngAlgorithm = "xoshiro128ss-v1";

export interface DeterministicRng {
  readonly algorithm: DeterministicRngAlgorithm;
  readonly seed: number;
  readonly namespace: string;
  /** Uniform in [0, 1). */
  nextFloat(): number;
  /** Uniform integer in [minInclusive, maxExclusive). */
  nextInt(minInclusive: number, maxExclusive: number): number;
  /** Gaussian via Box–Muller (deterministic; consumes two uniforms). */
  normal(mean: number, std: number): number;
  /** Index sampled proportionally to non-negative `weights` (renormalized). Throws on empty/all-zero. */
  sampleIndex(weights: readonly number[]): number;
  /** A fresh INDEPENDENT stream keyed by (this seed, this namespace, sub-namespace). */
  fork(subNamespace: string): DeterministicRng;
  /** Fisher–Yates shuffle of a COPY (input untouched) using this stream. */
  shuffle<T>(items: readonly T[]): T[];
  /** Serialize the exact internal state for reproducible checkpointing. */
  serializeState(): string;
}

const U32 = 0x1_0000_0000;

function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

/** Deterministic 32-bit hash of a string (FNV-1a) — used to mix a namespace into the seed for forks. */
export function hash32(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

class Xoshiro128ss implements DeterministicRng {
  readonly algorithm: DeterministicRngAlgorithm = "xoshiro128ss-v1";
  private s0: number; private s1: number; private s2: number; private s3: number;

  constructor(readonly seed: number, readonly namespace: string, state?: [number, number, number, number]) {
    if (state) {
      [this.s0, this.s1, this.s2, this.s3] = state.map((v) => v >>> 0) as [number, number, number, number];
    } else {
      // Mix the namespace into the seed so forks are independent, then splitmix32-fill the 128-bit state.
      const sm = splitmix32(((seed >>> 0) ^ hash32(namespace)) >>> 0);
      this.s0 = sm(); this.s1 = sm(); this.s2 = sm(); this.s3 = sm();
      if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1; // avoid the all-zero fixed point
    }
  }

  private nextUint32(): number {
    const result = (Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0);
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result >>> 0;
  }

  nextFloat(): number {
    return this.nextUint32() / U32;
  }

  nextInt(minInclusive: number, maxExclusive: number): number {
    if (!Number.isInteger(minInclusive) || !Number.isInteger(maxExclusive) || maxExclusive <= minInclusive) {
      throw new Error(`nextInt bad range [${minInclusive}, ${maxExclusive})`);
    }
    const span = maxExclusive - minInclusive;
    return minInclusive + Math.floor(this.nextFloat() * span);
  }

  normal(mean: number, std: number): number {
    // Box–Muller; guard u1 away from 0 so log is finite. Deterministic (consumes exactly two uniforms).
    let u1 = this.nextFloat();
    const u2 = this.nextFloat();
    if (u1 < 1e-12) u1 = 1e-12;
    const mag = Math.sqrt(-2 * Math.log(u1));
    return mean + std * mag * Math.cos(2 * Math.PI * u2);
  }

  sampleIndex(weights: readonly number[]): number {
    if (weights.length === 0) throw new Error("sampleIndex empty weights");
    let total = 0;
    for (const w of weights) {
      if (!(w >= 0) || !Number.isFinite(w)) throw new Error("sampleIndex weights must be finite non-negative");
      total += w;
    }
    if (total <= 0) throw new Error("sampleIndex all-zero weights");
    const target = this.nextFloat() * total;
    let acc = 0;
    for (let i = 0; i < weights.length; i += 1) {
      acc += weights[i]!;
      if (target < acc) return i;
    }
    return weights.length - 1; // FP guard
  }

  fork(subNamespace: string): DeterministicRng {
    return new Xoshiro128ss(this.seed, `${this.namespace}/${subNamespace}`);
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.nextInt(0, i + 1);
      const tmp = out[i]!; out[i] = out[j]!; out[j] = tmp;
    }
    return out;
  }

  serializeState(): string {
    return JSON.stringify({ algorithm: this.algorithm, seed: this.seed, namespace: this.namespace, state: [this.s0, this.s1, this.s2, this.s3] });
  }
}

/** Create a root RNG for a run. The namespace defaults to "root"; fork per subsystem (market/BTC, events, …). */
export function createRng(seed: number, namespace = "root"): DeterministicRng {
  if (!Number.isFinite(seed)) throw new Error("createRng seed must be finite");
  return new Xoshiro128ss(seed >>> 0, namespace);
}

/** Restore an RNG from `serializeState()` output — exact stream continuation. */
export function restoreRng(serialized: string): DeterministicRng {
  const p = JSON.parse(serialized) as { algorithm: DeterministicRngAlgorithm; seed: number; namespace: string; state: [number, number, number, number] };
  if (p.algorithm !== "xoshiro128ss-v1") throw new Error(`unknown rng algorithm ${p.algorithm}`);
  return new Xoshiro128ss(p.seed, p.namespace, p.state);
}
