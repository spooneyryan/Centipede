// The whole game as a deterministic, fixed-timestep simulation.
//
// This is the TypeScript port of the Rust `Game` facade (src/game.rs), reshaped
// the way GameBase's co-op component needs it: `step(inputs)` advances exactly
// one tick, everything outcome-deciding lives in the `Game` object, and
// `takeSnapshot`/`restoreSnapshot`/`fingerprint` make it rewindable. The rule
// that decides what belongs here: does it affect what HAPPENS, or only what it
// looks like? Nothing in this file touches the DOM, a clock, or `Math.random`.
//
// Arithmetic discipline: `+ - * / sqrt floor ceil min max` only — all
// bit-exact across JavaScript engines — plus a BigInt xorshift64* RNG whose
// sequence matches the Rust original exactly. No trigonometry anywhere.

import {
  BOTTOM_ROW,
  BOTTOM_TRAP_ROWS,
  BULLET_HIT_RADIUS,
  CELL,
  COLS,
  DYING_TIME,
  HEIGHT,
  LEVEL_CLEAR_TIME,
  PLAYER_HIT_RADIUS,
  PLAYER_SIZE,
  PLAYER_TOP_ROW,
  ROWS,
  SCORE_HEAD,
  SCORE_BODY,
  SCORE_MUSHROOM,
  SCORE_MUSHROOM_REPAIR,
  TOP_ROW,
  WIDTH,
  cellAt,
  cellCenter,
} from "./config";
import { Segment, Train, spawnWave, stepInterval } from "./centipede";
import { Player, type Bullet } from "./entities";
import {
  Hit,
  MushroomField,
  SPECIAL_BONUS,
  SPECIAL_FALLING,
  SPECIAL_REFLECT,
} from "./mushrooms";
import {
  ENEMY_FLEA,
  ENEMY_SAUCER,
  Spawner,
  enemyScore,
  enemySize,
  stepEnemy,
  type Enemy,
} from "./enemies";
import {
  agePowers,
  applyCoin,
  copyPowers,
  freshPowers,
  makeCoin,
  powersAfterDeath,
  rollCoinKind,
  stepCoin,
  type Coin,
  type Powers,
} from "./powerups";
import { Rng } from "./rng";
import { slideThroughField } from "./collide";
import { DEFAULT_TUNING, normalizeTuning, tuningHash, type Tuning } from "./tuning";

/** Ticks per second. A tick is the unit of time; the constant lives here, not
 * in the host. */
export const TPS = 60;
export const DT = 1 / TPS;

// --- Input bit flags. -----------------------------------------------------
// The low six bits mirror the Rust `INPUT_*` constants; the pointer rides in
// the high bits so the whole input is ONE exactly-comparable integer, which is
// what the co-op session's prediction check (`===`) and the wire format need.
export const INPUT_LEFT = 1 << 0;
export const INPUT_RIGHT = 1 << 1;
export const INPUT_UP = 1 << 2;
export const INPUT_DOWN = 1 << 3;
export const INPUT_FIRE = 1 << 4;
export const INPUT_START = 1 << 5;
const POINTER_ACTIVE = 1 << 6;
const COORD_SHIFT_X = 7;
const COORD_SHIFT_Y = 18;
const COORD_MASK = 0x7ff; // 11 bits: 0..2047, covers 1920 and 1080

export type Input = number;

/** Pack held buttons and (optionally) a pointer position into one integer.
 * Pointer coordinates are quantized to whole playfield pixels BEFORE the
 * simulation sees them, so the value played is exactly the value on the wire. */
export function packInput(bits: number, pointer?: { x: number; y: number } | null): Input {
  let v = bits & 0x3f;
  if (pointer) {
    const px = Math.min(Math.max(Math.round(pointer.x), 0), COORD_MASK);
    const py = Math.min(Math.max(Math.round(pointer.y), 0), COORD_MASK);
    v |= POINTER_ACTIVE | (px << COORD_SHIFT_X) | (py << COORD_SHIFT_Y);
  }
  return v;
}

export function inputPointer(v: Input): { x: number; y: number } | null {
  if ((v & POINTER_ACTIVE) === 0) return null;
  return { x: (v >> COORD_SHIFT_X) & COORD_MASK, y: (v >> COORD_SHIFT_Y) & COORD_MASK };
}

/** Extrapolate a peer's pointer for the co-op session's `predictInput` hook.
 * Buttons repeat; an active pointer is projected along its recent motion. */
export function predictInput(recent: Input[], ahead: number): Input {
  const n = recent.length;
  const last = recent[n - 1] ?? 0;
  if (n < 3) return last;
  const a = inputPointer(recent[n - 3]!);
  const c = inputPointer(last);
  if (!a || !c) return last;
  const k = Math.min(ahead, 6) / 2;
  return packInput(last, { x: c.x + (c.x - a.x) * k, y: c.y + (c.y - a.y) * k });
}

// --- Game states, exactly the Rust constants. ------------------------------
export const STATE_ATTRACT = 0;
export const STATE_PLAYING = 1;
export const STATE_DYING = 2;
export const STATE_LEVEL_CLEAR = 3;
export const STATE_GAME_OVER = 4;

/** Deterministic event counters. Presentation diffs these each frame to fire
 * sounds and effects, so a rolled-back tick can never play its sound twice —
 * the counters rewind with the rest of the state. */
