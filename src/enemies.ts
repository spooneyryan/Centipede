// The bugs that are not the centipede.
//
// The 1981 original has three, and every Centipede descendant keeps them
// because each one punishes a different habit: the spider punishes camping in
// the player's band, the flea punishes clearing that band out, and the
// scorpion punishes leaving the field alone. Apeiron adds a fourth, a saucer
// that crosses high up and flattens whatever it passes over.
//
// One flat struct with a `kind` tag rather than a class per enemy: the whole
// array snapshots and restores as plain numbers, which is what rollback needs.
// All motion is arithmetic on pixel coordinates; nothing here reads a clock.

import { BOTTOM_ROW, CELL, COLS, HEIGHT, PLAYER_TOP_ROW, TOP_ROW, WIDTH, cellAt } from "./config";
import type { MushroomField } from "./mushrooms";
import type { Rng } from "./rng";
import type { Tuning } from "./tuning";

export const ENEMY_SPIDER = 0;
export const ENEMY_FLEA = 1;
export const ENEMY_SCORPION = 2;
export const ENEMY_SAUCER = 3;

export interface Enemy {
  kind: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Shots still needed. The flea takes two — the first only angers it. */
  hp: number;
  /** Counts down to this enemy's next change of mind. */
  timer: number;
}

export const enemySize = (kind: number): number =>
  kind === ENEMY_SAUCER ? CELL * 1.3 : kind === ENEMY_SPIDER ? CELL * 1.05 : CELL * 0.8;

/** Where the spider roams and the flea matters: the player's own band. */
export const PLAYER_BAND_TOP = PLAYER_TOP_ROW * CELL;

export function makeEnemy(
  kind: number,
  x: number,
  y: number,
  vx: number,
  vy: number,
  hp: number,
): Enemy {
  return { kind, x, y, vx, vy, hp, timer: 0 };
}

/** Advance one enemy. Returns false once it has left the world and should be
 * dropped — walked off the side, or fallen past the floor. */
export function stepEnemy(
  e: Enemy,
  dt: number,
  field: MushroomField,
  rng: Rng,
  tuning: Tuning,
): boolean {
  switch (e.kind) {
    case ENEMY_SPIDER:
      return stepSpider(e, dt, field, rng, tuning);
    case ENEMY_FLEA:
      return stepFlea(e, dt, field, tuning);
    case ENEMY_SCORPION:
      return stepScorpion(e, dt, field, tuning);
    case ENEMY_SAUCER:
      return stepSaucer(e, dt, field, tuning);
  }
  return false;
}

/** Bounces through the player's band at 45 degrees eating mushrooms, and
 * changes its vertical mind at random intervals so it cannot be timed. That
 * unpredictability is the whole point of the spider. */
function stepSpider(e: Enemy, dt: number, field: MushroomField, rng: Rng, tuning: Tuning): boolean {
  const speed = tuning.spiderSpeed;
  e.x += e.vx * speed * dt;
  e.y += e.vy * speed * dt;

  const ceiling = PLAYER_BAND_TOP - CELL;
  const floor = HEIGHT - CELL * 0.5;
  if (e.y < ceiling) {
    e.y = ceiling;
    e.vy = 1;
  } else if (e.y > floor) {
    e.y = floor;
    e.vy = -1;
  }

  e.timer -= dt;
  if (e.timer <= 0) {
    e.vy = rng.below(2) === 0 ? -1 : 1;
    e.timer = 0.25 + rng.below(60) / 100;
  }

  const [col, row] = cellAt(e.x, e.y);
  field.remove(col, row);

  return e.x > -CELL * 2 && e.x < WIDTH + CELL * 2;
}

/** Drops straight down leaving a trail of mushrooms, restocking the field the
 * player just cleared. The first hit does not kill it, it speeds it up —
 * which is why a flea shot late is worse than one left alone. */
function stepFlea(e: Enemy, dt: number, field: MushroomField, tuning: Tuning): boolean {
  const speed = tuning.fleaSpeed * (e.hp <= 1 ? 2.2 : 1);
  const before = Math.floor(e.y / CELL);
  e.y += speed * dt;
  const after = Math.floor(e.y / CELL);

  // One drop per whole cell crossed, so the trail is frame-rate independent.
  const [col] = cellAt(e.x, 0);
  for (let row = before; row < after; row++) {
    if (row >= TOP_ROW + 1 && row <= BOTTOM_ROW - 1 && !field.blocks(col, row)) {
      if (e.timer <= 0) {
        field.plant(col, row);
        e.timer = tuning.fleaTrailGap;
      }
    }
    e.timer -= 1;
  }

  return e.y < HEIGHT;
}

/** Crosses a middle band horizontally, poisoning every mushroom it touches. A
 * poisoned mushroom sends the centipede diving for the floor, so one scorpion
 * across unchallenged reshapes the whole wave. */
function stepScorpion(e: Enemy, dt: number, field: MushroomField, tuning: Tuning): boolean {
  e.x += e.vx * tuning.scorpionSpeed * dt;
  const [col, row] = cellAt(e.x, e.y);
  field.poison(col, row);
  return e.x > -CELL * 2 && e.x < WIDTH + CELL * 2;
}

