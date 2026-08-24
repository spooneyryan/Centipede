// The determinism proof — GameBase AGENTS.md step 10, the test that matters:
// two complete co-op clients over a simulated laggy link, checked against a
// single machine holding both inputs. Plus the two tests the docs say to
// write first: raw determinism, and snapshot exactness under rewind.
//
//   npm run check
//
// Runs entirely in Node: the simulation has no DOM imports, and the co-op
// client accepts a fake socket through its `connect` option.

import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const GB = resolve(root, "../../../GameBase/GameBase/packages");
const outDir = resolve(root, ".check");
const outFile = resolve(outDir, "sim.mjs");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [resolve(here, "headless-entry.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2022",
  outfile: outFile,
  alias: {
    "@ccllc/coop": resolve(GB, "coop/src/coop.ts"),
  },
  logLevel: "silent",
});

const sim = await import(pathToFileURL(outFile).href);
const {
  Game,
  TPS,
  packInput,
  predictInput,
  takeSnapshot,
  restoreSnapshot,
  fingerprint,
  createCoop,
  INPUT_FIRE,
  INPUT_LEFT,
  INPUT_RIGHT,
  STATE_DYING,
  STATE_GAME_OVER,
  STATE_LEVEL_CLEAR,
  DEFAULT_TUNING,
  TUNING_FIELDS,
  normalizeTuning,
  powersAfterDeath,
} = sim;

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Deterministic input streams — a triangle wave for the pointer, periodic
// fire, alternating keys. No Math.random, no Math.sin.
const wave = (u) => {
  const f = u - Math.floor(u);
  return f < 0.5 ? f * 4 - 1 : 3 - f * 4;
};
const hostIn = (t) => {
  let bits = t % 7 < 5 ? INPUT_FIRE : 0;
  bits |= Math.floor(t / 40) % 2 === 0 ? INPUT_LEFT : INPUT_RIGHT;
  return packInput(bits, { x: 960 + wave(t / 240) * 700, y: 990 });
};
const joinIn = (t) => {
  let bits = t % 5 < 3 ? INPUT_FIRE : 0;
  bits |= Math.floor(t / 60) % 2 === 0 ? INPUT_RIGHT : INPUT_LEFT;
  return packInput(bits, { x: 960 - wave(t / 180) * 700, y: 1030 });
};

function freshGame(seed, players, tuning) {
  const g = new Game(seed, { players, tuning });
  g.start();
  return g;
}

// --- 0. The oracle itself: different states must fingerprint differently. ---
// Every other check in this file compares fingerprints, so a fingerprint that
// stopped distinguishing states would make all of them pass vacuously — a
// suite that cannot fail is worse than no suite, because it reads as proof.
{
  const g = freshGame(99, 2);
  for (let t = 0; t < 300; t++) g.step([hostIn(t), joinIn(t)]);
  const snap = takeSnapshot(g);
  const base = fingerprint(g);

  restoreSnapshot(g, snap);
  check("restore alone reproduces the base fingerprint", fingerprint(g) === base);

  const perturb = (name, fn) => {
    restoreSnapshot(g, snap);
    fn(g);
    check(`fingerprint notices ${name}`, fingerprint(g) !== base);
  };

  perturb("one more tick", (x) => { x.tick += 1; });
  perturb("a changed score", (x) => { x.score += 10; });
  perturb("a lost life", (x) => { x.lives -= 1; });
  perturb("a changed level", (x) => { x.level += 1; });
  perturb("a changed state", (x) => { x.state = STATE_GAME_OVER; });
  perturb("a running state timer", (x) => { x.stateTimer += 0.5; });
  perturb("an advanced rng stream", (x) => { x.rng.below(100); });
  perturb("a moved player", (x) => { x.slots[0].player.x += 0.5; });
  perturb("a moved mushroom", (x) => {
    const i = x.field.cells.findIndex((c) => c !== 0);
    x.field.cells[i] = x.field.cells[i] === 1 ? 2 : 1;
  });
  perturb("a cleared mushroom field", (x) => { x.field.cells.fill(0); });
  perturb("a bumped event counter", (x) => { x.events.shots += 1; });
  perturb("a moved centipede segment", (x) => { x.trains[0].segments[0].col += 1; });
  restoreSnapshot(g, snap);
  check("the perturbation fixture had bullets to drop", g.bullets.length > 0, `${g.bullets.length}`);
  perturb("a dropped bullet", (x) => { x.bullets.pop(); });
}

