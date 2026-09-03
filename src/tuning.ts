// Every number that changes how the game FEELS, in one place, as data.
//
// These were constants in config.ts (and in the Rust original before that).
// They are values now because the game exposes them in Settings — but the
// simulation must still agree bit for bit across two machines, so a tuning is
// handed to `Game` at construction and never read from a live settings store
// mid-run. In co-op the host's tuning rides in the match payload; in a replay
// it rides in the document. See main.ts for both.
//
// config.ts keeps the STRUCTURAL constants — the grid, the playfield, the row
// limits. Those are not tunable: the renderer and the level format are built
// around them.

import {
  BULLET_COOLDOWN,
  BULLET_SPEED,
  CENTIPEDE_LEN,
  EXTRA_LIFE_EVERY,
  PLAYER_LIVES,
  PLAYER_SPEED,
  SHROOM_HP,
  SHROOM_MIN_COUNT,
  SHROOM_START_COUNT,
} from "./config";

export interface Tuning {
  /** Blaster movement, pixels per second. */
  playerSpeed: number;
  /** Bullet travel, pixels per second. */
  bulletSpeed: number;
  /** Seconds between shots — the fire rate. */
  fireCooldown: number;
  /** Bullets each player may have in flight. 1 is the arcade original. */
  maxBullets: number;
  /** Blasters you start a run with. */
  lives: number;
  /** Score between extra lives. */
  extraLifeEvery: number;
  /** Segments in the level-1 centipede. */
  centipedeLength: number;
  /** Cells per second a full centipede walks on level 1. */
  centipedeSpeed: number;
  /** Cells per second added by each level beyond the first. */
  centipedeLevelGain: number;
  /** Speed multiplier for a lone head — a stub scuttles. */
  loneHeadBoost: number;
  /** Ceiling on cells per second, however high the level. */
  centipedeMaxSpeed: number;
  /** What each step costs, as a multiple of a normal one, once a centipede is
   * pinned in a one-cell channel and falling rather than walking. 1 is the
   * arcade behaviour. */
  plungeSlowdown: number;
  /** Shots needed to destroy a mushroom. */
  shroomHp: number;
  /** 1 if mushrooms are solid to the blaster, 0 to walk through them. */
  shroomsBlockPlayer: number;
  /** Mushrooms a fresh field starts with. */
  shroomStartCount: number;
  /** Mushrooms the field is topped back up to each level. */
  shroomMinCount: number;

  // --- The other bugs. Setting an interval to 0 turns that enemy off. ------
  spiderSpeed: number;
  spiderEvery: number;
  fleaSpeed: number;
  fleaEvery: number;
  /** Mushrooms left in the player's band below which a flea is sent. */
  fleaThreshold: number;
  /** Cells a flea skips between the mushrooms it drops. */
  fleaTrailGap: number;
  scorpionSpeed: number;
  scorpionEvery: number;
  scorpionFromLevel: number;
  saucerSpeed: number;
  saucerEvery: number;
  saucerFromLevel: number;
  /** How much faster everything spawns per level. */
  spawnLevelGain: number;

  scoreSpiderClose: number;
  scoreSpiderMid: number;
  scoreSpiderFar: number;
  scoreFlea: number;
  scoreScorpion: number;
  scoreSaucer: number;

  // --- Coins and power-ups. -------------------------------------------------
  /** Chance in 100 that a destroyed mushroom drops a coin. */
  coinChance: number;
  /** Seconds a coin waits before it gives up. */
  coinLife: number;
  coinGravity: number;
  coinBounce: number;
  /** Seconds a rapid/curve/pierce power lasts. */
  powerSeconds: number;
  shieldSeconds: number;
  multiplierSeconds: number;
  /** How much faster the rapid-fire coin makes you shoot. */
  rapidFactor: number;
  /** Sideways pixels per second the curve gun can steer a shot. */
  curveSteer: number;
  coinWeightRapid: number;
  coinWeightCurve: number;
  coinWeightShield: number;
  coinWeightPierce: number;
  coinWeightLife: number;
  coinWeightMultiplier: number;
  coinWeightLock: number;

  // --- Apeiron's late-wave mushrooms. --------------------------------------
  /** Level from which special mushrooms start appearing. */
  specialFromLevel: number;
  /** Chance in 100 that a mushroom planted at level-start is special. */
  specialChance: number;
  /** Pixels per second a loosed mushroom falls. */
  fallingSpeed: number;
  scoreBonusShroom: number;
}

/** Mostly the original game: each default here is the constant it replaced,
 * imported from config.ts so the two cannot drift.
 *
 * Six are deliberately not. They are marked TUNED below, with the original
 * beside them, because a default that quietly disagrees with the constant it
 * claims to be is worse than one that says so. */