export interface GameEvents {
  shots: number;
  mushroomHits: number;
  mushroomKills: number;
  bodyKills: number;
  headKills: number;
  deaths: number;
  levelClears: number;
  extraLives: number;
  starts: number;
  spiderKills: number;
  fleaKills: number;
  scorpionKills: number;
  saucerKills: number;
  coinDrops: number;
  coinPickups: number;
  coinMisses: number;
  shieldSaves: number;
  bonusShrooms: number;
}

const EVENT_KEYS: (keyof GameEvents)[] = [
  "shots",
  "mushroomHits",
  "mushroomKills",
  "bodyKills",
  "headKills",
  "deaths",
  "levelClears",
  "extraLives",
  "starts",
  "spiderKills",
  "fleaKills",
  "scorpionKills",
  "saucerKills",
  "coinDrops",
  "coinPickups",
  "coinMisses",
  "shieldSaves",
  "bonusShrooms",
];

function freshEvents(): GameEvents {
  return {
    shots: 0,
    mushroomHits: 0,
    mushroomKills: 0,
    bodyKills: 0,
    headKills: 0,
    deaths: 0,
    levelClears: 0,
    extraLives: 0,
    starts: 0,
    spiderKills: 0,
    fleaKills: 0,
    scorpionKills: 0,
    saucerKills: 0,
    coinDrops: 0,
    coinPickups: 0,
    coinMisses: 0,
    shieldSaves: 0,
    bonusShrooms: 0,
  };
}

export interface GameOptions {
  /** 1 for solo (exactly the original game), 2 for co-op. */
  players?: number;
  /** A designed mushroom layout: COLS*ROWS hit points, row-major, 0..4.
   * Applied verbatim when a run starts; later levels evolve it as normal. */
  layout?: ArrayLike<number> | null;
  /** Level the run begins on (the wave and speeds scale from it). */
  startLevel?: number;
  /** Carried-over high score shown on the HUD. Solo only — in co-op both
   * machines must agree, so the host's value rides in the payload. */
  highScore?: number;
  /** How the game feels. Fixed for the life of the run: in co-op it comes
   * from the host's payload, in a replay from the document. Never read from a
   * live settings store mid-run, or two machines would drift apart. */
  tuning?: Partial<Tuning>;
}

interface PlayerSlot {
  player: Player;
  input: number;
  prevInput: number;
  fireCooldown: number;
  /** Coins are collected per player: whoever touches it gets it. */
  powers: Powers;
}

export class Game {
  rng: Rng;
  field: MushroomField;
  slots: PlayerSlot[];
  bullets: Bullet[];
  trains: Train[];
  enemies: Enemy[];
  coins: Coin[];
  spawner: Spawner;
  /** Mushrooms shaken loose and now falling on the player. */
  falling: { x: number; y: number }[];

  /** Vertical range the centipede is allowed to roam. `topLimit` tightens once
   * the centipede has reached the floor, trapping it in the player's area. */
  topLimit: number;
  bottomLimit: number;

  score: number;
  highScore: number;
  lives: number;
  level: number;
  nextExtraLife: number;

  state: number;
  stateTimer: number;

  /** Ticks since construction; the simulation's only clock. */
  tick: number;

  events: GameEvents;

  readonly playerCount: number;
  readonly startLevel: number;
  readonly layout: Uint8Array | null;
  readonly tuning: Tuning;

  constructor(seed: number, options: GameOptions = {}) {
    this.playerCount = options.players === 2 ? 2 : 1;
    this.startLevel = Math.max(1, Math.floor(options.startLevel ?? 1));
    this.layout = options.layout ? Uint8Array.from(options.layout as ArrayLike<number>) : null;
    this.tuning = options.tuning ? normalizeTuning({ ...DEFAULT_TUNING, ...options.tuning }) : DEFAULT_TUNING;

    this.rng = new Rng(seed >>> 0);
    this.field = new MushroomField(this.tuning.shroomHp);
    this.slots = [];
    this.bullets = [];
    this.trains = [];
    this.enemies = [];
    this.coins = [];
    this.falling = [];
    this.spawner = new Spawner();
    this.topLimit = TOP_ROW;
    this.bottomLimit = BOTTOM_ROW;
    this.score = 0;
    this.highScore = Math.max(0, Math.floor(options.highScore ?? 0));
    this.lives = this.tuning.lives;
    this.level = this.startLevel;
    this.nextExtraLife = this.tuning.extraLifeEvery;
    this.state = STATE_ATTRACT;
    this.stateTimer = 0;
    this.tick = 0;
    this.events = freshEvents();

    for (let i = 0; i < this.playerCount; i++) {
      this.slots.push({
        player: this.spawnPlayer(i),
        input: 0,
        prevInput: 0,
        fireCooldown: 0,
        powers: freshPowers(),
      });
    }

    // Seed a field and a centipede so the attract screen has something moving
    // behind the title — exactly the Rust constructor.
    this.seedField();
    this.trains = spawnWave(this.startLevel, this.tuning);
  }

  private spawnPlayer(index: number): Player {
    if (this.playerCount === 1) return new Player();
    // Co-op blasters start apart, thirds of the way across the floor.
    const col = index === 0 ? Math.floor(COLS / 3) : Math.floor((COLS * 2) / 3);
    const [x, y] = cellCenter(col, BOTTOM_ROW);
    return new Player(x, y);
  }