// --- 0b. Tuning is a value the simulation actually obeys. -------------------
// Exposed in Settings, so it must (a) change the game, (b) stay identical for
// the life of a run, and (c) make two machines that disagree fail LOUDLY
// rather than drift apart quietly.
{
  // Level 5 so the level-gated features (scorpions, saucers, odd mushrooms)
  // are all live and can be turned OFF by a nudge.
  const play = (tuning, ticks = 900) => {
    const g = new Game(31337, { players: 2, startLevel: 5, tuning });
    g.start();
    for (let t = 0; t < ticks; t++) g.step([hostIn(t), joinIn(t)]);
    return g;
  };

  const base = play(undefined);
  check("the default tuning is the original game", fingerprint(base) === fingerprint(play(DEFAULT_TUNING)));
  check("the wider game actually runs", base.events.shots > 0 && base.score > 0, `score ${base.score}`);

  // Every knob must be reachable from the simulation. A field exposed in the
  // UI but wired to nothing is worse than no field at all.
  const NUDGE = {
    fireCooldown: 0.3, maxBullets: 1, bulletSpeed: 900, playerSpeed: 260,
    centipedeSpeed: 4, centipedeLevelGain: 3, centipedeMaxSpeed: 6, loneHeadBoost: 2.5,
    centipedeLength: 6, shroomHp: 1, shroomStartCount: 20, shroomMinCount: 10,
    shroomsBlockPlayer: 0,
    lives: 5, extraLifeEvery: 2000,
    // Bugs: rates and speeds, plus turning the level-gated ones off at L5.
    spiderEvery: 1, spiderSpeed: 800, fleaEvery: 1, fleaThreshold: 120,
    scorpionEvery: 1, scorpionFromLevel: 20, saucerEvery: 1, saucerFromLevel: 20,
    spawnLevelGain: 0.9,
    // Coins: drop rate, how long they linger, and the specials.
    coinChance: 100, coinLife: 1,
    specialFromLevel: 20, specialChance: 100,
  };
  const baseline = fingerprint(base);
  // These only bite once a power-up is actually held, so they get their own
  // test below rather than a spawn-and-hope.
  const NEEDS_A_POWERUP = new Set(["powerSeconds", "shieldSeconds", "rapidFactor", "curveSteer"]);

  for (const field of TUNING_FIELDS) {
    if (NEEDS_A_POWERUP.has(field.key)) continue;
    const value = NUDGE[field.key];
    check(
      `the simulation obeys ${field.label.toLowerCase()}`,
      value !== undefined && fingerprint(play({ ...DEFAULT_TUNING, [field.key]: value })) !== baseline,
      value === undefined ? `no nudge defined for ${field.key}` : `${field.key} = ${value} changed nothing`,
    );
  }

  // The power-up knobs, exercised by granting the power outright.
  const withPower = (mutate, tuning, ticks = 240) => {
    const g = new Game(4242, { players: 1, startLevel: 2, tuning });
    g.start();
    mutate(g.slots[0].powers);
    for (let t = 0; t < ticks; t++) g.step([hostIn(t)]);
    return fingerprint(g);
  };
  const rapidOn = (p) => { p.rapid = 30; };
  const curveOn = (p) => { p.curve = 30; };
  const shieldOn = (p) => { p.shield = 30; };

  check(
    "the simulation obeys rapid fire boost",
    withPower(rapidOn, DEFAULT_TUNING) !== withPower(rapidOn, { ...DEFAULT_TUNING, rapidFactor: 9 }),
  );
  check(
    "the simulation obeys curve gun steering",
    withPower(curveOn, DEFAULT_TUNING) !== withPower(curveOn, { ...DEFAULT_TUNING, curveSteer: 1800 }),
  );
  check(
    "power-ups lapse, and the duration decides when",
    withPower(rapidOn, DEFAULT_TUNING) !== withPower((p) => { p.rapid = 0.1; }, DEFAULT_TUNING),
  );
  check(
    "the shield absorbs a hit instead of the player dying",
    (() => {
      const g = new Game(99, { players: 1, startLevel: 1 });
      g.start();
      g.slots[0].powers.shield = 30;
      // Park a centipede segment exactly on top of the blaster.
      g.trains[0].segments[0].col = Math.floor(g.slots[0].player.x / 40);
      g.trains[0].segments[0].row = Math.floor(g.slots[0].player.y / 40);
      g.trains[0].segments[0].prevCol = g.trains[0].segments[0].col;
      g.trains[0].segments[0].prevRow = g.trains[0].segments[0].row;
      g.step([0]);
      return g.events.shieldSaves === 1 && g.state === 1 && g.slots[0].powers.shield === 0;
    })(),
  );
  check(
    "losing a life costs every power-up",
    (() => {
      const p = { rapid: 5, curve: 4, shield: 3, pierce: 2, multiplier: 4, multiplierTime: 3, lock: false };
      powersAfterDeath(p);
      const cleared =
        p.rapid === 0 && p.curve === 0 && p.shield === 0 && p.pierce === 0 &&
        p.multiplier === 1 && p.multiplierTime === 0;

      // ...and end to end, through an actual death in a running game.
      const g = new Game(5150, { players: 1, tuning: { ...DEFAULT_TUNING, lives: 3 } });
      g.start();
      const powers = g.slots[0].powers;
      powers.rapid = 20; powers.curve = 20; powers.pierce = 20; powers.multiplier = 4;
      powers.multiplierTime = 20;
      const seg = g.trains[0].segments[0];
      seg.col = Math.floor(g.slots[0].player.x / 40);
      seg.row = Math.floor(g.slots[0].player.y / 40);
      seg.prevCol = seg.col; seg.prevRow = seg.row;
      const livesBefore = g.lives;
      for (let t = 0; t < 200; t++) g.step([0]);
      const after = g.slots[0].powers;
      return (
        cleared &&
        g.lives === livesBefore - 1 &&
        after.rapid === 0 && after.curve === 0 && after.pierce === 0 && after.multiplier === 1
      );
    })(),
  );
  check(
    "the padlock carries power-ups through one death, and only one",
    (() => {
      const p = { rapid: 5, curve: 0, shield: 0, pierce: 0, multiplier: 4, multiplierTime: 3, lock: true };
      powersAfterDeath(p);
      const kept = p.rapid === 5 && p.multiplier === 4 && p.lock === false;
      powersAfterDeath(p);
      return kept && p.rapid === 0 && p.multiplier === 1;
    })(),
  );

  // --- Mushrooms are walls. -------------------------------------------------
  const boxedIn = (tuning) => {
    const g = new Game(2468, { players: 1, tuning });
    g.start();
    g.field.clear();
    const p = g.slots[0].player;
    const col = Math.floor(p.x / 40);
    const row = Math.floor(p.y / 40);
    // A mushroom directly to the right of the blaster.
    g.field.plant(col + 1, row);
    const startX = p.x;
    // Hold right for a second.
    for (let t = 0; t < 60; t++) g.step([INPUT_RIGHT]);
    return { moved: p.x - startX, x: p.x, wall: (col + 1) * 40 };
  };

  const blocked = boxedIn(DEFAULT_TUNING);
  check("a mushroom stops the blaster", blocked.moved < 40, `moved ${Math.round(blocked.moved)}px`);
  check("the blaster still reaches the mushroom", blocked.moved > 0, `moved ${Math.round(blocked.moved)}px`);

  const free = boxedIn({ ...DEFAULT_TUNING, shroomsBlockPlayer: 0 });
  check("turning the wall off lets it walk through", free.moved > blocked.moved + 40,
    `blocked ${Math.round(blocked.moved)} vs free ${Math.round(free.moved)}`);

  check(
    "the ghost power walks through mushrooms",
    (() => {
      const g = new Game(2468, { players: 1 });
      g.start();
      g.field.clear();
      const p = g.slots[0].player;
      const col = Math.floor(p.x / 40);
      const row = Math.floor(p.y / 40);
      for (let c = col + 1; c < col + 6; c++) g.field.plant(c, row);
      g.slots[0].powers.pierce = 30;
      const startX = p.x;
      for (let t = 0; t < 60; t++) g.step([INPUT_RIGHT]);
      return p.x - startX > 120;
    })(),
  );

  check(
    "a blaster buried in a mushroom can still walk out",
    (() => {
      // A flea can plant one on top of you, and a shot segment becomes one
      // where it died. Being sealed in place forever would be a soft lock.
      const g = new Game(1357, { players: 1 });
      g.start();
      g.field.clear();
      const p = g.slots[0].player;
      g.field.plant(Math.floor(p.x / 40), Math.floor(p.y / 40));
      const startX = p.x;
      for (let t = 0; t < 60; t++) g.step([INPUT_LEFT]);
      return Math.abs(p.x - startX) > 40;
    })(),
  );

  check(
    "a poisoned mushroom sends the centipede diving",
    (() => {
      const g = new Game(7, { players: 1 });
      g.start();
      const train = g.trains[0];
      const head = train.segments[0];
      g.field.plant(head.col, head.row);
      g.field.poison(head.col, head.row);
      const rowBefore = head.row;
      for (let t = 0; t < 90; t++) g.step([0]);
      // Diving means it gained rows fast and did not wander sideways.
      return g.trains.length > 0 && train.segments[0].row > rowBefore + 3;
    })(),
  );

  // A mismatch has to be caught by the fingerprint on the FIRST settled tick,
  // not discovered later once the two games have visibly parted company.
  const a = new Game(31337, { players: 2, tuning: DEFAULT_TUNING });
  const b = new Game(31337, { players: 2, tuning: { ...DEFAULT_TUNING, bulletSpeed: 2000 } });
  a.start(); b.start();
  check("mismatched tuning is caught on tick 0", fingerprint(a) !== fingerprint(b));

  // Out-of-range junk from a peer or a stale file must clamp, never throw.
  const junk = normalizeTuning({ fireCooldown: -5, maxBullets: 99, centipedeSpeed: "fast", nonsense: 1 });
  check("a hostile tuning clamps into range", junk.fireCooldown >= 0.02 && junk.maxBullets <= 4);
  check("an unparseable value falls back to the default", junk.centipedeSpeed === DEFAULT_TUNING.centipedeSpeed);
}

