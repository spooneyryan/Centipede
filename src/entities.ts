// The player's blaster and its bullets, ported from the Rust original
// (src/entities.rs). Both move freely in pixel space rather than snapping to
// the grid — the grid only matters for the things the centipede has to
// navigate around.

import { BOTTOM_ROW, CELL, COLS, HEIGHT, PLAYER_SIZE, PLAYER_SPEED, PLAYER_TOP_ROW, WIDTH, cellCenter } from "./config";

/** Clamp a point into the box the blaster is allowed to occupy.
 *
 * Exported because the HOST needs it too: the pointer that drives the blaster
 * is clamped to this same box every frame, so pushing the mouse past the edge
 * cannot bank up travel that has to be un-wound before the blaster moves
 * again. Push into the wall for a second and you are still on the wall, not a
 * second's worth of movement away from it. */
export function confineToBox(x: number, y: number): [number, number] {
  const half = PLAYER_SIZE * 0.5;
  return [
    Math.min(Math.max(x, half), WIDTH - half),
    Math.min(Math.max(y, PLAYER_TOP_ROW * CELL + half), HEIGHT - half),
  ];
}

export class Player {
  x: number;
  y: number;

  constructor(x?: number, y?: number) {
    if (x === undefined || y === undefined) {
      [x, y] = cellCenter(Math.floor(COLS / 2), BOTTOM_ROW);
    }
    this.x = x;
    this.y = y;
    this.confine();
  }

  /** Move by a direction vector, at the blaster's own speed. */
  steer(dx: number, dy: number, dt: number, speed: number = PLAYER_SPEED): void {
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) {
      const step = (speed * dt) / len;
      this.x += dx * step;
      this.y += dy * step;
      this.confine();
    }
  }

  /** Jump straight to a point. This is how a mouse or trackball drives the
   * blaster: no speed limit, just a position, clamped like any other move. */
  place(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.confine();
  }

  /** Keep the blaster inside the box at the bottom of the screen. */
  private confine(): void {
    [this.x, this.y] = confineToBox(this.x, this.y);
  }

  /** Where a newly fired bullet appears. */
  muzzle(): [number, number] {
    return [this.x, this.y - PLAYER_SIZE * 0.5];
  }
}

export interface Bullet {
  x: number;
  y: number;
  /** Which player fired it — 0 in single player, 0 or 1 in co-op. */
  owner: number;
  /** Sideways velocity, non-zero only while the curve gun is steering it. */
  vx: number;
  /** Carries on through a mushroom instead of stopping at it. */
  pierce: boolean;
}