  private seedField(): void {
    if (this.layout) {
      this.field.cells.set(this.layout.subarray(0, this.field.cells.length));
    } else {
      this.field.scatter(this.rng, this.tuning.shroomStartCount);
    }
  }

  /** Begin a new run from the attract or game-over screen. */
  start(): void {
    this.score = 0;
    this.lives = this.tuning.lives;
    this.level = this.startLevel;
    this.nextExtraLife = this.tuning.extraLifeEvery;
    this.field.clear();
    this.seedField();
    this.beginLevel();
    this.state = STATE_PLAYING;
    this.stateTimer = 0;
    this.events.starts += 1;
  }

  /** Advance the simulation by exactly one tick. `inputs` is one packed input
   * per seat, seat order guaranteed identical on both machines. */
  step(inputs: Input[]): void {
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i].input = inputs[i] ?? 0;
    }

    const startPressed = this.slots.some(
      (s) => (s.input & INPUT_START) !== 0 && (s.prevInput & INPUT_START) === 0,
    );

    switch (this.state) {
      case STATE_ATTRACT:
      case STATE_GAME_OVER:
        // Let the demo centipede keep wandering behind the overlay.
        this.advanceCentipede(DT);
        if (startPressed) this.start();
        break;
      case STATE_PLAYING:
        this.updatePlaying(DT);
        break;
      case STATE_DYING:
        this.stateTimer -= DT;
        if (this.stateTimer <= 0) this.afterDeath();
        break;
      case STATE_LEVEL_CLEAR:
        this.stateTimer -= DT;
        if (this.stateTimer <= 0) {
          this.level += 1;
          this.beginLevel();
          this.state = STATE_PLAYING;
        }
        break;
    }

    for (const slot of this.slots) slot.prevInput = slot.input;
    this.tick += 1;
  }

  get segmentsLeft(): number {
    let n = 0;
    for (const t of this.trains) n += t.length;
    return n;
  }

  get over(): boolean {
    return this.state === STATE_GAME_OVER;
  }

  // --- Internals, ported 1:1 from the Rust impl block. ---------------------

  /** Reset the playfield for the current level, keeping score and lives. */
  private beginLevel(): void {
    if (this.layout && this.level === this.startLevel) {
      // A designed layout is the field, exactly as drawn, on the level it was
      // drawn for; later levels top it back up like any other field.
      this.field.cells.set(this.layout.subarray(0, this.field.cells.length));
    } else {
      this.field.scatter(this.rng, this.tuning.shroomMinCount);
    }
    this.trains = spawnWave(this.level, this.tuning);
    this.bullets.length = 0;
    this.enemies.length = 0;
    this.coins.length = 0;
    this.falling.length = 0;
    this.spawner.reset(this.tuning, this.rng);
    this.seedSpecials();
    for (let i = 0; i < this.slots.length; i++) {
      this.slots[i].player = this.spawnPlayer(i);
      this.slots[i].fireCooldown = 0;
    }
    this.topLimit = TOP_ROW;
    this.bottomLimit = BOTTOM_ROW;
  }

  private afterDeath(): void {
    this.lives = Math.max(this.lives - 1, 0);
    if (this.lives === 0) {
      this.highScore = Math.max(this.highScore, this.score);
      this.state = STATE_GAME_OVER;
    } else {
      // The mushroom field survives the player, but the wave restarts.
      this.trains = spawnWave(this.level, this.tuning);
      this.bullets.length = 0;
      this.enemies.length = 0;
      this.coins.length = 0;
      this.falling.length = 0;
      this.spawner.reset(this.tuning, this.rng);
      for (let i = 0; i < this.slots.length; i++) {
        this.slots[i].player = this.spawnPlayer(i);
        this.slots[i].fireCooldown = 0;
        // A life costs you everything you were carrying, unless you found a
        // padlock — which is spent buying exactly this reprieve.
        powersAfterDeath(this.slots[i].powers);
      }
      this.topLimit = TOP_ROW;
      this.state = STATE_PLAYING;
    }
  }

  private updatePlaying(dt: number): void {
    for (const slot of this.slots) agePowers(slot.powers, dt);
    for (const slot of this.slots) this.movePlayer(slot, dt);
    for (const slot of this.slots) this.fire(slot, dt);
    this.updateBullets(dt);
    this.advanceCentipede(dt);
    this.updateEnemies(dt);
    this.updateCoins(dt);
    this.updateFalling(dt);

    if (this.anyPlayerHit()) {
      this.state = STATE_DYING;
      this.stateTimer = DYING_TIME;
      this.bullets.length = 0;
      this.events.deaths += 1;
      return;
    }

    if (this.trains.length === 0) {
      const repaired = this.field.repairAll();
      this.addScore(repaired * SCORE_MUSHROOM_REPAIR);
      this.state = STATE_LEVEL_CLEAR;
      this.stateTimer = LEVEL_CLEAR_TIME;
      this.events.levelClears += 1;
    }
  }

  private movePlayer(slot: PlayerSlot, dt: number): void {
    const fromX = slot.player.x;
    const fromY = slot.player.y;

    // The cabinet used a trackball: no speed limit, just a position, clamped
    // like any other move. The keyboard then adds its frame of travel on top
    // — the original places the pointer and steers in the same frame
    // (set_pointer before update, move_player inside it), so holding a
    // direction while the mouse moves nudges the blaster off the cursor.
    const pointer = inputPointer(slot.input);
    if (pointer) slot.player.place(pointer.x, pointer.y);
    const held = (bit: number) => (slot.input & bit) !== 0;
    const dx = (held(INPUT_RIGHT) ? 1 : 0) - (held(INPUT_LEFT) ? 1 : 0);
    const dy = (held(INPUT_DOWN) ? 1 : 0) - (held(INPUT_UP) ? 1 : 0);
    slot.player.steer(dx, dy, dt, this.tuning.playerSpeed);

    // Mushrooms are walls. Resolve the move that just happened against them,
    // which also means the blaster has to shoot its way out of a corner
    // instead of strolling through it.
    if (this.tuning.shroomsBlockPlayer > 0 && slot.powers.pierce <= 0) {
      this.slideAgainstShrooms(slot.player, fromX, fromY);
    }
  }

  /** Move the blaster from where it was to where it wants to be, stopped by
   * any mushroom in the way. The host runs the very same resolution over the
   * virtual pointer that drives this blaster, so the two cannot come apart. */
  private slideAgainstShrooms(player: Player, fromX: number, fromY: number): void {
    const [x, y] = slideThroughField(this.field, fromX, fromY, player.x, player.y);
    player.place(x, y);
  }

  private fire(slot: PlayerSlot, dt: number): void {
    slot.fireCooldown = Math.max(slot.fireCooldown - dt, 0);
    const owner = this.slots.indexOf(slot);
    let own = 0;
    for (const b of this.bullets) if (b.owner === owner) own += 1;
    // Rapid fire raises the ceiling on bullets in flight too, or the faster
    // cooldown would just idle against the cap.
    const rapid = slot.powers.rapid > 0;
    const cap = rapid ? Math.max(this.tuning.maxBullets, 4) : this.tuning.maxBullets;
    if ((slot.input & INPUT_FIRE) !== 0 && slot.fireCooldown === 0 && own < cap) {
      const [x, y] = slot.player.muzzle();
      this.bullets.push({ x, y, owner, vx: 0, pierce: slot.powers.pierce > 0 });
      slot.fireCooldown = rapid
        ? this.tuning.fireCooldown / Math.max(this.tuning.rapidFactor, 1)
        : this.tuning.fireCooldown;
      this.events.shots += 1;
    }
  }

  /** Bullets are fast enough to skip a whole cell in one frame, so they are
   * swept forward in sub-steps no larger than half a cell. */
  private updateBullets(dt: number): void {
    if (this.bullets.length === 0) return;
    const distance = this.tuning.bulletSpeed * dt;
    const steps = Math.max(Math.ceil(distance / (CELL * 0.4)), 1);
    const step = distance / steps;
    const ceiling = TOP_ROW * CELL;

    // The curve gun lets a player bend a shot after firing it: the same
    // left/right input that moves the blaster also steers whatever is in the
    // air. Applied per sub-step so it is frame-rate independent.
    for (const slot of this.slots) {
      if (slot.powers.curve <= 0) continue;
      const owner = this.slots.indexOf(slot);
      const dir =
        ((slot.input & INPUT_RIGHT) !== 0 ? 1 : 0) - ((slot.input & INPUT_LEFT) !== 0 ? 1 : 0);
      for (const b of this.bullets) {
        if (b.owner === owner) b.vx = dir * this.tuning.curveSteer;
      }
    }

    for (let s = 0; s < steps; s++) {
      let i = 0;
      while (i < this.bullets.length) {
        const b = this.bullets[i];
        b.y -= step;
        if (b.vx !== 0) {
          b.x += b.vx * (dt / steps);
          b.x = Math.min(Math.max(b.x, 0), WIDTH);
        }
        if (b.y < ceiling || this.resolveBullet(i)) {
          this.bullets.splice(i, 1);
        } else {
          i += 1;
        }
      }
    }
  }

  /** Returns true if bullet `i` hit something and should be consumed. */
  private resolveBullet(i: number): boolean {
    const bx = this.bullets[i].x;
    const by = this.bullets[i].y;

    // Centipede first: a segment standing on a mushroom should be the thing
    // that takes the shot.
    const radiusSq = BULLET_HIT_RADIUS * BULLET_HIT_RADIUS;
    for (let ti = 0; ti < this.trains.length; ti++) {
      const t = this.trains[ti].t;
      for (let si = 0; si < this.trains[ti].length; si++) {
        const [sx, sy] = this.trains[ti].segments[si].position(t);
        const dx = bx - sx;
        const dy = by - sy;
        if (dx * dx + dy * dy <= radiusSq) {
          this.hitSegment(ti, si);
          return true;
        }
      }
    }

    // Then the other bugs.
    for (let ei = 0; ei < this.enemies.length; ei++) {
      const e = this.enemies[ei];
      const r = enemySize(e.kind) * 0.55;
      const dx = bx - e.x;
      const dy = by - e.y;
      if (dx * dx + dy * dy <= r * r) {
        this.hitEnemy(ei, this.bullets[i].owner);
        return true;
      }
    }

    const [col, row] = cellAt(bx, by);
    const special = this.field.special(col, row);
    const owner = this.bullets[i].owner;

    if (special === SPECIAL_REFLECT && this.field.blocks(col, row)) {
      // Reflecting mushrooms are indestructible and send the shot back down.
      return true;
    }

    switch (this.field.damage(col, row)) {
      case Hit.Missed:
        return false;
      case Hit.Damaged:
        this.events.mushroomHits += 1;
        // A pierce shot carries on through instead of stopping.
        return !this.bullets[i].pierce;
      case Hit.Destroyed: {
        if (special === SPECIAL_BONUS) {
          this.addScore(this.tuning.scoreBonusShroom * this.multiplierFor(owner));
          this.events.bonusShrooms += 1;
        } else {
          this.addScore(SCORE_MUSHROOM * this.multiplierFor(owner));
        }
        if (special === SPECIAL_FALLING) {
          const [cx, cy] = cellCenter(col, row);
          this.falling.push({ x: cx, y: cy });
        }
        this.events.mushroomKills += 1;
        this.maybeDropCoin((col + 0.5) * CELL, (row + 0.5) * CELL);
        return !this.bullets[i].pierce;
      }
    }
    return false;
  }

  private multiplierFor(owner: number): number {
    return this.slots[owner]?.powers.multiplier ?? 1;
  }

  /** One shot into one of the other bugs. */
  private hitEnemy(index: number, owner: number): void {
    const e = this.enemies[index];
    e.hp -= 1;
    if (e.hp > 0) return; // an angry flea, not a dead one

    const playerY = this.slots[owner]?.player.y ?? HEIGHT;
    this.addScore(enemyScore(e, playerY, this.tuning) * this.multiplierFor(owner));
    switch (e.kind) {
      case ENEMY_FLEA:
        this.events.fleaKills += 1;
        break;
      case ENEMY_SAUCER:
        this.events.saucerKills += 1;
        break;
      case 0:
        this.events.spiderKills += 1;
        break;
      default:
        this.events.scorpionKills += 1;
    }
    this.maybeDropCoin(e.x, e.y);
    this.enemies.splice(index, 1);
  }

  /** Kill one segment: it becomes a mushroom, and anything behind it becomes a
   * new centipede led by the segment that was following it. */
  private hitSegment(trainIndex: number, segmentIndex: number): void {
    if (segmentIndex === 0) {
      this.addScore(SCORE_HEAD);
      this.events.headKills += 1;
    } else {
      this.addScore(SCORE_BODY);
      this.events.bodyKills += 1;
    }

    const dirY = this.trains[trainIndex].dirY;
    const level = this.level;
    const [[col, row], tail] = this.trains[trainIndex].sever(segmentIndex);
    this.field.plant(col, row);

    // Re-time the shortened front half; a stub of a centipede moves faster.
    if (this.trains[trainIndex].isEmpty()) {
      this.trains.splice(trainIndex, 1);
    } else {
      const len = this.trains[trainIndex].length;
      this.trains[trainIndex].interval = stepInterval(level, len, this.tuning);
    }

    if (tail.length > 0) {
      const train = new Train(tail, stepInterval(level, tail.length, this.tuning));
      train.dirY = dirY;
      this.trains.push(train);
    }
  }

  private advanceCentipede(dt: number): void {
    const top = this.topLimit;
    const bottom = this.bottomLimit;
    let reachedBottom = false;
    for (const train of this.trains) {
      // A head that walks into poison stops zig-zagging and drops straight
      // for the floor — the scorpion's whole reason for existing.
      const head = train.segments[0];
      if (head && !train.diving && this.field.poisoned(head.col, head.row)) {
        train.diving = true;
      }
      reachedBottom = train.update(dt, this.field, top, bottom) || reachedBottom;
      if (train.diving && head && head.row >= bottom) train.diving = false;
    }
    if (reachedBottom) {
      // Once it is down here it stays down here, harassing the player,
      // instead of marching back up to the top of the screen.
      this.topLimit = Math.max(BOTTOM_ROW - BOTTOM_TRAP_ROWS, PLAYER_TOP_ROW);
    }
  }

  /** Sprinkle the odd mushroom once the player has earned some variety. */
  private seedSpecials(): void {
    const t = this.tuning;
    if (this.level < t.specialFromLevel || t.specialChance <= 0) return;
    for (let row = TOP_ROW + 1; row <= BOTTOM_ROW - 2; row++) {
      for (let col = 0; col < COLS; col++) {
        if (!this.field.blocks(col, row)) continue;
        if (this.rng.below(100) >= t.specialChance) continue;
        const kind = 1 + this.rng.below(3); // FALLING | REFLECT | BONUS
        this.field.setSpecial(col, row, kind);
      }
    }
  }

  private updateEnemies(dt: number): void {
    this.spawner.update(dt, this.enemies, this.field, this.rng, this.tuning, this.level, 12);
    let i = 0;
    while (i < this.enemies.length) {
      const alive = stepEnemy(this.enemies[i], dt, this.field, this.rng, this.tuning);
      if (!alive) this.enemies.splice(i, 1);
      else i += 1;
    }
  }

  private updateCoins(dt: number): void {
    const reach = CELL * 0.85;
    let i = 0;
    while (i < this.coins.length) {
      const coin = this.coins[i];
      const alive = stepCoin(coin, dt, this.tuning);

      let taken = false;
      for (const slot of this.slots) {
        const dx = slot.player.x - coin.x;
        const dy = slot.player.y - coin.y;
        if (dx * dx + dy * dy <= reach * reach) {
          if (applyCoin(coin.kind, slot.powers, this.tuning)) {
            this.lives += 1;
            this.events.extraLives += 1;
          }
          this.events.coinPickups += 1;
          taken = true;
          break;
        }
      }

      if (taken || !alive) {
        // A coin nobody reached in time is the game telling you to move.
        if (!taken) this.events.coinMisses += 1;
        this.coins.splice(i, 1);
      } else {
        i += 1;
      }
    }
  }

  /** A loosed mushroom drops on the player's head. Lethal on contact — the
   * shield is the only thing that saves you. */
  private updateFalling(dt: number): void {
    let i = 0;
    while (i < this.falling.length) {
      const m = this.falling[i];
      m.y += this.tuning.fallingSpeed * dt;
      if (m.y > HEIGHT) {
        this.falling.splice(i, 1);
      } else {
        i += 1;
      }
    }
  }

  /** Roll for a coin where a mushroom just died. */
  private maybeDropCoin(x: number, y: number): void {
    const t = this.tuning;
    if (t.coinChance <= 0 || this.rng.below(100) >= t.coinChance) return;
    this.coins.push(makeCoin(rollCoinKind(this.rng, t), x, y, this.rng, t));
    this.events.coinDrops += 1;
  }

  private anyPlayerHit(): boolean {
    const radiusSq = PLAYER_HIT_RADIUS * PLAYER_HIT_RADIUS;
    for (const slot of this.slots) {
      let touched = false;

      for (const train of this.trains) {
        for (const segment of train.segments) {
          const [sx, sy] = segment.position(train.t);
          const dx = slot.player.x - sx;
          const dy = slot.player.y - sy;
          if (dx * dx + dy * dy <= radiusSq) touched = true;
        }
      }

      // A spider or a flea that reaches you is just as fatal as the centipede.
      // The scorpion and the saucer stay out of the player's band entirely.
      if (!touched) {
        for (const e of this.enemies) {
          const r = (enemySize(e.kind) + PLAYER_SIZE) * 0.42;
          const dx = slot.player.x - e.x;
          const dy = slot.player.y - e.y;
          if (dx * dx + dy * dy <= r * r) {
            touched = true;
            break;
          }
        }
      }

      // And a mushroom you shook loose lands on your head.
      if (!touched) {
        for (const f of this.falling) {
          const dx = slot.player.x - f.x;
          const dy = slot.player.y - f.y;
          if (dx * dx + dy * dy <= radiusSq) {
            touched = true;
            break;
          }
        }
      }

      if (!touched) continue;
      // The shield is spent absorbing the hit rather than blocking forever,
      // so it buys a mistake instead of removing the danger.
      if (slot.powers.shield > 0) {
        slot.powers.shield = 0;
        this.events.shieldSaves += 1;
        continue;
      }
      return true;
    }
    return false;
  }

  private addScore(points: number): void {
    if (points === 0) return;
    this.score += points;
    while (this.score >= this.nextExtraLife) {
      this.lives += 1;
      this.nextExtraLife += this.tuning.extraLifeEvery;
      this.events.extraLives += 1;
    }
    this.highScore = Math.max(this.highScore, this.score);
  }
}