// --- 1. Determinism: same seed + inputs, twice, same fingerprint. -----------
{
  const a = freshGame(1234, 2);
  const b = freshGame(1234, 2);
  for (let t = 0; t < 3000; t++) {
    const ins = [hostIn(t), joinIn(t)];
    a.step(ins);
    b.step(ins);
  }
  check("deterministic over 3000 ticks", fingerprint(a) === fingerprint(b));
  check("the game actually did something", a.score > 0 && a.events.shots > 0, `score ${a.score}`);
}

// --- 2. Snapshot exactness: rewind and replay lands on the same state. ------
// Rewinds are taken from several points, chosen so at least one snapshot is
// taken while the game is NOT in STATE_PLAYING. A stale `stateTimer` is dead
// data during play — the interlude states overwrite it wholesale on entry —
// so a snapshot that never lands inside a death or a level clear cannot catch
// a restore that forgets it, and that bug desyncs live co-op at every level.
{
  const seen = new Set();
  // On seed 777 with these input streams: DYING runs 885..981 and 2141..2237,
  // and LEVEL_CLEAR runs 3240..3336. So 900 and 2200 snapshot inside a death,
  // 3280 inside a level clear, and 400 covers ordinary play. The assertion
  // below fails if tuning ever shifts those spans out from under it.
  for (const from of [400, 900, 2200, 3280]) {
    const a = freshGame(777, 2);
    for (let t = 0; t < from; t++) a.step([hostIn(t), joinIn(t)]);
    seen.add(a.state);

    const snap = takeSnapshot(a);
    const sealed = Uint8Array.from(snap.cells);
    const until = from + 300;

    for (let t = from; t < until; t++) a.step([hostIn(t), joinIn(t)]);
    const straight = fingerprint(a);

    restoreSnapshot(a, snap);
    for (let t = from; t < until; t++) a.step([hostIn(t), joinIn(t)]);
    check(`snapshot/restore replays exactly from tick ${from}`, fingerprint(a) === straight);

    // A snapshot must not alias live state. The session recycles snapshot
    // buffers and can rewind to a tick whose buffer an earlier replay already
    // stepped on, so a shared array is a silently corrupted rollback target.
    check(
      `the snapshot at tick ${from} survived being stepped on`,
      snap.cells.every((v, i) => v === sealed[i]),
    );
    restoreSnapshot(a, snap);
    for (let t = from; t < until; t++) a.step([hostIn(t), joinIn(t)]);
    check(
      `restoring the tick-${from} snapshot twice replays the same`,
      fingerprint(a) === straight,
    );
  }
  // Guard the coverage itself: if tuning shifts the transition ticks, this
  // fails rather than quietly going back to testing only STATE_PLAYING.
  check(
    "the rewind tests exercised an interlude state",
    seen.has(STATE_LEVEL_CLEAR) || seen.has(STATE_DYING),
    `states seen at snapshot time: ${[...seen].join(", ")}`,
  );
}

