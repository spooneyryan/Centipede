// The centipede, ported from the Rust original (src/centipede.rs).
//
// Movement follows the description in the reference paper: the centipede walks
// horizontally one cell at a time; when the next cell is a wall or a mushroom it
// drops one row and reverses direction. The body is a snake-style trail — every
// tick each segment takes the cell the segment in front of it just left — so the
// whole train threads through the mushroom field along exactly the path its head
// carved.
//
// Shooting a segment turns it into a mushroom and splits the train in two: the
// part in front keeps its head, and the segment behind the hole becomes the head
// of a brand new train. Shooting the head therefore just promotes the next
// segment, which is the behaviour the paper calls out explicitly.

import { CELL, CENTIPEDE_LEN, COLS, TOP_ROW } from "./config";
import type { MushroomField } from "./mushrooms";

/** One link of a centipede. Positions are grid cells; `prevCol`/`prevRow` is
 * where the link was on the previous tick, which lets the renderer interpolate
 * smoothly between discrete steps. */
export class Segment {
  col: number;
  row: number;
  prevCol: number;
  prevRow: number;
  /** -1 or +1; only used to orient the head sprite. */
  dirX: number;

  constructor(col: number, row: number, dirX: number) {
    this.col = col;
    this.row = row;
    this.prevCol = col;
    this.prevRow = row;
    this.dirX = dirX;
  }

  /** Interpolated pixel centre, where `t` is progress through the current tick. */
  position(t: number): [number, number] {
    const col = this.prevCol + (this.col - this.prevCol) * t;
    const row = this.prevRow + (this.row - this.prevRow) * t;
    return [(col + 0.5) * CELL, (row + 0.5) * CELL];
  }
}

/** A contiguous run of segments moving as one unit. A level starts with a single
 * train and ends up with several as the player chops it apart. */
export class Train {
  /** Head first. */
  segments: Segment[];
  /** Vertical travel direction: +1 descending, -1 climbing. */
  dirY: number;
  /** Seconds between cell steps. */
  interval: number;
  timer: number;
  /** Progress through the current step, in `[0, 1]`. */
  t: number;

  constructor(segments: Segment[], interval: number) {
    this.segments = segments;
    this.dirY = 1;
    this.interval = interval;
    this.timer = 0;
    this.t = 0;
  }

  get length(): number {
    return this.segments.length;
  }

  isEmpty(): boolean {
    return this.segments.length === 0;
  }

  /** Advance the clock, stepping as many whole cells as the elapsed time allows.
   * Returns true if the head touched `bottom` during this update. */
  update(dt: number, field: MushroomField, top: number, bottom: number): boolean {
    let touchedBottom = false;
    this.timer += dt;
    while (this.timer >= this.interval) {
      this.timer -= this.interval;
      touchedBottom = this.step(field, top, bottom) || touchedBottom;
    }
    this.t = Math.min(Math.max(this.timer / this.interval, 0), 1);
    return touchedBottom;
  }

  /** One discrete cell of movement. */
  private step(field: MushroomField, top: number, bottom: number): boolean {
    if (this.segments.length === 0) return false;

    // Walk the body from tail to head so each link reads the cell its
    // predecessor occupied *before* this tick.
    for (let i = this.segments.length - 1; i >= 0; i--) {
      const seg = this.segments[i];
      seg.prevCol = seg.col;
      seg.prevRow = seg.row;
      if (i > 0) {
        // Reverse iteration means segment `i - 1` has not moved yet this
        // tick, so these are still its pre-step values.
        seg.col = this.segments[i - 1].col;
        seg.row = this.segments[i - 1].row;
        seg.dirX = this.segments[i - 1].dirX;
      }
    }

    const dirY = this.dirY;
    let hitFloor = false;
    const head = this.segments[0];
    const nextCol = head.col + head.dirX;

    if (nextCol < 0 || nextCol >= COLS || field.blocks(nextCol, head.row)) {
      // Blocked by the edge of the screen or a mushroom: drop a row and
      // turn around. Bouncing off the vertical limits flips `dirY` so the
      // centipede climbs back out again instead of grinding into the floor.
      let nextRow = head.row + dirY;
      if (nextRow > bottom) {
        this.dirY = -1;
        nextRow = head.row - 1;
        hitFloor = true;
      } else if (nextRow < top) {
        this.dirY = 1;
        nextRow = head.row + 1;
      }
      head.row = Math.min(Math.max(nextRow, top), bottom);
      head.dirX = -head.dirX;
    } else {
      head.col = nextCol;
    }

    // Either standing on the floor, or having just tried to descend past it.
    return hitFloor || this.segments[0].row >= bottom;
  }

  /** Remove segment `index`, returning the cell it died in plus the tail that
   * broke off behind it (empty if the hit was on the last segment). */
  sever(index: number): [[number, number], Segment[]] {
    const cell: [number, number] = [this.segments[index].col, this.segments[index].row];
    const tail = this.segments.splice(index);
    tail.shift(); // the segment that was shot
    return [cell, tail];
  }
}

/** Seconds per cell for a train of `len` segments on `level`. Lone heads scuttle
 * noticeably faster than a full-length centipede, as in the arcade original. */
export function stepInterval(level: number, len: number): number {
  const base = 8.5 + Math.max(level - 1, 0) * 1.15;
  const cellsPerSecond = Math.min(base * (len <= 1 ? 1.45 : 1), 26);
  return 1 / cellsPerSecond;
}

/** Build the wave of centipedes for a level: one long train, plus one extra lone
 * head per level beyond the first. */
export function spawnWave(level: number): Train[] {
  const extraHeads = Math.min(Math.max(level - 1, 0), 6);
  const mainLen = Math.max(CENTIPEDE_LEN - extraHeads, 1);

  const trains: Train[] = [];

  // The main body enters from the top-left corner heading right, its tail
  // trailing off toward the corner.
  const segments: Segment[] = [];
  for (let i = 0; i < mainLen; i++) {
    segments.push(new Segment(mainLen - 1 - i, TOP_ROW, 1));
  }
  trains.push(new Train(segments, stepInterval(level, mainLen)));

  // Lone heads spread across the right-hand side, walking left to meet it.
  for (let i = 0; i < extraHeads; i++) {
    const col = COLS - 3 - i * 4;
    trains.push(
      new Train([new Segment(Math.max(col, mainLen + 1), TOP_ROW, -1)], stepInterval(level, 1)),
    );
  }

  return trains;
}
