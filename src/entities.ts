// The player's blaster and its bullets, ported from the Rust original
// (src/entities.rs). Both move freely in pixel space rather than snapping to
// the grid — the grid only matters for the things the centipede has to
// navigate around.

import { BOTTOM_ROW, CELL, COLS, HEIGHT, PLAYER_SIZE, PLAYER_SPEED, PLAYER_TOP_ROW, WIDTH, cellCenter } from "./config";

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
    const half = PLAYER_SIZE * 0.5;
    this.x = Math.min(Math.max(this.x, half), WIDTH - half);
    this.y = Math.min(Math.max(this.y, PLAYER_TOP_ROW * CELL + half), HEIGHT - half);
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
}