// --- Snapshot / restore / fingerprint: the rollback seam. -------------------
// Snapshots are plain in-memory objects (never serialized), refilled in place
// when the session hands back a retired buffer, so steady-state rollback
// allocates nothing.

interface SegmentSnap {
  col: number;
  row: number;
  prevCol: number;
  prevRow: number;
  dirX: number;
}

interface TrainSnap {
  segments: SegmentSnap[];
  segmentCount: number;
  dirY: number;
  interval: number;
  timer: number;
  t: number;
  diving: boolean;
}

interface SlotSnap {
  x: number;
  y: number;
  input: number;
  prevInput: number;
  fireCooldown: number;
  powers: Powers;
}

export interface Snap {
  rngState: bigint;
  cells: Uint8Array;
  flags: Uint8Array;
  slots: SlotSnap[];
  bullets: { x: number; y: number; owner: number; vx: number; pierce: boolean }[];
  bulletCount: number;
  enemies: Enemy[];
  enemyCount: number;
  coins: Coin[];
  coinCount: number;
  falling: { x: number; y: number }[];
  fallingCount: number;
  spawn: { spider: number; flea: number; scorpion: number; saucer: number };
  trains: TrainSnap[];
  trainCount: number;
  topLimit: number;
  bottomLimit: number;
  score: number;
  highScore: number;
  lives: number;
  level: number;
  nextExtraLife: number;
  state: number;
  stateTimer: number;
  tick: number;
  events: GameEvents;
}

