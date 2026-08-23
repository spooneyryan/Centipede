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
  MAX_BULLETS,
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
  /** Shots needed to destroy a mushroom. */
  shroomHp: number;
  /** Mushrooms a fresh field starts with. */
  shroomStartCount: number;
  /** Mushrooms the field is topped back up to each level. */
  shroomMinCount: number;
}

/** The original game, exactly: every default is the constant it replaced. */
export const DEFAULT_TUNING: Tuning = {
  playerSpeed: PLAYER_SPEED,
  bulletSpeed: BULLET_SPEED,
  fireCooldown: BULLET_COOLDOWN,
  maxBullets: MAX_BULLETS,
  lives: PLAYER_LIVES,
  extraLifeEvery: EXTRA_LIFE_EVERY,
  centipedeLength: CENTIPEDE_LEN,
  centipedeSpeed: 8.5,
  centipedeLevelGain: 1.15,
  loneHeadBoost: 1.45,
  centipedeMaxSpeed: 26,
  shroomHp: SHROOM_HP,
  shroomStartCount: SHROOM_START_COUNT,
  shroomMinCount: SHROOM_MIN_COUNT,
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
  { key: "centipedeLevelGain", label: "Speed per level", hint: "cells per second added each level", min: 0, max: 5, step: 0.05, unit: "c/s", group: "Centipede" },
  { key: "centipedeMaxSpeed", label: "Speed ceiling", hint: "however high the level, never faster than this", min: 4, max: 60, step: 1, unit: "c/s", group: "Centipede" },
  { key: "loneHeadBoost", label: "Lone head boost", hint: "how much faster a single segment scuttles", min: 1, max: 3, step: 0.05, unit: "x", group: "Centipede" },
  { key: "centipedeLength", label: "Centipede length", hint: "segments on level 1", min: 1, max: 24, step: 1, group: "Centipede" },

  { key: "shroomHp", label: "Mushroom toughness", hint: "shots to destroy one", min: 1, max: 4, step: 1, group: "Field" },
  { key: "shroomStartCount", label: "Starting mushrooms", hint: "how crowded a new field is", min: 0, max: 300, step: 1, group: "Field" },
  { key: "shroomMinCount", label: "Mushrooms per level", hint: "the field is topped back up to this", min: 0, max: 300, step: 1, group: "Field" },

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
    out[field.key] = clamp(snapped, field.min, field.max);
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