// --- 3. Replay shape: change-only frames re-simulate the run. ---------------
{
  const a = freshGame(42, 1);
  const frames = [];
  let last = -1;
  for (let t = 0; t < 1200; t++) {
    const v = hostIn(t);
    if (v !== last) {
      frames.push([t, v]);
      last = v;
    }
    a.step([v]);
  }
  const b = freshGame(42, 1);
  let cursor = 0;
  let current = 0;
  for (let t = 0; t < 1200; t++) {
    while (cursor < frames.length && frames[cursor][0] <= t) current = frames[cursor++][1];
    b.step([current]);
  }
  check("change-only replay reproduces the run", fingerprint(a) === fingerprint(b));
}

// --- 4. Two clients over a laggy fake relay vs single-machine truth. --------
function makeRelay(lagTicks) {
  const peers = [{ inbox: [], recv: null }, { inbox: [], recv: null }];
  let clock = 0;
  let lobby = null;
  const deliver = (to, msg) => peers[to].inbox.push({ at: clock + lagTicks, data: JSON.stringify(msg) });

  const socketFor = (side) => ({
    send(data) {
      const m = JSON.parse(data);
      const other = side === 0 ? 1 : 0;
      switch (m.t) {
        case "ping":
          deliver(side, { t: "pong", at: m.at });
          break;
        case "host":
          lobby = { seed: Number(m.seed) };
          deliver(side, { t: "hosted", id: "L1" });
          break;
        case "list":
          deliver(side, { t: "lobbies", lobbies: [{ id: "L1", name: "H", levelName: "L" }] });
          break;
        case "join":
          deliver(other, { t: "start", level: {}, seed: lobby.seed, you: 0 });
          deliver(side, { t: "start", level: {}, seed: lobby.seed, you: 1 });
          break;
        default:
          deliver(other, m);
      }
    },
    close() {},
    addEventListener(type, cb) {
      if (type === "message") peers[side].recv = cb;
      if (type === "open") cb({});
    },
  });

  return {
    socketFor,
    tickWire() {
      clock++;
      for (const p of peers) {
        const due = p.inbox.filter((m) => m.at <= clock);
        p.inbox = p.inbox.filter((m) => m.at > clock);
        for (const m of due) p.recv?.({ data: m.data });
      }
    },
  };
}