export function takeSnapshot(g: Game, into?: Snap): Snap {
  const snap: Snap =
    into ??
    ({
      rngState: 0n,
      cells: new Uint8Array(COLS * ROWS),
      flags: new Uint8Array(COLS * ROWS),
      slots: [],
      bullets: [],
      bulletCount: 0,
      enemies: [],
      enemyCount: 0,
      coins: [],
      coinCount: 0,
      falling: [],
      fallingCount: 0,
      spawn: { spider: 0, flea: 0, scorpion: 0, saucer: 0 },
      trains: [],
      trainCount: 0,
      topLimit: 0,
      bottomLimit: 0,
      score: 0,
      highScore: 0,
      lives: 0,
      level: 0,
      nextExtraLife: 0,
      state: 0,
      stateTimer: 0,
      tick: 0,
      events: freshEvents(),
    } as Snap);

  snap.rngState = g.rng.save();
  snap.cells.set(g.field.cells);
  snap.flags.set(g.field.flags);

  while (snap.slots.length < g.slots.length) {
    snap.slots.push({ x: 0, y: 0, input: 0, prevInput: 0, fireCooldown: 0, powers: freshPowers() });
  }
  for (let i = 0; i < g.slots.length; i++) {
    const s = snap.slots[i];
    const live = g.slots[i];
    s.x = live.player.x;
    s.y = live.player.y;
    s.input = live.input;
    s.prevInput = live.prevInput;
    s.fireCooldown = live.fireCooldown;
    copyPowers(live.powers, s.powers);
  }

  snap.bulletCount = g.bullets.length;
  while (snap.bullets.length < g.bullets.length) {
    snap.bullets.push({ x: 0, y: 0, owner: 0, vx: 0, pierce: false });
  }
  for (let i = 0; i < g.bullets.length; i++) {
    snap.bullets[i].x = g.bullets[i].x;
    snap.bullets[i].y = g.bullets[i].y;
    snap.bullets[i].owner = g.bullets[i].owner;
    snap.bullets[i].vx = g.bullets[i].vx;
    snap.bullets[i].pierce = g.bullets[i].pierce;
  }

  snap.enemyCount = g.enemies.length;
  while (snap.enemies.length < g.enemies.length) {
    snap.enemies.push({ kind: 0, x: 0, y: 0, vx: 0, vy: 0, hp: 0, timer: 0 });
  }
  for (let i = 0; i < g.enemies.length; i++) {
    const d = snap.enemies[i];
    const e = g.enemies[i];
    d.kind = e.kind;
    d.x = e.x;
    d.y = e.y;
    d.vx = e.vx;
    d.vy = e.vy;
    d.hp = e.hp;
    d.timer = e.timer;
  }

  snap.coinCount = g.coins.length;
  while (snap.coins.length < g.coins.length) {
    snap.coins.push({ kind: 0, x: 0, y: 0, vx: 0, vy: 0, life: 0 });
  }
  for (let i = 0; i < g.coins.length; i++) {
    const d = snap.coins[i];
    const c = g.coins[i];
    d.kind = c.kind;
    d.x = c.x;
    d.y = c.y;
    d.vx = c.vx;
    d.vy = c.vy;
    d.life = c.life;
  }

  snap.fallingCount = g.falling.length;
  while (snap.falling.length < g.falling.length) snap.falling.push({ x: 0, y: 0 });
  for (let i = 0; i < g.falling.length; i++) {
    snap.falling[i].x = g.falling[i].x;
    snap.falling[i].y = g.falling[i].y;
  }

  snap.spawn.spider = g.spawner.spiderTimer;
  snap.spawn.flea = g.spawner.fleaTimer;
  snap.spawn.scorpion = g.spawner.scorpionTimer;
  snap.spawn.saucer = g.spawner.saucerTimer;

  snap.trainCount = g.trains.length;
  while (snap.trains.length < g.trains.length) {
    snap.trains.push({ segments: [], segmentCount: 0, dirY: 0, interval: 0, timer: 0, t: 0, diving: false });
  }
  for (let i = 0; i < g.trains.length; i++) {
    const ts = snap.trains[i];
    const train = g.trains[i];
    ts.segmentCount = train.segments.length;
    while (ts.segments.length < train.segments.length) {
      ts.segments.push({ col: 0, row: 0, prevCol: 0, prevRow: 0, dirX: 0 });
    }
    for (let j = 0; j < train.segments.length; j++) {
      const ss = ts.segments[j];
      const seg = train.segments[j];
      ss.col = seg.col;
      ss.row = seg.row;
      ss.prevCol = seg.prevCol;
      ss.prevRow = seg.prevRow;
      ss.dirX = seg.dirX;
    }
    ts.dirY = train.dirY;
    ts.interval = train.interval;
    ts.timer = train.timer;
    ts.t = train.t;
    ts.diving = train.diving;
  }

  snap.topLimit = g.topLimit;
  snap.bottomLimit = g.bottomLimit;
  snap.score = g.score;
  snap.highScore = g.highScore;
  snap.lives = g.lives;
  snap.level = g.level;
  snap.nextExtraLife = g.nextExtraLife;
  snap.state = g.state;
  snap.stateTimer = g.stateTimer;
  snap.tick = g.tick;
  for (const key of EVENT_KEYS) snap.events[key] = g.events[key];

  return snap;
}

