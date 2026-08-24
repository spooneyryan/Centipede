// Moving a point through the mushroom field.
//
// Shared deliberately. The simulation uses it to move the blaster, and the
// host uses the very same function to move the VIRTUAL POINTER that drives
// the blaster — because if the pointer can wander somewhere the blaster
// cannot follow, the two come apart and the mouse stops meaning anything.
//
// Push the mouse at a mushroom and the pointer stops against it exactly as
// the blaster does. Keep pushing and nothing accumulates; move away and the
// blaster answers on the first pixel. Let the pointer run on through instead
// and it eventually surfaces on the far side, which is what made the blaster
// appear to warp through a mushroom the moment the mouse got past it.
//
// Pure arithmetic on a grid, so it is safe on both sides of the wire.

import { CELL, PLAYER_SIZE } from "./config";
import type { MushroomField } from "./mushrooms";

/** Half-extent of the body used for collision. Smaller than the drawn sprite,
 * so squeezing through a one-cell gap feels possible rather than
 * pixel-perfect. */
export const COLLIDE_HALF = PLAYER_SIZE * 0.34;

/** Kept off the wall by a hair, so a body resting against a mushroom is never
 * counted as being inside it. */
export const COLLIDE_EPSILON = 0.01;

/** Does a body centred here overlap a mushroom? */
export function blockedAt(field: MushroomField, x: number, y: number): boolean {
  const c0 = Math.floor((x - COLLIDE_HALF) / CELL);
  const c1 = Math.floor((x + COLLIDE_HALF) / CELL);
  const r0 = Math.floor((y - COLLIDE_HALF) / CELL);
  const r1 = Math.floor((y + COLLIDE_HALF) / CELL);
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      if (field.blocks(col, row)) return true;
    }
  }
  return false;
}

function resolveAxis(
  field: MushroomField,
  x: number,
  y: number,
  want: number,
  horizontal: boolean,
): number {
  const at = (v: number) => (horizontal ? blockedAt(field, v, y) : blockedAt(field, x, v));
  const current = horizontal ? x : y;
  if (want === current) return current;
  if (!at(want)) return want;

  // Snap to the face of whatever we ran into. Refusing the move outright
  // would leave a whole frame of travel between the body and the wall, which
  // reads as sticky — and at a slow enough speed would mean never touching it.
  const snapped =
    want > current
      ? Math.max(current, Math.floor((want + COLLIDE_HALF) / CELL) * CELL - COLLIDE_HALF - COLLIDE_EPSILON)
      : Math.min(current, (Math.floor((want - COLLIDE_HALF) / CELL) + 1) * CELL + COLLIDE_HALF + COLLIDE_EPSILON);
  return at(snapped) ? current : snapped;
}

/** Move from one point to another, stopped by mushrooms.
 *
 * Axis-separated so running along a wall slides instead of sticking, and
 * sub-stepped so a fast flick cannot tunnel straight through. A body that is
 * ALREADY inside a mushroom moves freely — a flea can plant one on top of the
 * blaster, and a shot segment becomes one where it died, so being sealed in
 * place would be a soft lock. */
export function slideThroughField(
  field: MushroomField,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): [number, number] {
  if (toX === fromX && toY === fromY) return [fromX, fromY];
  if (blockedAt(field, fromX, fromY)) return [toX, toY]; // stuck already: let it out

  const span = Math.max(Math.abs(toX - fromX), Math.abs(toY - fromY));
  const steps = Math.min(Math.max(Math.ceil(span / (CELL * 0.4)), 1), 256);
  // Each sub-step advances from where the last one ACTUALLY got to, not to an
  // absolute point along the line. Interpolating absolutely only tests each
  // destination, so a body held against a mushroom would sit still until the
  // target cleared the far side and then leap across it in one frame — which
  // is precisely the warp this is here to prevent.
  const dx = (toX - fromX) / steps;
  const dy = (toY - fromY) / steps;
  let x = fromX;
  let y = fromY;
  for (let i = 0; i < steps; i++) {
    x = resolveAxis(field, x, y, x + dx, true);
    y = resolveAxis(field, x, y, y + dy, false);
  }
  return [x, y];
}