export const DEFAULT_TUNING: Tuning = {
  playerSpeed: PLAYER_SPEED,
  bulletSpeed: BULLET_SPEED,
  fireCooldown: BULLET_COOLDOWN,
  maxBullets: 1, // TUNED (MAX_BULLETS is 2). One shot in flight, as the 1981 cabinet.
  lives: PLAYER_LIVES,
  extraLifeEvery: EXTRA_LIFE_EVERY,
  centipedeLength: CENTIPEDE_LEN,
  centipedeSpeed: 7, // TUNED (was 8.5)
  centipedeLevelGain: 1, // TUNED (was 1.15)
  loneHeadBoost: 1.45,
  centipedeMaxSpeed: 26,
  plungeSlowdown: 3, // TUNED (the arcade, and the Rust original, are 1)
  shroomHp: SHROOM_HP,
  shroomsBlockPlayer: 1,
  shroomStartCount: SHROOM_START_COUNT,
  shroomMinCount: SHROOM_MIN_COUNT,

  spiderSpeed: 300,
  spiderEvery: 9,
  fleaSpeed: 420,
  fleaEvery: 7, // TUNED (was 5)
  fleaThreshold: 24,
  fleaTrailGap: 2,
  scorpionSpeed: 260,
  scorpionEvery: 16,
  scorpionFromLevel: 2,
  saucerSpeed: 520,
  saucerEvery: 24,
  saucerFromLevel: 3,
  spawnLevelGain: 0.12,

  scoreSpiderClose: 900,
  scoreSpiderMid: 600,
  scoreSpiderFar: 300,
  scoreFlea: 200,
  scoreScorpion: 1000,
  scoreSaucer: 1200,

  coinChance: 2.3, // TUNED (was 22). Fractional -- see the 0.1 step below.
  coinLife: 5, // TUNED (was 7)
  coinGravity: 900,
  coinBounce: 0.66,
  powerSeconds: 10,
  shieldSeconds: 7,
  multiplierSeconds: 12,
  rapidFactor: 3.5,
  curveSteer: 620,
  coinWeightRapid: 22,
  coinWeightCurve: 14,
  coinWeightShield: 16,
  coinWeightPierce: 14,
  coinWeightLife: 6,
  coinWeightMultiplier: 18,
  coinWeightLock: 10,

  specialFromLevel: 4,
  specialChance: 10,
  fallingSpeed: 340,
  scoreBonusShroom: 500,
};

export interface TuningField {
  key: keyof Tuning;
  label: string;
  /** What turning it up actually does, in the player's terms. */
  hint: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  group: string;
}

/** One description of each knob, read by the settings schema, the sanitizer
 * and the UI alike — so a range cannot drift between them. */
