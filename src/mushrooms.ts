// The mushroom field, ported from the Rust original (src/mushrooms.rs).
//
// Mushrooms are the only static entity and they are what makes Centipede
// interesting: they block the centipede (forcing it down a row) and they are
// created wherever a segment is shot, so the field the player carves out is also
// the maze the centipede has to descend through.

import { COLS, ROWS, SHROOM_BOTTOM_ROW, SHROOM_HP, SHROOM_TOP_ROW } from "./config";
import type { Rng } from "./rng";

/** Result of shooting at a cell. A plain const object rather than a `const
 * enum` so every build tool (esbuild compiles files in isolation) and Node's
 * type stripping can handle it. */
export const Hit = {
  /** Nothing there. */
  Missed: 0,
  /** Chipped, but still standing. */
  Damaged: 1,
  /** Destroyed by this shot. */
  Destroyed: 2,
} as const;
export type Hit = (typeof Hit)[keyof typeof Hit];

export class MushroomField {
  /** Remaining hit points per cell, `0` meaning "no mushroom". */
  cells: Uint8Array;
  /** Hit points a full-health mushroom has — tunable, so the field carries it
   * rather than reading a module constant. Never changes during a run. */
  readonly fullHp: number;

  constructor(fullHp: number = SHROOM_HP) {
    this.cells = new Uint8Array(COLS * ROWS);
    this.fullHp = Math.min(Math.max(Math.round(fullHp), 1), SHROOM_HP);
  }

  private static index(col: number, row: number): number {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return -1;
    return row * COLS + col;
  }

  /** Remaining hit points at a cell (`0` when empty or out of bounds). */
  hp(col: number, row: number): number {
    const i = MushroomField.index(col, row);
    return i < 0 ? 0 : this.cells[i];
  }

  /** Does this cell turn the centipede around? */
  blocks(col: number, row: number): boolean {
    return this.hp(col, row) > 0;
  }

  /** Plant a full-health mushroom, e.g. where a centipede segment died. */
  plant(col: number, row: number): void {
    const i = MushroomField.index(col, row);
    if (i >= 0) this.cells[i] = this.fullHp;
  }

  clear(): void {
    this.cells.fill(0);
  }

  /** Take one bullet's worth of damage. */
  damage(col: number, row: number): Hit {
    const i = MushroomField.index(col, row);
    if (i < 0 || this.cells[i] === 0) return Hit.Missed;
    this.cells[i] -= 1;
    return this.cells[i] === 0 ? Hit.Destroyed : Hit.Damaged;
  }

  count(): number {
    let n = 0;
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] > 0) n++;
    return n;
  }

  /** Scatter mushrooms at random until the field holds at least `target` of
   * them. Used both to seed a new game and to top the field back up between
   * levels so it can never be cleared out completely. */
  scatter(rng: Rng, target: number): void {
    // Bounded attempts: a full field would otherwise spin here forever.
    let attempts = target * 40;
    while (this.count() < target && attempts > 0) {
      attempts -= 1;
      const col = rng.below(COLS);
      const row = rng.range(SHROOM_TOP_ROW, SHROOM_BOTTOM_ROW);
      if (!this.blocks(col, row)) {
        this.plant(col, row);
      }
    }
  }

  /** Between levels every chipped mushroom is repaired, which is worth points.
   * Returns how many were restored. */
  repairAll(): number {
    let repaired = 0;
    for (let i = 0; i < this.cells.length; i++) {
      if (this.cells[i] > 0 && this.cells[i] < this.fullHp) {
        this.cells[i] = this.fullHp;
        repaired += 1;
      }
    }
    return repaired;
  }

  /** Every living mushroom as `[col, row, hp]`. */
  *iter(): IterableIterator<[number, number, number]> {
    for (let i = 0; i < this.cells.length; i++) {
      const hp = this.cells[i];
      if (hp > 0) yield [i % COLS, Math.floor(i / COLS), hp];
    }
  }
}