/** Apeiron's addition: crosses high and flattens the field in its lane.
 * Worth the most, and hard to hit because it never slows down. */
function stepSaucer(e: Enemy, dt: number, field: MushroomField, tuning: Tuning): boolean {
  e.x += e.vx * tuning.saucerSpeed * dt;
  const [col, row] = cellAt(e.x, e.y);
  field.remove(col, row);
  field.remove(col, row - 1);
  return e.x > -CELL * 2 && e.x < WIDTH + CELL * 2;
}

/** Points for a kill. The spider pays by range, exactly as the arcade did —
 * the closer you let it get, the more it is worth. */
export function enemyScore(e: Enemy, playerY: number, tuning: Tuning): number {
  if (e.kind === ENEMY_SPIDER) {
    const gap = Math.abs(playerY - e.y);
    if (gap < CELL * 1.5) return tuning.scoreSpiderClose;
    if (gap < CELL * 3.5) return tuning.scoreSpiderMid;
    return tuning.scoreSpiderFar;
  }
  if (e.kind === ENEMY_FLEA) return tuning.scoreFlea;
  if (e.kind === ENEMY_SCORPION) return tuning.scoreScorpion;
  return tuning.scoreSaucer;
}

/** Decides what turns up and when. Every draw comes off the seeded stream, so
 * two machines spawn the same bugs on the same ticks. */
export class Spawner {
  spiderTimer = 0;
  fleaTimer = 0;
  scorpionTimer = 0;
  saucerTimer = 0;

  reset(tuning: Tuning, rng: Rng): void {
    this.spiderTimer = tuning.spiderEvery * (0.5 + rng.below(100) / 100);
    this.fleaTimer = tuning.fleaEvery * (0.5 + rng.below(100) / 100);
    this.scorpionTimer = tuning.scorpionEvery * (0.5 + rng.below(100) / 100);
    this.saucerTimer = tuning.saucerEvery * (0.5 + rng.below(100) / 100);
  }

  /** Tick the clocks and append whatever is due. `level` accelerates
   * everything; a thin player band is what summons the flea. */
  update(
    dt: number,
    out: Enemy[],
    field: MushroomField,
    rng: Rng,
    tuning: Tuning,
    level: number,
    cap: number,
  ): void {
    const haste = 1 + (level - 1) * tuning.spawnLevelGain;
    const roll = (v: number) => v * (0.6 + rng.below(80) / 100);

    this.spiderTimer -= dt * haste;
    if (this.spiderTimer <= 0) {
      this.spiderTimer = roll(tuning.spiderEvery);
      if (out.length < cap && tuning.spiderEvery > 0) {
        const fromLeft = rng.below(2) === 0;
        out.push(
          makeEnemy(
            ENEMY_SPIDER,
            fromLeft ? -CELL : WIDTH + CELL,
            PLAYER_BAND_TOP + CELL,
            fromLeft ? 1 : -1,
            1,
            1,
          ),
        );
      }
    }

    // The flea only comes when the player's band is running out of cover.
    this.fleaTimer -= dt * haste;
    if (this.fleaTimer <= 0) {
      this.fleaTimer = roll(tuning.fleaEvery);
      const cover = field.countRows(PLAYER_TOP_ROW, BOTTOM_ROW);
      if (cover < tuning.fleaThreshold && out.length < cap && tuning.fleaEvery > 0) {
        const col = rng.below(COLS);
        out.push(makeEnemy(ENEMY_FLEA, (col + 0.5) * CELL, -CELL, 0, 1, 2));
      }
    }

    this.scorpionTimer -= dt * haste;
    if (this.scorpionTimer <= 0) {
      this.scorpionTimer = roll(tuning.scorpionEvery);
      // Scorpions never walk through the player's own band.
      if (level >= tuning.scorpionFromLevel && out.length < cap && tuning.scorpionEvery > 0) {
        const fromLeft = rng.below(2) === 0;
        const span = Math.max(PLAYER_TOP_ROW - TOP_ROW - 4, 1);
        const row = TOP_ROW + 2 + rng.below(span);
        out.push(
          makeEnemy(
            ENEMY_SCORPION,
            fromLeft ? -CELL : WIDTH + CELL,
            (row + 0.5) * CELL,
            fromLeft ? 1 : -1,
            0,
            1,
          ),
        );
      }
    }

    this.saucerTimer -= dt * haste;
    if (this.saucerTimer <= 0) {
      this.saucerTimer = roll(tuning.saucerEvery);
      if (level >= tuning.saucerFromLevel && out.length < cap && tuning.saucerEvery > 0) {
        const fromLeft = rng.below(2) === 0;
        const row = TOP_ROW + 1 + rng.below(4);
        out.push(
          makeEnemy(
            ENEMY_SAUCER,
            fromLeft ? -CELL : WIDTH + CELL,
            (row + 0.5) * CELL,
            fromLeft ? 1 : -1,
            0,
            1,
          ),
        );
      }
    }
  }
}