export function restoreSnapshot(g: Game, snap: Snap): void {
  g.rng.restore(snap.rngState);
  g.field.cells.set(snap.cells);
  g.field.flags.set(snap.flags);

  for (let i = 0; i < g.slots.length; i++) {
    const s = snap.slots[i];
    const live = g.slots[i];
    live.player.place(s.x, s.y);
    live.input = s.input;
    live.prevInput = s.prevInput;
    live.fireCooldown = s.fireCooldown;
    copyPowers(s.powers, live.powers);
  }

  g.bullets.length = 0;
  for (let i = 0; i < snap.bulletCount; i++) {
    const b = snap.bullets[i];
    g.bullets.push({ x: b.x, y: b.y, owner: b.owner, vx: b.vx, pierce: b.pierce });
  }

  g.enemies.length = 0;
  for (let i = 0; i < snap.enemyCount; i++) {
    const e = snap.enemies[i];
    g.enemies.push({ kind: e.kind, x: e.x, y: e.y, vx: e.vx, vy: e.vy, hp: e.hp, timer: e.timer });
  }

  g.coins.length = 0;
  for (let i = 0; i < snap.coinCount; i++) {
    const c = snap.coins[i];
    g.coins.push({ kind: c.kind, x: c.x, y: c.y, vx: c.vx, vy: c.vy, life: c.life });
  }

  g.falling.length = 0;
  for (let i = 0; i < snap.fallingCount; i++) {
    g.falling.push({ x: snap.falling[i].x, y: snap.falling[i].y });
  }

  g.spawner.spiderTimer = snap.spawn.spider;
  g.spawner.fleaTimer = snap.spawn.flea;
  g.spawner.scorpionTimer = snap.spawn.scorpion;
  g.spawner.saucerTimer = snap.spawn.saucer;

  g.trains.length = 0;
  for (let i = 0; i < snap.trainCount; i++) {
    const ts = snap.trains[i];
    const segments: Segment[] = [];
    for (let j = 0; j < ts.segmentCount; j++) {
      const ss = ts.segments[j];
      const seg = new Segment(ss.col, ss.row, ss.dirX);
      seg.prevCol = ss.prevCol;
      seg.prevRow = ss.prevRow;
      segments.push(seg);
    }
    const train = new Train(segments, ts.interval);
    train.dirY = ts.dirY;
    train.timer = ts.timer;
    train.t = ts.t;
    train.diving = ts.diving;
    g.trains.push(train);
  }

  g.topLimit = snap.topLimit;
  g.bottomLimit = snap.bottomLimit;
  g.score = snap.score;
  g.highScore = snap.highScore;
  g.lives = snap.lives;
  g.level = snap.level;
  g.nextExtraLife = snap.nextExtraLife;
  g.state = snap.state;
  g.stateTimer = snap.stateTimer;
  g.tick = snap.tick;
  for (const key of EVENT_KEYS) g.events[key] = snap.events[key];
}

