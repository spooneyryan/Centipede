// Tunable constants.
//
// The playfield is modelled as a grid of cells, each one "average sprite" wide,
// exactly as described in the reference paper. Everything in the game is either
// locked to that grid (mushrooms, centipede) or moves freely inside it (player,
// bullets). Ported 1:1 from the Rust original (src/config.rs).

/** Playfield width in cells. */
export const COLS = 48;
/** Playfield height in cells. */
export const ROWS = 27;
/** Size of one grid cell in pixels. */
export const CELL = 40;

/** Canvas width in pixels (1920). */
export const WIDTH = COLS * CELL;
/** Canvas height in pixels (1080). */
export const HEIGHT = ROWS * CELL;

/** Top row of the playfield; row 0 is reserved for the HUD. */
export const TOP_ROW = 1;
/** Bottom row of the playfield. */
export const BOTTOM_ROW = ROWS - 1;
/** Highest row the player may reach: the "small box at the bottom of the screen". */
export const PLAYER_TOP_ROW = ROWS - 5;
/** Once the centipede has touched the floor it is confined to the bottom of the
 * screen instead of being allowed to climb all the way back up. */
export const BOTTOM_TRAP_ROWS = 5;

/** Mushrooms are seeded between these rows (inclusive). */
export const SHROOM_TOP_ROW = TOP_ROW + 1;
export const SHROOM_BOTTOM_ROW = BOTTOM_ROW - 2;
/** How many mushrooms a fresh field starts with. */
export const SHROOM_START_COUNT = 68;
/** The field is topped back up to this many at the start of every level. */
export const SHROOM_MIN_COUNT = 48;
/** Shots needed to destroy a mushroom. */
export const SHROOM_HP = 4;

/** Number of segments in the level-1 centipede. */
export const CENTIPEDE_LEN = 12;

export const PLAYER_SPEED = 560;
export const PLAYER_SIZE = CELL * 0.85;
export const PLAYER_LIVES = 3;

export const BULLET_SPEED = 2100;
export const BULLET_LEN = CELL * 0.55;
export const BULLET_COOLDOWN = 0.11;
export const MAX_BULLETS = 2;

/** Collision radii. The paper uses Pythagoras between sprite centres and calls it
 * a hit when the distance drops below roughly half a sprite. */
export const BULLET_HIT_RADIUS = CELL * 0.52;
export const PLAYER_HIT_RADIUS = CELL * 0.62;

export const SCORE_BODY = 10;
export const SCORE_HEAD = 100;
export const SCORE_MUSHROOM = 1;
export const SCORE_MUSHROOM_REPAIR = 5;
export const EXTRA_LIFE_EVERY = 10_000;

/** Seconds spent in the death / level-clear interludes. */
export const DYING_TIME = 1.6;
export const LEVEL_CLEAR_TIME = 1.6;

/** Largest timestep the simulation will accept, so that a backgrounded tab does
 * not teleport everything through everything else on the next frame. */
export const MAX_DT = 1 / 20;

/** Convert a grid cell to the pixel coordinate of its centre. */
export function cellCenter(col: number, row: number): [number, number] {
  return [(col + 0.5) * CELL, (row + 0.5) * CELL];
}

/** Convert a pixel coordinate to the grid cell containing it. */
export function cellAt(x: number, y: number): [number, number] {
  return [Math.floor(x / CELL), Math.floor(y / CELL)];
}
