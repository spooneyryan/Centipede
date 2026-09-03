// Everything scripts/check.mjs needs from the simulation, in one bundle-able
// entry with no DOM dependencies anywhere beneath it.
export * from "../src/sim";
export * from "../src/config";
export * from "../src/tuning";
export * from "../src/powerups";
export * from "../src/enemies";
// For the pinned-fall test, which builds the trap directly rather than
// waiting for one to occur: about one turns up every 8,700 ticks of play.
export { Segment, Train, stepInterval } from "../src/centipede";
export { MushroomField } from "../src/mushrooms";
export { createCoop } from "@ccllc/coop";
export type { CoopSocket } from "@ccllc/coop";