export const TUNING_FIELDS: readonly TuningField[] = [
  { key: "fireCooldown", label: "Fire rate", hint: "seconds between shots; lower is faster", min: 0.02, max: 0.6, step: 0.01, unit: "s", group: "Blaster" },
  { key: "maxBullets", label: "Shots on screen", hint: "bullets in flight at once; 1 is the arcade original", min: 1, max: 4, step: 1, group: "Blaster" },
  { key: "bulletSpeed", label: "Bullet speed", hint: "pixels per second", min: 400, max: 5000, step: 50, unit: "px/s", group: "Blaster" },
  { key: "playerSpeed", label: "Blaster speed", hint: "keyboard movement; the mouse is never speed-limited", min: 120, max: 1600, step: 20, unit: "px/s", group: "Blaster" },

  { key: "centipedeSpeed", label: "Centipede speed", hint: "cells per second on level 1", min: 2, max: 26, step: 0.5, unit: "c/s", group: "Centipede" },
  // 1 restores the arcade exactly, which is what makes this safe to expose:
  // the knob can put the original behaviour back rather than only soften it.
  { key: "plungeSlowdown", label: "Plunge slowdown", hint: "how much longer each step of a pinned vertical fall takes; 1 is the arcade original", min: 1, max: 6, step: 0.5, unit: "x", group: "Centipede" },
  { key: "centipedeLevelGain", label: "Speed per level", hint: "cells per second added each level", min: 0, max: 5, step: 0.05, unit: "c/s", group: "Centipede" },
  { key: "centipedeMaxSpeed", label: "Speed ceiling", hint: "however high the level, never faster than this", min: 4, max: 60, step: 1, unit: "c/s", group: "Centipede" },
  { key: "loneHeadBoost", label: "Lone head boost", hint: "how much faster a single segment scuttles", min: 1, max: 3, step: 0.05, unit: "x", group: "Centipede" },
  { key: "centipedeLength", label: "Centipede length", hint: "segments on level 1", min: 1, max: 24, step: 1, group: "Centipede" },

  { key: "shroomHp", label: "Mushroom toughness", hint: "shots to destroy one", min: 1, max: 4, step: 1, group: "Field" },
  { key: "shroomsBlockPlayer", label: "Mushrooms block you", hint: "1 = solid, you must shoot your way out; 0 = walk through", min: 0, max: 1, step: 1, group: "Field" },
  { key: "shroomStartCount", label: "Starting mushrooms", hint: "how crowded a new field is", min: 0, max: 300, step: 1, group: "Field" },
  { key: "shroomMinCount", label: "Mushrooms per level", hint: "the field is topped back up to this", min: 0, max: 300, step: 1, group: "Field" },

  { key: "spiderEvery", label: "Spider every", hint: "seconds between spiders; 0 turns them off", min: 0, max: 40, step: 1, unit: "s", group: "Bugs" },
  { key: "spiderSpeed", label: "Spider speed", hint: "pixels per second", min: 80, max: 900, step: 10, unit: "px/s", group: "Bugs" },
  { key: "fleaEvery", label: "Flea every", hint: "seconds between checks; 0 turns them off", min: 0, max: 40, step: 1, unit: "s", group: "Bugs" },
  { key: "fleaThreshold", label: "Flea trigger", hint: "mushrooms left in your band before a flea is sent", min: 0, max: 120, step: 1, group: "Bugs" },
  { key: "scorpionEvery", label: "Scorpion every", hint: "seconds between scorpions; 0 turns them off", min: 0, max: 60, step: 1, unit: "s", group: "Bugs" },
  { key: "scorpionFromLevel", label: "Scorpions from level", hint: "how long before they show up", min: 1, max: 20, step: 1, group: "Bugs" },
  { key: "saucerEvery", label: "Saucer every", hint: "seconds between saucers; 0 turns them off", min: 0, max: 90, step: 1, unit: "s", group: "Bugs" },
  { key: "saucerFromLevel", label: "Saucers from level", hint: "how long before they show up", min: 1, max: 20, step: 1, group: "Bugs" },
  { key: "spawnLevelGain", label: "Spawn rate per level", hint: "how much faster the bugs come each level", min: 0, max: 1, step: 0.02, group: "Bugs" },

  // step 0.1, not 1: settings snap every number to its step, so a whole-number
  // step would round the 2.3 default down to 2 on the way in and there would
  // be no way to ask for a fraction at all.
  { key: "coinChance", label: "Coin drop chance", hint: "in 100, per mushroom destroyed; 0 turns coins off", min: 0, max: 100, step: 0.1, unit: "%", group: "Coins" },
  { key: "coinLife", label: "Coin lifetime", hint: "seconds before it gives up and vanishes", min: 1, max: 30, step: 0.5, unit: "s", group: "Coins" },
  { key: "powerSeconds", label: "Power-up duration", hint: "seconds of rapid fire, curve or ghost", min: 1, max: 60, step: 1, unit: "s", group: "Coins" },
  { key: "shieldSeconds", label: "Shield duration", hint: "seconds of invulnerability", min: 1, max: 60, step: 1, unit: "s", group: "Coins" },
  { key: "rapidFactor", label: "Rapid fire boost", hint: "how much faster rapid fire shoots", min: 1, max: 10, step: 0.25, unit: "x", group: "Coins" },
  { key: "curveSteer", label: "Curve gun steering", hint: "how hard you can bend a shot in flight", min: 0, max: 2000, step: 20, unit: "px/s", group: "Coins" },

  { key: "specialFromLevel", label: "Odd mushrooms from level", hint: "falling, reflecting and bonus mushrooms", min: 1, max: 30, step: 1, group: "Field" },
  { key: "specialChance", label: "Odd mushroom chance", hint: "in 100, per mushroom seeded; 0 turns them off", min: 0, max: 100, step: 1, unit: "%", group: "Field" },

  { key: "lives", label: "Lives", hint: "blasters you start with", min: 1, max: 9, step: 1, group: "Run" },
  { key: "extraLifeEvery", label: "Extra life every", hint: "points between free blasters", min: 1000, max: 100000, step: 1000, unit: "pts", group: "Run" },
];

export const TUNING_GROUPS: readonly string[] = [...new Set(TUNING_FIELDS.map((f) => f.group))];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Clamp anything into a usable tuning; never throws. Values arriving from a
 * peer, a replay file or a stale settings store all come through here. */
export function normalizeTuning(raw: unknown): Tuning {
  const source = (raw ?? {}) as Partial<Record<keyof Tuning, unknown>>;
  const out = { ...DEFAULT_TUNING };
  for (const field of TUNING_FIELDS) {
    const value = Number(source[field.key]);
    if (!Number.isFinite(value)) continue;
    const snapped = field.step >= 1 ? Math.round(value) : value;
    // Rounded to 1e-6 -- the same precision `tuningHash` below already treats
    // as significant. Settings snap every number to its step and a FRACTIONAL
    // step does that in binary floating point, so a stored 2.3 comes back as
    // 2.3000000000000003. The fingerprint never noticed, because it rounds
    // too; `isDefaultTuning` compares with === and did, and announced a custom
    // tuning for a game nobody had customised.
    out[field.key] = Math.round(clamp(snapped, field.min, field.max) * 1e6) / 1e6;
  }
  return out;
}

/** Folded into the simulation fingerprint so two machines running different
 * tuning are caught on the first settled tick, rather than after their games
 * have visibly drifted apart. */
export function tuningHash(t: Tuning): number {
  let h = 0x811c9dc5;
  for (const field of TUNING_FIELDS) {
    h ^= Math.round(t[field.key] * 1e6) | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const isDefaultTuning = (t: Tuning): boolean =>
  TUNING_FIELDS.every((f) => t[f.key] === DEFAULT_TUNING[f.key]);
