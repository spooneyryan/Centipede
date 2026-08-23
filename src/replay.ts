// Replays: the payoff of a deterministic simulation. Record the inputs on
// every tick and a run can be re-simulated exactly — a ghost of the game that
// weighs a few kilobytes. The document carries everything needed to rebuild
// the run (seed, player count, layout), because a recording that replays
// against the wrong field cannot detect it.
//
// This is the game's own format rather than @ccllc/arcade's `net/input-log`
// because that module records digital action bits, and our input carries a
// quantized pointer — rounding it to held/not-held would make a replay of a
// mouse session diverge from the run it claims to be. (The same reasoning the
// arcade README gives for the shmup recorder.)

import {
  boundedInteger,
  boundedString,
  defineFormat,
  type DocumentFormat,
  type ReportSink,
} from "@ccllc/arcade/core";
import { COLS, ROWS, SHROOM_HP } from "./config";
import { DT, Game, type Input } from "./sim";
import { DEFAULT_TUNING, normalizeTuning, type Tuning } from "./tuning";

export interface ReplayDoc {
  format: string;
  version: number;
  savedAt: string;
  name: string;
  seed: number;
  players: number;
  startLevel: number;
  highScore: number;
  layout: number[] | null;
  /** The tuning the run was played under. A replay recorded with a faster
   * bullet re-simulates wrong without it. */
  tuning: Tuning;
  /** `[tick, seat0, seat1]`, one entry per change — a held key is one entry. */
  frames: [number, number, number][];
  /** Ticks the recording covers. */
  ticks: number;
}

export function createReplayFormat(options: { report?: ReportSink } = {}): DocumentFormat<ReplayDoc> {
  return defineFormat<ReplayDoc>({
    format: "rustipede-replay",
    version: 1,
    sanitize: (raw) => {
      const frames: [number, number, number][] = [];
      if (Array.isArray(raw?.frames)) {
        for (const entry of raw.frames as unknown[]) {
          if (!Array.isArray(entry)) continue;
          frames.push([
            boundedInteger(entry[0], 0, 0, 1e9),
            boundedInteger(entry[1], 0, 0, 2 ** 30),
            boundedInteger(entry[2], 0, 0, 2 ** 30),
          ]);
        }
      }
      let layout: number[] | null = null;
      if (Array.isArray(raw?.layout)) {
        layout = new Array<number>(COLS * ROWS).fill(0);
        for (let i = 0; i < layout.length; i++) {
          layout[i] = boundedInteger((raw.layout as unknown[])[i], 0, 0, SHROOM_HP);
        }
      }
      return {
        name: boundedString(raw?.name, "Replay", 48),
        seed: boundedInteger(raw?.seed, 0, -(2 ** 31), 2 ** 31),
        players: boundedInteger(raw?.players, 1, 1, 2),
        startLevel: boundedInteger(raw?.startLevel, 1, 1, 50),
        highScore: boundedInteger(raw?.highScore, 0, 0, 1e9),
        layout,
        tuning: normalizeTuning(raw?.tuning),
        frames,
        ticks: boundedInteger(raw?.ticks, 0, 0, 1e9),
      };
    },
    report: options.report,
  });
}

/** Records per-tick inputs, keyed by the sim's own tick so a rollback that
 * re-runs a tick simply overwrites the guess with the truth. */
export class ReplayRecorder {
  private p0: Input[] = [];
  private p1: Input[] = [];

  constructor(
    readonly seed: number,
    readonly players: number,
    readonly startLevel: number,
    readonly highScore: number,
    readonly layout: number[] | null,
    readonly tuning: Tuning = DEFAULT_TUNING,
  ) {}

  capture(tick: number, inputs: Input[]): void {
    this.p0[tick] = inputs[0] ?? 0;
    if (this.players === 2) this.p1[tick] = inputs[1] ?? 0;
  }

  get ticks(): number {
    return this.p0.length;
  }

  toBody(name: string): Omit<ReplayDoc, "format" | "version" | "savedAt"> {
    const frames: [number, number, number][] = [];
    let last0 = -1;
    let last1 = -1;
    for (let t = 0; t < this.p0.length; t++) {
      const a = this.p0[t] ?? 0;
      const b = this.p1[t] ?? 0;
      if (a !== last0 || b !== last1) {
        frames.push([t, a, b]);
        last0 = a;
        last1 = b;
      }
    }
    return {
      name,
      seed: this.seed,
      players: this.players,
      startLevel: this.startLevel,
      highScore: this.highScore,
      layout: this.layout,
      tuning: this.tuning,
      frames,
      ticks: this.p0.length,
    };
  }
}

/** Re-simulates a recorded run in real time. */
export class ReplayPlayer {
  readonly game: Game;
  private accumulator = 0;
  private cursor = 0;
  private current: [Input, Input] = [0, 0];
  private tick = 0;

  constructor(private doc: ReplayDoc) {
    this.game = new Game(doc.seed >>> 0, {
      players: doc.players,
      startLevel: doc.startLevel,
      layout: doc.layout,
      highScore: doc.highScore,
      tuning: doc.tuning,
    });
    // Recordings begin at the moment the run started, so the replayed game
    // starts the same way before its first tick.
    this.game.start();
  }

  get finished(): boolean {
    return this.tick >= this.doc.ticks || this.game.over;
  }

  advance(dt: number): void {
    if (this.finished) return;
    this.accumulator += Math.min(dt, 0.25);
    while (this.accumulator >= DT && !this.finished) {
      this.accumulator -= DT;
      while (this.cursor < this.doc.frames.length && this.doc.frames[this.cursor][0] <= this.tick) {
        this.current = [this.doc.frames[this.cursor][1], this.doc.frames[this.cursor][2]];
        this.cursor += 1;
      }
      this.game.step(this.doc.players === 2 ? this.current : [this.current[0]]);
      this.tick += 1;
    }
  }
}
