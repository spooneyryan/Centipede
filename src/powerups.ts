// Coins, and what picking one up does to you.
//
// Apeiron's best idea. Coins fall out of destroyed mushrooms, bounce around
// the playfield, and expire if you leave them — so the game keeps prising you
// out of the safe corner at the bottom of the screen to go and get one. Every
// power-up is a timer on the player who collected it, which in co-op means
// they are worth racing for: whoever touches the coin gets it.
//
// Deterministic like everything else in the simulation: coin kinds and bounce
// angles come off the seeded RNG, and the timers count down in ticks.

import { CELL, HEIGHT, PLAYER_TOP_ROW, WIDTH } from "./config";
import type { Rng } from "./rng";
import type { Tuning } from "./tuning";

export const COIN_RAPID = 0;
export const COIN_CURVE = 1;
export const COIN_SHIELD = 2;
export const COIN_PIERCE = 3;
export const COIN_LIFE = 4;
export const COIN_MULTIPLIER = 5;
export const COIN_LOCK = 6;
export const COIN_KINDS = 7;

export const COIN_LABELS: Record<number, string> = {
  [COIN_RAPID]: "RAPID",
  [COIN_CURVE]: "CURVE",
  [COIN_SHIELD]: "SHIELD",
  [COIN_PIERCE]: "PIERCE",
  [COIN_LIFE]: "1UP",
  [COIN_MULTIPLIER]: "2x",
  [COIN_LOCK]: "LOCK",
};

export interface Coin {
  kind: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds left before it gives up and vanishes. */
  life: number;
}

/** The power-ups a single player is currently carrying. Seconds remaining,
 * except `lock`, which is a flag, and `multiplier`, which is a factor. */
export interface Powers {
  rapid: number;
  curve: number;
  shield: number;
  pierce: number;
  multiplier: number;
  multiplierTime: number;
  /** Keeps the rest of this through one death, then is spent. */
  lock: boolean;
}

export function freshPowers(): Powers {
  return { rapid: 0, curve: 0, shield: 0, pierce: 0, multiplier: 1, multiplierTime: 0, lock: false };
}

export function copyPowers(from: Powers, into: Powers): void {
  into.rapid = from.rapid;
  into.curve = from.curve;
  into.shield = from.shield;
  into.pierce = from.pierce;
  into.multiplier = from.multiplier;
  into.multiplierTime = from.multiplierTime;
  into.lock = from.lock;
}

/** Count the timers down. Returns nothing — powers simply lapse. */
export function agePowers(p: Powers, dt: number): void {
  p.rapid = Math.max(p.rapid - dt, 0);
  p.curve = Math.max(p.curve - dt, 0);
  p.shield = Math.max(p.shield - dt, 0);
  p.pierce = Math.max(p.pierce - dt, 0);
  p.multiplierTime = Math.max(p.multiplierTime - dt, 0);
  if (p.multiplierTime === 0) p.multiplier = 1;
}

/** What a death costs. With the padlock you keep everything and spend the
 * lock instead — which is exactly why the lock coin is worth chasing. */
export function powersAfterDeath(p: Powers): void {
  if (p.lock) {
    p.lock = false;
    return;
  }
  p.rapid = 0;
  p.curve = 0;
  p.shield = 0;
  p.pierce = 0;
  p.multiplier = 1;
  p.multiplierTime = 0;
}

export const anyPower = (p: Powers): boolean =>
  p.rapid > 0 || p.curve > 0 || p.shield > 0 || p.pierce > 0 || p.multiplier > 1 || p.lock;

/** Pick a coin kind off the seeded stream, weighted so the game-changing ones
 * stay rare and the workhorses turn up often. */
export function rollCoinKind(rng: Rng, tuning: Tuning): number {
  const weights = [
    tuning.coinWeightRapid,
    tuning.coinWeightCurve,
    tuning.coinWeightShield,
    tuning.coinWeightPierce,
    tuning.coinWeightLife,
    tuning.coinWeightMultiplier,
    tuning.coinWeightLock,
  ];
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return COIN_RAPID;
  // `below` on an integer total keeps this off floating-point entirely.
  let pick = rng.below(Math.round(total * 100));
  for (let i = 0; i < weights.length; i++) {
    const slice = Math.round(weights[i] * 100);
    if (pick < slice) return i;
    pick -= slice;
  }
  return COIN_RAPID;
}

export function makeCoin(kind: number, x: number, y: number, rng: Rng, tuning: Tuning): Coin {
  // A shallow sideways kick so coins scatter instead of dropping in a column.
  const drift = (rng.below(2) === 0 ? -1 : 1) * (40 + rng.below(90));
  return { kind, x, y, vx: drift, vy: -60 - rng.below(80), life: tuning.coinLife };
}

/** Bounce a coin under gravity inside the playfield. Returns false when it has
 * run out of time and should be dropped. */
export function stepCoin(c: Coin, dt: number, tuning: Tuning): boolean {
  c.vy += tuning.coinGravity * dt;
  c.x += c.vx * dt;
  c.y += c.vy * dt;

  const floor = HEIGHT - CELL * 0.4;
  if (c.y > floor) {
    c.y = floor;
    c.vy = -Math.abs(c.vy) * tuning.coinBounce;
    c.vx *= 0.86;
  }
  // Coins stay in the lower half where the player can actually reach them.
  const ceiling = PLAYER_TOP_ROW * CELL - CELL * 3;
  if (c.y < ceiling) {
    c.y = ceiling;
    c.vy = Math.abs(c.vy) * tuning.coinBounce;
  }
  if (c.x < CELL * 0.4) {
    c.x = CELL * 0.4;
    c.vx = Math.abs(c.vx);
  } else if (c.x > WIDTH - CELL * 0.4) {
    c.x = WIDTH - CELL * 0.4;
    c.vx = -Math.abs(c.vx);
  }

  c.life -= dt;
  return c.life > 0;
}

/** Apply a collected coin. Returns true if it granted an extra life, which the
 * caller owns because lives are game state rather than player state. */
export function applyCoin(kind: number, p: Powers, tuning: Tuning): boolean {
  switch (kind) {
    case COIN_RAPID:
      p.rapid = Math.min(p.rapid + tuning.powerSeconds, tuning.powerSeconds * 2);
      return false;
    case COIN_CURVE:
      p.curve = Math.min(p.curve + tuning.powerSeconds, tuning.powerSeconds * 2);
      return false;
    case COIN_SHIELD:
      p.shield = Math.min(p.shield + tuning.shieldSeconds, tuning.shieldSeconds * 2);
      return false;
    case COIN_PIERCE:
      p.pierce = Math.min(p.pierce + tuning.powerSeconds, tuning.powerSeconds * 2);
      return false;
    case COIN_MULTIPLIER:
      p.multiplier = Math.min(p.multiplier * 2, 8);
      p.multiplierTime = tuning.multiplierSeconds;
      return false;
    case COIN_LOCK:
      p.lock = true;
      return false;
    case COIN_LIFE:
      return true;
  }
  return false;
}