{
  const relay = makeRelay(7); // ~120ms one way at 60tps
  let desyncs = 0;

  const client = (side) => {
    const state = { game: null };
    const session = createCoop({
      url: "ws://test",
      token: "check",
      tps: TPS,
      connect: () => relay.socketFor(side),
      hooks: {
        localInput: (t) => (side === 0 ? hostIn(t) : joinIn(t)),
        isFinished: () => state.game !== null && state.game.state === STATE_GAME_OVER,
        step: (ins) => state.game.step(ins),
        start: (ctx) => {
          state.game = new Game(ctx.seed >>> 0, { players: 2 });
          state.game.start();
        },
        snapshot: (reuse) => takeSnapshot(state.game, reuse),
        restore: (snap) => restoreSnapshot(state.game, snap),
        fingerprint: () => fingerprint(state.game),
        predictInput: (recent, ahead) => predictInput(recent, ahead),
      },
      on: {
        desync: () => {
          desyncs += 1;
        },
      },
    });
    return { session, state };
  };

  const host = client(0);
  const join = client(1);
  host.session.host({ name: "H", levelName: "L", payload: {}, seed: 4242 });
  for (let i = 0; i < 10; i++) relay.tickWire();
  join.session.list();
  for (let i = 0; i < 10; i++) relay.tickWire();
  join.session.join("L1");
  for (let i = 0; i < 10; i++) relay.tickWire();

  check("both clients started", host.state.game !== null && join.state.game !== null);

  let now = 0;
  // Long enough to cross this seed's first level clear (tick 1515), so the
  // interlude states are exercised under real rollback, not only in isolation.
  for (let i = 0; i < 1800; i++) {
    now += 1000 / 60;
    host.session.pump(now);
    join.session.pump(now);
    relay.tickWire();
  }
  // DRAIN: no new wall-clock, just let the outstanding inputs land — a
  // rollback client's newest ticks are provisional by design.
  for (let i = 0; i < 32; i++) {
    relay.tickWire();
    host.session.pump(now);
    join.session.pump(now);
  }

  const truthTicks = Math.min(host.state.game.tick, join.state.game.tick);
  const truth = freshGame(4242, 2);
  for (let t = 0; t < truthTicks; t++) truth.step([hostIn(t), joinIn(t)]);

  check("host agrees with single-machine truth", fingerprint(host.state.game) === fingerprintAt(host.state.game, truth, truthTicks));
  check("join agrees with single-machine truth", fingerprint(join.state.game) === fingerprintAt(join.state.game, truth, truthTicks));
  check("rollback was actually exercised", host.session.stats.rollbacks > 10, `${host.session.stats.rollbacks} rollbacks`);
  check("the desync alarm was armed", host.session.stats.checked > 0, `${host.session.stats.checked} checks`);
  check("no desyncs", desyncs === 0, `${desyncs}`);

  host.session.dispose();
  join.session.dispose();

  function fingerprintAt(clientGame, truthGame, ticks) {
    if (clientGame.tick === ticks) return fingerprint(truthGame);
    // The client ran a few ticks past the common point; re-simulate truth to
    // the client's own tick for an exact comparison.
    const copy = freshGame(4242, 2);
    for (let t = 0; t < clientGame.tick; t++) copy.step([hostIn(t), joinIn(t)]);
    return fingerprint(copy);
  }
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