/** A cheap value that changes when the simulated state changes. Floats are
 * rounded to integers before mixing — the comparison crosses a JSON trip. */
export function fingerprint(g: Game): number {
  let h = 0x811c9dc5;
  const mix = (n: number): void => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  };

  mix(g.tick);
  mix(tuningHash(g.tuning));
  const rng = g.rng.save();
  mix(Number(rng & 0xffffffffn));
  mix(Number(rng >> 32n));
  mix(g.score);
  mix(g.lives);
  mix(g.level);
  mix(g.state);
  mix(Math.round(g.stateTimer * 1e6));
  mix(g.topLimit);

  for (const slot of g.slots) {
    mix(Math.round(slot.player.x * 1e6));
    mix(Math.round(slot.player.y * 1e6));
    mix(Math.round(slot.fireCooldown * 1e6));
    const p = slot.powers;
    mix(Math.round(p.rapid * 1e6));
    mix(Math.round(p.curve * 1e6));
    mix(Math.round(p.shield * 1e6));
    mix(Math.round(p.pierce * 1e6));
    mix(Math.round(p.multiplier * 1e6));
    mix(Math.round(p.multiplierTime * 1e6));
    mix(p.lock ? 1 : 0);
  }
  for (const b of g.bullets) {
    mix(Math.round(b.x * 1e6));
    mix(Math.round(b.y * 1e6));
    mix(b.owner);
    mix(Math.round(b.vx * 1e6));
    mix(b.pierce ? 1 : 0);
  }
  for (const e of g.enemies) {
    mix(e.kind);
    mix(Math.round(e.x * 1e6));
    mix(Math.round(e.y * 1e6));
    mix(Math.round(e.vx * 1e6));
    mix(Math.round(e.vy * 1e6));
    mix(e.hp);
    mix(Math.round(e.timer * 1e6));
  }
  for (const c of g.coins) {
    mix(c.kind);
    mix(Math.round(c.x * 1e6));
    mix(Math.round(c.y * 1e6));
    mix(Math.round(c.vx * 1e6));
    mix(Math.round(c.vy * 1e6));
    mix(Math.round(c.life * 1e6));
  }
  for (const f of g.falling) {
    mix(Math.round(f.x * 1e6));
    mix(Math.round(f.y * 1e6));
  }
  mix(Math.round(g.spawner.spiderTimer * 1e6));
  mix(Math.round(g.spawner.fleaTimer * 1e6));
  mix(Math.round(g.spawner.scorpionTimer * 1e6));
  mix(Math.round(g.spawner.saucerTimer * 1e6));
  for (const train of g.trains) {
    mix(train.dirY);
    mix(train.diving ? 1 : 0);
    mix(Math.round(train.timer * 1e6));
    for (const seg of train.segments) {
      mix(seg.col);
      mix(seg.row);
      mix(seg.dirX);
    }
  }
  // The field folds in as bytes; 1296 cells is nothing at one hash per tick.
  const cells = g.field.cells;
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] !== 0) {
      mix(i);
      mix(cells[i]);
      mix(g.field.flags[i]);
    }
  }
  for (const key of EVENT_KEYS) mix(g.events[key]);

  return h >>> 0;
}
