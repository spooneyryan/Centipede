// Boot: the whole GameBase integration lives here.
//
//   core/settings      one schema, applied live, persisted
//   core/loop          the frame loop (variable-delta: the co-op session or the
//                      solo accumulator owns simulation time)
//   core/perf          frame sampler; sheds the glow effects when a machine lags
//   core/document      level/replay/sprite/sound formats, share links, downloads
//   core/library       the shelves those documents live on
//   platform/display   letterboxed 1920x1080 world space, pointer mapping
//   platform/input     keyboard + gamepad behind one action map
//   platform/presentation  fullscreen (DOM or the Electron bridge), remembered size
//   platform/lifecycle pause on hide, release keys on blur, audio unlock
//   skin               the token contract dressing the page; optional canvas skins
//   sfx                the deterministic synth voicing every effect
//   telemetry          opt-in, buffered, flushed on hide
//   @ccllc/coop        internet co-op: lockstep + rollback, relay at /ws/mp
//   @ccllc/studio      React sprite and sound designers, mounted on demand

import {
  createLoop,
  createPerformanceMonitor,
  defineLibrary,
  resolveStorage,
  defineSettings,
} from "@ccllc/arcade/core";
import {
  createDisplay,
  createInput,
  createLifecycle,
  createPresentation,
} from "@ccllc/arcade/platform";
import {
  builtInSkins,
  deriveSkinFromHue,
  findSkin,
  parseSkinFile,
  useSkin,
  type Skin,
  type CanvasColors,
} from "@ccllc/arcade/skin";
import { createTelemetry } from "@ccllc/arcade/telemetry";
import { createCoop } from "@ccllc/coop";
import "@ccllc/studio/styles.css";

import { CELL, HEIGHT, WIDTH } from "./config";
import type { MushroomField } from "./mushrooms";
import { confineToBox } from "./entities";
import { blockedAt, slideThroughField } from "./collide";
import { MUSIC_TRACKS, createGameMusic } from "./music";
import { createLevelEditor } from "./editor";
import { createLevelStore, type LevelDoc } from "./levels";
import { Renderer, SPRITE_SLOTS, type OverlayText } from "./render";
import { createReplayFormat, ReplayPlayer, ReplayRecorder, type ReplayDoc } from "./replay";
import {
  DT,
  Game,
  INPUT_DOWN,
  INPUT_FIRE,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_UP,
  STATE_ATTRACT,
  STATE_GAME_OVER,
  STATE_PLAYING,
  TPS,
  fingerprint,
  packInput,
  predictInput,
  restoreSnapshot,
  takeSnapshot,
  type Input,
  type Snap,
} from "./sim";
import { SOUND_SLOTS, createSoundBank } from "./sounds";
import { SPRITE_SLOT_LABELS, createSpriteBank } from "./sprites";
import { createStudioHost } from "./ui/studioHost";
import {
  DEFAULT_TUNING,
  TUNING_FIELDS,
  TUNING_GROUPS,
  isDefaultTuning,
  normalizeTuning,
  type Tuning,
} from "./tuning";
import { drawSpriteAsset } from "@ccllc/studio/render";
import type { SpriteAsset } from "@ccllc/arcade/shmup";

const GAME_VERSION = "1.0.0";
// PAIRING TOKEN. Two clients play together only if these match exactly, so it
// must carry everything that defines behaviour. Bump it whenever the
// simulation changes, or a cached page will pair with a new build and the two
// will quietly play different games.
const COOP_TOKEN = "rustipede-v5"; // v5: mushrooms are solid to the blaster

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
};

// --- Settings: one namespaced schema, everything applies live. -------------
const SKIN_CHOICES = ["classic", ...builtInSkins.map((s) => s.id), "custom", "imported"];

// Telemetry cannot exist yet — it reads the settings store that is about to be
// built — but `defineSettings` reports during construction (storage blocked,
// a corrupt value), which is precisely when those diagnostics matter. A `let`
// declared up here is merely `undefined` at that moment rather than in its
// temporal dead zone, so the sink buffers instead of throwing and taking the
// whole page down with it.
let telemetry: ReturnType<typeof createTelemetry> | undefined;
const earlyReports: Array<[string, unknown]> = [];

/** Every GameBase module reports into the same sink. */
const report = (name: string, data?: unknown): void => {
  if (telemetry) telemetry.event(name, data);
  else earlyReports.push([name, data]);
};

// Six tuning defaults changed, and changing a default is not enough on its
// own. Settings persist the WHOLE value set the first time anything at all is
// changed, so a knob nobody ever touched is still written to storage at
// whatever the default was that day -- and on the next load that stored copy
// wins over the new default. Anyone who had already played would keep the old
// numbers and see no change.
//
// So the v1 -> v2 migration drops these keys, but ONLY where the stored value
// is still the old default. A value deliberately moved off it survives: the
// point is to stop a stale default masquerading as a choice, not to overwrite
// choices. Everything absent falls back through `sanitize` to the new default.
const RETUNED_IN_V2: ReadonlyArray<[`tune_${keyof Tuning}`, number]> = [
  ["tune_maxBullets", 2],
  ["tune_centipedeSpeed", 8.5],
  ["tune_centipedeLevelGain", 1.15],
  ["tune_fleaEvery", 5],
  ["tune_coinChance", 22],
  ["tune_coinLife", 7],
];

const settings = defineSettings<{
  soundOn: boolean;
  sfxVolume: number;
  musicOn: boolean;
  musicVolume: number;
  mouseControl: boolean;
  rawMouse: boolean;
  showFps: boolean;
  showGrid: boolean;
  glowEffects: boolean;
  skin: string;
  skinHue: number;
  playerName: string;
  telemetryEnabled: boolean;
  telemetryEndpoint: string;
  windowBounds: string;
} & Record<`tune_${keyof Tuning}`, number>>({
  namespace: "rustipede",
  version: 2, // 2: six tuning defaults changed; see RETUNED_IN_V2 above.
  migrate: (stored, from) => {
    if (from >= 2) return stored;
    const next = { ...(stored as Record<string, unknown>) };
    for (const [key, wasDefault] of RETUNED_IN_V2) {
      if (next[key] === wasDefault) delete next[key];
    }
    return next;
  },
  fields: {
    soundOn: { type: "boolean", default: true },
    sfxVolume: { type: "number", min: 0, max: 100, step: 5, default: 80 },
    musicOn: { type: "boolean", default: true },
    musicVolume: { type: "number", min: 0, max: 100, step: 5, default: 55 },
    mouseControl: { type: "boolean", default: true },
    rawMouse: { type: "boolean", default: true },
    showFps: { type: "boolean", default: false },
    showGrid: { type: "boolean", default: true },
    glowEffects: { type: "boolean", default: true },
    skin: { type: "enum", values: SKIN_CHOICES, default: "classic" },
    skinHue: { type: "number", min: 0, max: 359, step: 1, default: 120 },
    playerName: { type: "string", default: "", maxLength: 12 },
    telemetryEnabled: { type: "boolean", default: false },
    telemetryEndpoint: { type: "string", default: "", maxLength: 120 },
    windowBounds: { type: "string", default: "", maxLength: 11 },
    // Every tunable, declared from the same table the UI renders from — a
    // range cannot drift between the slider and the sanitizer.
    ...Object.fromEntries(
      TUNING_FIELDS.map((f) => [
        `tune_${f.key}`,
        { type: "number" as const, min: f.min, max: f.max, step: f.step, default: DEFAULT_TUNING[f.key] },
      ]),
    ),
  },
  report,
});

/** The tuning as the settings store currently holds it. Read at the moment a
 * run BEGINS and then frozen into that run — never consulted mid-game, or two
 * co-op machines would diverge the instant one player moved a slider. */
function settingsTuning(): Tuning {
  return normalizeTuning(
    Object.fromEntries(TUNING_FIELDS.map((f) => [f.key, settings.get(`tune_${f.key}`)])),
  );
}

// --- Telemetry: off unless switched on, and collects nothing identifying. --
const perf = createPerformanceMonitor();
perf.attach();

function telemetryOptions() {
  return {
    app: "rustipede",
    version: GAME_VERSION,
    enabled: settings.get("telemetryEnabled"),
    endpoint: settings.get("telemetryEndpoint") || undefined,
    perf,
  };
}

telemetry = createTelemetry(telemetryOptions());
for (const [name, data] of earlyReports) telemetry.event(name, data);
earlyReports.length = 0;

settings.subscribe("telemetryEnabled", (value) => telemetry?.setEnabled(Boolean(value)));
// A new endpoint means a new instance: `endpoint` is fixed at construction.
// `destroy` first, or the old instance's visibilitychange/pagehide/error
// listeners stay registered and every change doubles them.
settings.subscribe("telemetryEndpoint", () => {
  telemetry?.destroy();
  telemetry = createTelemetry(telemetryOptions());
});

// --- Storage odds and ends (high score, imported skin). --------------------
const { store: storage } = resolveStorage();
const HIGH_KEY = "rustipede.highscore.v1";
const IMPORTED_SKIN_KEY = "rustipede.skin.imported.v1";

const storedHigh = (): number => {
  const raw = storage.getItem(HIGH_KEY);
  const n = raw === null ? 0 : Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const rememberHigh = (score: number): void => {
  if (score > storedHigh()) storage.setItem(HIGH_KEY, String(score));
};

// --- Skins: the page chrome always wears one; the canvas only when asked. --
function classicSkin(): Skin {
  const base = deriveSkinFromHue(137, { id: "classic", name: "Classic", dark: true });
  return {
    ...base,
    description: "The original Rustipede palette.",
    tokens: {
      ...base.tokens,
      "surface.canvas": "#05060a",
      "surface.panel": "#0a101d",
      "surface.raised": "#10182a",
      "text.primary": "#cfe3ff",
      "text.muted": "#6b7c96",
      "border.default": "#1b2436",
      "action.primary": "#57d977",
      "action.primaryHover": "#7ce598",
      "action.onPrimary": "#04160a",
    },
  };
}

let canvasColors: CanvasColors | null = null;

function applySkinChoice(): void {
  const choice = settings.get("skin");
  if (choice === "classic") {
    useSkin(classicSkin());
    canvasColors = null;
    return;
  }
  if (choice === "custom") {
    canvasColors = useSkin(deriveSkinFromHue(settings.get("skinHue")));
    return;
  }
  if (choice === "imported") {
    const raw = storage.getItem(IMPORTED_SKIN_KEY);
    if (raw) {
      try {
        canvasColors = useSkin(parseSkinFile(JSON.parse(raw), classicSkin()));
        return;
      } catch {
        // fall through to classic
      }
    }
    useSkin(classicSkin());
    canvasColors = null;
    return;
  }
  const skin = findSkin(choice);
  if (skin) {
    canvasColors = useSkin(skin);
  } else {
    useSkin(classicSkin());
    canvasColors = null;
  }
}

settings.subscribe((_, changed) => {
  if (changed.includes("skin") || changed.includes("skinHue")) applySkinChoice();
});
applySkinChoice();

// --- Display: fixed 1920x1080 world space, letterboxed. --------------------
const canvas = el<HTMLCanvasElement>("screen");
const display = createDisplay(canvas, {
  designWidth: WIDTH,
  designHeight: HEIGHT,
  contextAttributes: { alpha: false },
});
const renderer = new Renderer(display.context);

// --- Sound and sprites: editable documents with sensible defaults. ---------
const soundBank = createSoundBank({ report });
const spriteBank = createSpriteBank({ report });

// The tunes are synthesised here and handed over as blob URLs -- see music.ts
// for why a module that plays files is being fed something this game generated.
const musicBank = createGameMusic({
  report,
  enabled: settings.get("musicOn"),
  masterGain: settings.get("musicVolume") / 100,
});
report("music.ready", { renderMs: musicBank.renderMs, tracks: Object.keys(MUSIC_TRACKS).length });

function applyAudioSettings(): void {
  soundBank.player.enabled = settings.get("soundOn");
  soundBank.player.setMasterGain(0.8 * (settings.get("sfxVolume") / 100));
  // `enabled = false` pauses in place and remembers what was asked for, so
  // switching music back on resumes the piece the game last wanted rather
  // than starting whatever was playing when it went quiet.
  musicBank.music.enabled = settings.get("musicOn");
  musicBank.music.setMasterGain(settings.get("musicVolume") / 100);
}
settings.subscribe((_, changed) => {
  if (changed.some((n) => n === "soundOn" || n === "sfxVolume" || n === "musicOn" || n === "musicVolume")) {
    applyAudioSettings();
  }
});
applyAudioSettings();

// --- Input: keyboard and gamepad behind one action map. --------------------

/** True while a modal dialog or a studio editor owns the keyboard. The game
 * must not read input through it — nor `preventDefault` it, or Space could
 * not activate the focused button. */
function uiHasFocus(): boolean {
  return studio.busy || document.querySelector("dialog[open]") !== null;
}

/** Text fields and modal dialogs both mean "not game input" as far as
 * `createInput` is concerned; a modal is simply a bigger text field. */
function keyboardIsBusy(target: unknown): boolean {
  const node = target as HTMLElement | null;
  const tag = node?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node?.isContentEditable) {
    return true;
  }
  return uiHasFocus();
}

const input = createInput({
  isTextEntry: keyboardIsBusy,
  actions: {
    left: { keys: ["ArrowLeft", "KeyA"], pad: { buttons: [14], axis: { index: 0, dir: -1 } } },
    right: { keys: ["ArrowRight", "KeyD"], pad: { buttons: [15], axis: { index: 0, dir: 1 } } },
    up: { keys: ["ArrowUp", "KeyW"], pad: { buttons: [12], axis: { index: 1, dir: -1 } } },
    down: { keys: ["ArrowDown", "KeyS"], pad: { buttons: [13], axis: { index: 1, dir: 1 } } },
    fire: { keys: ["Space"], pad: { buttons: [0, 7] } },
    start: { keys: ["Enter"], pad: { buttons: [9] } },
    // KeyP is handled in the keydown listener instead: resuming re-grabs
    // the mouse, and requestPointerLock only works from a real gesture --
    // polling the action map inside rAF is not one. The pad keeps it here,
    // because a pad player is not steering with a captured mouse anyway.
    pause: { keys: [], pad: { buttons: [8] } },
    restart: { keys: ["KeyR"], pad: { buttons: [3] }, preventDefault: false },
  },
});

// The cabinet used a trackball, so pointing is the natural control. The
// keyboard keeps working — moving the mouse takes over, pressing a direction
// key hands control back.
//
// Clicking the playfield captures the mouse (pointer lock): the cursor
// disappears and the physical mouse becomes the trackball, reading relative
// motion instead of a screen position. Escape gives it back.
//
// `mouse` is a VIRTUAL pointer, and it is clamped to the blaster's own box on
// every update. That clamp is the whole trick: shove the mouse a foot past the
// edge of the box and the virtual pointer is still sitting on the edge, so the
// first millimetre back the other way moves the blaster. Track the raw
// position instead and you would have to wind that foot back before anything
// happened.
const mouse = { x: WIDTH * 0.5, y: HEIGHT - CELL, active: false };
let mouseFire = false;
let cursorHidden = false;
let pointerLocked = false;

/** Are mushrooms currently walls for the player driving this machine? */
function shroomsAreWalls(): { field: MushroomField } | null {
  const g = currentGame();
  if (g.state !== STATE_PLAYING) return null;
  if (g.tuning.shroomsBlockPlayer <= 0) return null;
  const seat = mode === "coop" && coop.running ? coop.seat : 0;
  const me = g.slots[Math.min(seat, g.slots.length - 1)];
  if (me && me.powers.pierce > 0) return null; // ghost: walk through them
  return { field: g.field };
}

/** Move the virtual pointer, stopped by exactly what stops the blaster: the
 * box, and the mushrooms. Anything the pointer is allowed to do that the
 * blaster is not becomes travel banked up somewhere invisible — push the
 * mouse past a mushroom and the blaster would sit against it until the
 * pointer surfaced on the far side, then warp across to meet it. */
function movePointerTo(x: number, y: number): void {
  const [wantX, wantY] = confineToBox(x, y);
  const walls = shroomsAreWalls();
  if (walls) {
    [mouse.x, mouse.y] = slideThroughField(walls.field, mouse.x, mouse.y, wantX, wantY);
  } else {
    mouse.x = wantX;
    mouse.y = wantY;
  }
  mouse.active = true;
}

/** Feed the virtual pointer a relative movement, in world pixels. */
function nudgePointer(dx: number, dy: number): void {
  movePointerTo(mouse.x + dx, mouse.y + dy);
}

/** Put the virtual pointer at an absolute spot (unlocked mouse, where the
 * visible cursor is the truth). Still walled: the cursor is hidden during
 * play, so there is nothing on screen for it to disagree with. */
function placePointer(x: number, y: number): void {
  movePointerTo(x, y);
}

/** Take the mouse.
 *
 * `unadjustedMovement: true` asks the platform for RAW deltas -- no pointer
 * ballistics, no OS acceleration curve -- so the same physical sweep always
 * moves the blaster the same distance whether you flick it or ease it.
 * Chrome and Edge implement it; Firefox and Safari reject the options object
 * or ignore the flag, so the second attempt is the plain one.
 *
 * It has nothing to do with frame rate. The mouse is read at its own polling
 * rate either way -- see `nudgePointer`'s caller for where that is consumed.
 */
function grabPointer(): void {
  // Two ways an older browser refuses the options object, and they need the
  // same answer. It can reject the promise -- Safari -- or it can throw
  // synchronously on being handed an argument at all. Swallowing the throw and
  // stopping there was a bug: pointer lock never engaged on such a browser,
  // silently, because the fallback lived only on the promise path.
  const attempt = (options?: { unadjustedMovement: boolean }): Promise<void> | undefined | "threw" => {
    try {
      return (canvas.requestPointerLock as (o?: unknown) => unknown)(options) as Promise<void> | undefined;
    } catch {
      return "threw";
    }
  };
  const plain = (): void => {
    const p = attempt();
    // A rejection here is not recoverable and not worth a console entry: no
    // user gesture, or the ~1s lockout after Escape released the pointer. The
    // player still has the absolute cursor, which works.
    if (p && p !== "threw" && typeof p.catch === "function") p.catch(() => {});
  };

  if (!settings.get("rawMouse")) { plain(); return; }
  const raw = attempt({ unadjustedMovement: true });
  if (raw === "threw") { plain(); return; }
  if (raw && typeof raw.catch === "function") raw.catch(() => plain());
}

function wantsPointerLock(): boolean {
  return (
    settings.get("mouseControl") &&
    !editor.isOpen &&
    !uiHasFocus() &&
    mode !== "replay" &&
    typeof canvas.requestPointerLock === "function"
  );
}

document.addEventListener("pointerlockchange", () => {
  pointerLocked = document.pointerLockElement === canvas;
  if (pointerLocked) {
    // Start the trackball wherever the blaster already is, so capturing the
    // mouse never teleports the ship.
    const g = currentGame();
    const me = g.slots[Math.min(coop.running ? coop.seat : 0, g.slots.length - 1)];
    if (me) [mouse.x, mouse.y] = confineToBox(me.player.x, me.player.y);
    mouse.active = true;
  }
  updateLegend();
});

// --- Documents: levels, replays. -------------------------------------------
const levelStore = createLevelStore({ report });
const replayFormat = createReplayFormat({ report });
const replayLibrary = defineLibrary({
  format: replayFormat,
  key: "rustipede.replays.v1",
  limit: 20,
  report,
});

// --- Run state. ------------------------------------------------------------
type Mode = "solo" | "coop" | "replay";
let mode: Mode = "solo";
let game = new Game((Math.random() * 0x7fffffff) | 0, { highScore: storedHigh() });
let pendingLayout: LevelDoc | null = null;
let recorder: ReplayRecorder | null = null;
/** The Game the recorder is recording. A finished run's recorder outlives its
 * game — the attract screen that replaces it must not capture into it, or the
 * saved replay is a splice of two different games. */
let recorderGame: Game | null = null;
let replayer: ReplayPlayer | null = null;
let runOverReported = false;
let accumulator = 0;
let clock = 0;
let perfDegraded = false;

perf.onQualityChange((event) => {
  perfDegraded = event.degraded;
});

function currentGame(): Game {
  return mode === "replay" && replayer ? replayer.game : game;
}

function localInput(): Input {
  let bits = 0;
  if (input.isDown("left")) bits |= INPUT_LEFT;
  if (input.isDown("right")) bits |= INPUT_RIGHT;
  if (input.isDown("up")) bits |= INPUT_UP;
  if (input.isDown("down")) bits |= INPUT_DOWN;
  if (input.isDown("fire") || mouseFire) bits |= INPUT_FIRE;
  const pointer = mouse.active && settings.get("mouseControl") ? { x: mouse.x, y: mouse.y } : null;
  return packInput(bits, pointer);
}

function startSoloRun(layout: LevelDoc | null): void {
  pendingLayout = layout;
  const seed = (Math.random() * 0x7fffffff) | 0; // minted once, outside the sim
  const tuning = settingsTuning(); // read once, here, and frozen into the run
  game = new Game(seed, {
    players: 1,
    layout: layout ? layout.cells : null,
    startLevel: layout ? layout.startLevel : 1,
    highScore: storedHigh(),
    tuning,
  });
  game.start();
  recorder = new ReplayRecorder(
    seed,
    1,
    layout ? layout.startLevel : 1,
    storedHigh(),
    layout ? [...layout.cells] : null,
    tuning,
  );
  recorderGame = game;
  runOverReported = false;
  accumulator = 0;
  soloPaused = false; // a restart never begins paused
  mode = "solo";
  soundBank.resync(game);
  soundBank.player.resume();
  telemetry?.event("game.start", { players: 1, level: game.startLevel, custom: Boolean(layout) });
  updateLegend();
}

function maybeStart(): void {
  if (uiHasFocus() || editor.isOpen) return;
  if (mode === "replay") return;
  if (mode === "coop" && coop.running) {
    if (game.over) coop.rematch();
    return;
  }
  if (game.state === STATE_ATTRACT || game.state === STATE_GAME_OVER) {
    startSoloRun(pendingLayout);
  }
}

function finishRunIfOver(g: Game): void {
  if (!g.over || runOverReported) return;
  runOverReported = true;
  rememberHigh(g.score);
  telemetry?.event("game.over", { score: g.score, level: g.level, players: g.playerCount });
}

// --- Co-op: four hooks, three more for rollback, one relay. ----------------
// Never a root-absolute path: from a page under a virtual directory it would
// resolve outside the application. Built from the page's own address.
const base = new URL(".", document.baseURI);
const wsUrl = `${base.protocol === "https:" ? "wss:" : "ws:"}//${base.host}${base.pathname}ws/mp`;

interface CoopPayload {
  v: number;
  layout: number[] | null;
  startLevel: number;
  highScore: number;
  /** The HOST's tuning. The joiner's own sliders are ignored for the match —
   * two machines running different rules is precisely the desync lockstep
   * exists to rule out. */
  tuning: Tuning;
}

const coop = createCoop<Input>({
  url: wsUrl,
  token: COOP_TOKEN,
  tps: TPS,
  hooks: {
    localInput: () => localInput(),
    isFinished: () => game.over,
    // Nothing but simulation in here — step is re-run during rollback
    // replays, so side effects (telemetry, the high-score write) live in the
    // frame loop, where the state has settled.
    step: (inputs) => {
      if (recorderGame === game) recorder?.capture(game.tick, inputs);
      game.step(inputs);
    },
    start: (ctx) => {
      const payload = (ctx.payload ?? {}) as Partial<CoopPayload>;
      // normalizeTuning also covers a peer on an older build that sent none.
      const matchTuning = normalizeTuning(payload.tuning);
      game = new Game(ctx.seed >>> 0, {
        players: 2,
        layout: Array.isArray(payload.layout) ? payload.layout : null,
        startLevel: typeof payload.startLevel === "number" ? payload.startLevel : 1,
        highScore: typeof payload.highScore === "number" ? payload.highScore : 0,
        tuning: matchTuning,
      });
      game.start();
      mode = "coop";
      recorder = new ReplayRecorder(
        ctx.seed | 0,
        2,
        typeof payload.startLevel === "number" ? payload.startLevel : 1,
        typeof payload.highScore === "number" ? payload.highScore : 0,
        Array.isArray(payload.layout) ? payload.layout : null,
        matchTuning,
      );
      recorderGame = game;
      runOverReported = false;
      soundBank.resync(game);
      soundBank.player.resume();
      // A match can start while the designer or a replay is up — hosting only
      // flips `running` when the peer actually arrives — and the frame loop
      // checks co-op first, so the local player would play a live match blind.
      editor.close();
      replayer = null;
      lobby.panel.classList.add("hidden");
      updateLegend();
    },
    snapshot: (reuse) => takeSnapshot(game, reuse as Snap | undefined),
    restore: (snap) => restoreSnapshot(game, snap as Snap),
    fingerprint: () => fingerprint(game),
    predictInput: (recent, ahead) => predictInput(recent, ahead),
  },
  on: {
    status: (text, kind) => {
      lobby.status.textContent = text;
      lobby.status.dataset.kind = kind;
    },
    lobbies: (list) => {
      lobby.games.replaceChildren();
      if (list.length === 0) {
        lobby.status.textContent = "No games yet. Host one, or try again.";
        lobby.status.dataset.kind = "info";
        return;
      }
      lobby.status.textContent = "Pick a game to join.";
      lobby.status.dataset.kind = "info";
      for (const entry of list) {
        const li = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `${entry.name} — ${entry.levelName}`;
        button.addEventListener("click", () => coop.join(entry.id));
        li.append(button);
        lobby.games.append(li);
      }
    },
    started: () => {
      telemetry?.event("coop.started", { seat: coop.seat });
    },
    ended: (reason) => {
      telemetry?.event("coop.ended", { reason });
      lobby.panel.classList.remove("hidden");

      // A socket that never opened ends a session that never started. The
      // solo run behind the lobby is untouched, and the status the session
      // just set — "could not reach the co-op server at …" — is the only
      // useful thing on screen, so leave both alone.
      if (mode !== "coop") {
        if (reason !== "no-connection") {
          lobby.status.textContent = "Session ended.";
          lobby.status.dataset.kind = "info";
        }
        return;
      }

      lobby.status.textContent =
        reason === "peer-gone" ? "The other player left." : "Session ended.";
      lobby.status.dataset.kind = "info";
      mode = "solo";
      game = new Game((Math.random() * 0x7fffffff) | 0, { highScore: storedHigh() });
      // The recorder survives so the finished match can still be saved —
      // `recorderGame` still points at the match, so the attract screen this
      // replaces it with cannot capture over the recording.
      soundBank.resync(game);
      updateLegend();
    },
    desync: (tick, detail) => {
      lobby.status.textContent = `Desync at tick ${tick} (${detail}) — that is a bug; please save a replay.`;
      lobby.status.dataset.kind = "error";
      lobby.panel.classList.remove("hidden");
      telemetry?.error("coop.desync", { tick, detail });
    },
    paused: () => {
      // The renderer reads coop.paused directly; nothing to store.
    },
  },
});

// --- Lobby UI. -------------------------------------------------------------
const lobby = {
  panel: el<HTMLElement>("lobbyPanel"),
  level: el<HTMLElement>("lobbyLevel"),
  host: el<HTMLButtonElement>("lobbyHost"),
  find: el<HTMLButtonElement>("lobbyFind"),
  games: el<HTMLUListElement>("lobbyGames"),
  status: el<HTMLElement>("lobbyStatus"),
  leave: el<HTMLButtonElement>("lobbyLeave"),
  close: el<HTMLButtonElement>("lobbyClose"),
};

function openLobby(): void {
  lobby.panel.classList.remove("hidden");
  const field = pendingLayout
    ? `Hosting will use your field "${pendingLayout.name}".`
    : "Hosting uses a classic scattered field.";
  const rules = isDefaultTuning(settingsTuning())
    ? "Default rules."
    : "Your custom tuning travels to whoever joins.";
  lobby.level.textContent = `${field} ${
    "Whoever hosts sets the rules for both players."
  } ${rules}`;
}

lobby.host.addEventListener("click", () => {
  coop.host({
    name: settings.get("playerName") || `player ${100 + ((Math.random() * 900) | 0)}`,
    levelName: pendingLayout ? pendingLayout.name : "classic field",
    payload: {
      v: 1,
      layout: pendingLayout ? [...pendingLayout.cells] : null,
      startLevel: pendingLayout ? pendingLayout.startLevel : 1,
      highScore: storedHigh(),
      tuning: settingsTuning(),
    } satisfies CoopPayload,
    seed: (Math.random() * 0x7fffffff) | 0,
  });
  telemetry?.event("coop.hosted", { custom: Boolean(pendingLayout) });
});
lobby.find.addEventListener("click", () => coop.list());
lobby.leave.addEventListener("click", () => {
  const wasRunning = coop.running;
  coop.leave();
  // Leaving before a peer arrives fires no `ended` callback (the session was
  // never running), so say it here or the click looks like it did nothing.
  if (!wasRunning) {
    lobby.games.replaceChildren();
    lobby.status.textContent = "Left the lobby.";
    lobby.status.dataset.kind = "info";
  }
});
lobby.close.addEventListener("click", () => lobby.panel.classList.add("hidden"));
el<HTMLButtonElement>("btnCoop").addEventListener("click", openLobby);

// --- Studio host (React island) and the asset dialogs. ---------------------
const studio = createStudioHost(el("studioRoot"));

const spritesDialog = el<HTMLDialogElement>("spritesDialog");
const spriteRows = el<HTMLElement>("spriteRows");

function renderSpriteRows(): void {
  spriteRows.replaceChildren();
  for (const slot of SPRITE_SLOTS) {
    const row = document.createElement("div");
    row.className = "asset-row";

    const preview = document.createElement("canvas");
    preview.width = 40;
    preview.height = 40;
    const pctx = preview.getContext("2d");
    const override = spriteBank.get(slot);
    if (pctx && override) {
      pctx.save();
      pctx.translate(20, 20);
      drawSpriteAsset(pctx, override, 36);
      pctx.restore();
    }

    const label = document.createElement("span");
    label.className = "asset-label";
    label.textContent = SPRITE_SLOT_LABELS[slot];

    const state = document.createElement("span");
    state.className = "asset-state";
    state.textContent = override ? "custom" : "original";

    // Two ways in, because they open different editors and a person knows
    // which they want before they click. `Edit` continues whatever the slot
    // already holds; `Image` starts (or continues) a full-resolution one,
    // which is also the door to importing a png, jpg or gif -- the image
    // editor has that button, so this one does not need its own.
    const openSlot = (asset: SpriteAsset) => {
      spritesDialog.close();
      studio.editSprite(asset, (saved) => {
        spriteBank.set(slot, saved);
        telemetry?.event("sprite.edited", { slot, kind: saved.kind });
      });
    };

    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openSlot(spriteBank.get(slot) ?? spriteBank.blank(slot)));

    const image = document.createElement("button");
    image.type = "button";
    image.textContent = "Image";
    image.title = "Paint or import a full-resolution picture for this sprite";
    image.addEventListener("click", () => {
      const held = spriteBank.get(slot);
      openSlot(held?.kind === "image" ? held : spriteBank.blank(slot, "image"));
    });

    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset";
    reset.disabled = !override;
    reset.addEventListener("click", () => {
      spriteBank.reset(slot);
      renderSpriteRows();
    });

    row.append(preview, label, state, edit, image, reset);
    spriteRows.append(row);
  }
}

el<HTMLButtonElement>("btnSprites").addEventListener("click", () => {
  renderSpriteRows();
  spritesDialog.showModal();
});
el<HTMLButtonElement>("spritesClose").addEventListener("click", () => spritesDialog.close());

const soundsDialog = el<HTMLDialogElement>("soundsDialog");
const soundRows = el<HTMLElement>("soundRows");

function renderSoundRows(): void {
  soundRows.replaceChildren();
  for (const { slot, label: text } of SOUND_SLOTS) {
    const row = document.createElement("div");
    row.className = "asset-row";

    const label = document.createElement("span");
    label.className = "asset-label";
    label.textContent = text;

    const state = document.createElement("span");
    state.className = "asset-state";
    state.textContent = soundBank.isCustom(slot) ? "custom" : "original";

    const play = document.createElement("button");
    play.type = "button";
    play.textContent = "▶";
    play.addEventListener("click", () => soundBank.play(slot));

    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => {
      soundsDialog.close();
      studio.editSound(soundBank.get(slot), (sound) => {
        soundBank.setCustom(slot, sound);
        telemetry?.event("sound.edited", { slot });
      });
    });

    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset";
    reset.disabled = !soundBank.isCustom(slot);
    reset.addEventListener("click", () => {
      soundBank.reset(slot);
      renderSoundRows();
    });

    row.append(label, state, play, edit, reset);
    soundRows.append(row);
  }
}

el<HTMLButtonElement>("btnSounds").addEventListener("click", () => {
  renderSoundRows();
  soundsDialog.showModal();
});
el<HTMLButtonElement>("soundsClose").addEventListener("click", () => soundsDialog.close());

// --- Replays dialog. -------------------------------------------------------
const replaysDialog = el<HTMLDialogElement>("replaysDialog");
const replayRows = el<HTMLElement>("replayRows");
const replaySaveLast = el<HTMLButtonElement>("replaySaveLast");
const replayFile = el<HTMLInputElement>("replayFile");
const replayNote = el<HTMLElement>("replayNote");

function watchReplay(doc: ReplayDoc): void {
  // Not while a match runs. Replay mode stops the frame loop calling
  // `coop.pump`, so the peer would sit waiting for inputs that never come —
  // their game freezes while we watch a ghost. The level editor refuses for
  // the same reason. Guarded here rather than only on the buttons because
  // the import path lands here too.
  if (mode === "coop" && coop.running) {
    replayNote.textContent = "Not while a co-op match is running — leave the match first.";
    return;
  }
  replayNote.textContent = "";
  replaysDialog.close();
  replayer = new ReplayPlayer(doc);
  mode = "replay";
  soundBank.resync(replayer.game);
  telemetry?.event("replay.watched", { ticks: doc.ticks, players: doc.players });
  updateLegend();
}

function exitReplay(): void {
  if (mode !== "replay") return;
  mode = coop.running ? "coop" : "solo";
  replayer = null;
  soundBank.resync(game);
  updateLegend();
}

function renderReplayRows(): void {
  const matchRunning = mode === "coop" && coop.running;
  replaySaveLast.disabled = !recorder || recorder.ticks === 0;
  replayNote.textContent = matchRunning
    ? "A match is running — replays can be saved, but watching one has to wait."
    : "";
  replayRows.replaceChildren();
  const entries = replayLibrary.entries();
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "shelf-empty";
    empty.textContent = "No saved replays yet.";
    replayRows.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "shelf-entry";
    const watch = document.createElement("button");
    watch.type = "button";
    watch.className = "shelf-load";
    const seconds = Math.round(entry.document.ticks / TPS);
    watch.textContent = `${entry.name} · ${seconds}s · ${entry.document.players}P`;
    watch.disabled = matchRunning;
    watch.addEventListener("click", () => watchReplay(entry.document));
    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "⬇";
    download.title = "Download";
    download.addEventListener("click", () => replayFormat.download(entry.document, entry.name));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "shelf-delete";
    del.textContent = "✕";
    del.title = "Delete";
    del.addEventListener("click", () => {
      replayLibrary.remove(entry.id);
      renderReplayRows();
    });
    row.append(watch, download, del);
    replayRows.append(row);
  }
}

replaySaveLast.addEventListener("click", () => {
  if (!recorder || !recorderGame || recorder.ticks === 0) return;
  // Named from the game that was RECORDED, which a finished co-op match
  // outlives — reading the live `game` would label it with the attract
  // screen that replaced it.
  const kind = recorderGame.playerCount === 2 ? "co-op" : "solo";
  const name = replayLibrary.uniqueName(`${kind} · score ${recorderGame.score}`);
  const doc = replayFormat.parse(replayFormat.create(recorder.toBody(name) as Partial<ReplayDoc>));
  const entry = replayLibrary.save(doc, { name });
  renderReplayRows(); // clears replayNote, so say anything after it
  if (!entry) {
    replayNote.textContent = "The browser refused to save that replay.";
  }
});
el<HTMLButtonElement>("replayImport").addEventListener("click", () => replayFile.click());
replayFile.addEventListener("change", async () => {
  const file = replayFile.files?.[0];
  replayFile.value = "";
  if (!file) return;
  let doc: ReplayDoc;
  try {
    doc = await replayFormat.readFile(file);
  } catch (err) {
    // The document format already produces the useful sentence ("This file
    // belongs to a different application.", …) — show it.
    replayNote.textContent = err instanceof Error ? err.message : "That file is not a replay.";
    return;
  }
  const entry = replayLibrary.save(doc, { name: replayLibrary.uniqueName(doc.name) });
  renderReplayRows();
  if (entry) watchReplay(doc);
  else replayNote.textContent = "The browser refused to save that replay.";
});
el<HTMLButtonElement>("btnReplays").addEventListener("click", () => {
  renderReplayRows();
  replaysDialog.showModal();
});
el<HTMLButtonElement>("replaysClose").addEventListener("click", () => replaysDialog.close());

// --- Settings dialog. ------------------------------------------------------
const settingsDialog = el<HTMLDialogElement>("settingsDialog");
const settingsForm = el<HTMLFormElement>("settingsForm");
const skinSelect = el<HTMLSelectElement>("skinSelect");
const skinFile = el<HTMLInputElement>("skinFile");
const skinStatus = el<HTMLElement>("skinStatus");
const tuningRows = el<HTMLElement>("tuningRows");
const tuningStatus = el<HTMLElement>("tuningStatus");

const saySkin = (text: string, kind: "info" | "error"): void => {
  skinStatus.textContent = text;
  skinStatus.dataset.kind = kind;
};

function populateSkinSelect(): void {
  skinSelect.replaceChildren();
  const add = (value: string, label: string): void => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    skinSelect.append(option);
  };
  add("classic", "Classic (pixel-perfect)");
  for (const skin of builtInSkins) add(skin.id, skin.name);
  add("custom", "Custom hue…");
  if (storage.getItem(IMPORTED_SKIN_KEY)) add("imported", "Imported skin");
}

/** Slider per knob, grouped, built from TUNING_FIELDS — the same table the
 * settings schema declared its ranges from. Live values are kept in the form
 * itself; `fromFormData` collects them on Save like every other field. */
function buildTuningRows(): void {
  if (tuningRows.childElementCount > 0) return; // built once
  for (const group of TUNING_GROUPS) {
    const heading = document.createElement("p");
    heading.className = "tune-group";
    heading.textContent = group;
    tuningRows.append(heading);

    for (const field of TUNING_FIELDS.filter((f) => f.group === group)) {
      const row = document.createElement("div");
      row.className = "tune-row";
      row.dataset.key = field.key;

      const label = document.createElement("label");
      label.htmlFor = `tune_${field.key}`;
      label.innerHTML = `${field.label}<span class="tune-hint">${field.hint}</span>`;

      const slider = document.createElement("input");
      slider.type = "range";
      slider.id = `tune_${field.key}`;
      slider.name = `tune_${field.key}`;
      slider.min = String(field.min);
      slider.max = String(field.max);
      slider.step = String(field.step);

      const readout = document.createElement("span");
      readout.className = "tune-value";

      const decimals = field.step >= 1 ? 0 : String(field.step).split(".")[1].length;
      const paint = () => {
        const value = Number(slider.value);
        readout.textContent = `${value.toFixed(decimals)}${field.unit ?? ""}`;
        row.classList.toggle("changed", value !== DEFAULT_TUNING[field.key]);
      };
      slider.addEventListener("input", () => {
        paint();
        refreshTuningStatus();
      });
      // Repaint when the form is repopulated from the store.
      slider.addEventListener("change", paint);
      (slider as HTMLInputElement & { repaint?: () => void }).repaint = paint;

      row.append(label, slider, readout);
      tuningRows.append(row);
    }
  }
}

/** Says whether what is on screen differs from the SHIPPED defaults -- which
 * are close to the 1981 game but deliberately not it any more -- and warns
 * that a change takes effect on the next run, not the one in progress. */
function refreshTuningStatus(): void {
  const shown = normalizeTuning(
    Object.fromEntries(
      TUNING_FIELDS.map((f) => [
        f.key,
        Number((settingsForm.elements.namedItem(`tune_${f.key}`) as HTMLInputElement).value),
      ]),
    ),
  );
  if (isDefaultTuning(shown)) {
    tuningStatus.textContent = "Playing the shipped defaults.";
    return;
  }
  const changed = TUNING_FIELDS.filter((f) => shown[f.key] !== DEFAULT_TUNING[f.key]).length;
  const live = mode === "coop" && coop.running;
  tuningStatus.textContent =
    `${changed} setting${changed === 1 ? "" : "s"} changed from the original. ` +
    (live
      ? "The match in progress keeps the host's rules; this applies to the next one."
      : "Takes effect on your next run.");
}

function populateSettingsForm(): void {
  const all = settings.all();
  for (const name of settings.names) {
    const field = settingsForm.elements.namedItem(name);
    if (!field) continue;
    const value = all[name as keyof typeof all];
    if (field instanceof HTMLInputElement && field.type === "checkbox") {
      field.checked = Boolean(value);
    } else if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLSelectElement
    ) {
      field.value = String(value);
      (field as HTMLInputElement & { repaint?: () => void }).repaint?.();
    }
  }
  refreshTuningStatus();
}

el<HTMLButtonElement>("btnSettings").addEventListener("click", () => {
  populateSkinSelect();
  buildTuningRows();
  populateSettingsForm();
  saySkin("", "info");
  settingsDialog.showModal();
});

// On submit rather than the dialog's close event — submit fires synchronously
// with the Save click, and carries which button did it.
settingsForm.addEventListener("submit", (e) => {
  const submitter = (e as SubmitEvent).submitter as HTMLButtonElement | null;
  if (submitter?.value !== "save") return;
  // The FORM ELEMENT, not FormData: FormData cannot tell an unchecked
  // checkbox from a field the dialog does not carry.
  settings.patch(settings.fromFormData(settingsForm as unknown as Record<string, unknown>));
});

el<HTMLButtonElement>("tuningReset").addEventListener("click", () => {
  for (const field of TUNING_FIELDS) {
    const slider = settingsForm.elements.namedItem(`tune_${field.key}`) as HTMLInputElement;
    slider.value = String(DEFAULT_TUNING[field.key]);
    (slider as HTMLInputElement & { repaint?: () => void }).repaint?.();
  }
  refreshTuningStatus();
});

el<HTMLButtonElement>("skinImport").addEventListener("click", () => skinFile.click());
skinFile.addEventListener("change", async () => {
  const file = skinFile.files?.[0];
  skinFile.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const skin = parseSkinFile(JSON.parse(text), classicSkin());
    storage.setItem(IMPORTED_SKIN_KEY, JSON.stringify(skin));
    settings.set("skin", "imported");
    populateSkinSelect();
    populateSettingsForm();
    saySkin(`Imported "${skin.name}".`, "info");
  } catch (err) {
    // Into the Settings dialog's own line: the lobby panel is behind it.
    saySkin(err instanceof Error ? err.message : "That file is not a skin.", "error");
  }
});

// --- Level editor. ---------------------------------------------------------
const editor = createLevelEditor({
  elements: {
    panel: el("editorPanel"),
    canvas,
    name: el<HTMLInputElement>("editorName"),
    startLevel: el<HTMLInputElement>("editorStartLevel"),
    shelf: el("editorShelf"),
    status: el("editorStatus"),
    help: el("editorHelp"),
    buttons: {
      save: el<HTMLButtonElement>("editorSave"),
      saveAs: el<HTMLButtonElement>("editorSaveAs"),
      newField: el<HTMLButtonElement>("editorNew"),
      clear: el<HTMLButtonElement>("editorClear"),
      scatter: el<HTMLButtonElement>("editorScatter"),
      playtest: el<HTMLButtonElement>("editorPlaytest"),
      hostCoop: el<HTMLButtonElement>("editorHostCoop"),
      download: el<HTMLButtonElement>("editorDownload"),
      share: el<HTMLButtonElement>("editorShare"),
      importFile: el<HTMLButtonElement>("editorImport"),
      close: el<HTMLButtonElement>("editorClose"),
      undo: el<HTMLButtonElement>("editorUndo"),
      redo: el<HTMLButtonElement>("editorRedo"),
    },
    file: el<HTMLInputElement>("editorFile"),
  },
  store: levelStore,
  renderer,
  report,
  onPlaytest: (doc) => {
    telemetry?.event("level.playtest");
    startSoloRun(doc);
  },
  onHostCoop: (doc) => {
    pendingLayout = doc;
    openLobby();
  },
  onClose: () => {
    accumulator = 0;
    updateLegend();
  },
});

el<HTMLButtonElement>("btnEditor").addEventListener("click", () => {
  if (mode === "coop" && coop.running) return; // not while a match runs
  if (pointerLocked) document.exitPointerLock();
  exitReplay();
  editor.open();
  updateLegend();
});

// --- Pointer wiring. -------------------------------------------------------

/** Is the cursor over chrome that FLOATS ON the playfield? The editor and
 * lobby panels are `position: absolute` inside the stage and a modal covers
 * the lot, so "inside the canvas rectangle" is not the same question as "the
 * player is pointing at the game" — ask what the cursor is actually over. */
function overChrome(e: MouseEvent): boolean {
  const node = e.target as Element | null;
  return (
    typeof node?.closest === "function" &&
    node.closest("dialog[open], .panel:not(.hidden)") !== null
  );
}

// Tracked on the WINDOW rather than the canvas.
//
// A canvas-scoped listener stops firing the instant the cursor leaves the
// element, which freezes the blaster wherever it happened to be — you slide
// off the edge of the playfield and the ship simply stops answering, which
// reads as the game losing the mouse. Watching the window means the pointer
// keeps tracking wherever the cursor goes, and since the virtual pointer is
// clamped to the blaster's box anyway, a cursor outside the playfield just
// maps to the nearest legal position. Coming back moves the blaster on the
// first pixel, with nothing banked up to unwind.
// `pointermove`, not `mousemove`, for one reason: `getCoalescedEvents`.
//
// A 1000 Hz mouse produces roughly eight samples between two frames of a
// 120 Hz display, and the browser merges them into one `mousemove` whose
// movement is their SUM. For a pointer that only had to end up in the right
// place that is identical -- but this pointer is swept against the mushroom
// field on the way, and one long sweep is not the same as eight short ones.
// It rounds corners it should have caught on. Replaying the samples feeds the
// same total displacement through the collision in the order it happened.
window.addEventListener("pointermove", (e) => {
  if (editor.isOpen) {
    // The editor paints cells, so it wants the canvas and nothing else — its
    // own panel covers the right-hand third of the field it is painting. The
    // target test is what the deleted `canvas.mouseleave` used to do, and it
    // is right where a rectangle test is wrong.
    if (e.target !== canvas) {
      editor.pointerLeave();
      return;
    }
    const p = display.toWorld(e.clientX, e.clientY);
    editor.pointer(p.x, p.y, e.buttons);
    return;
  }
  // Chrome is UI, not aim — the same rule `keyboardIsBusy` already applies to
  // keys. Without this, sweeping across the lobby panel or the Settings dialog
  // would drag the blaster along underneath it.
  if (uiHasFocus() || overChrome(e)) return;
  if (pointerLocked) {
    // Captured: relative motion only. The canvas is a 1920x1080 world scaled
    // to fit, so CSS pixels of movement have to be divided by that scale to
    // become world pixels — otherwise sensitivity would change with the
    // window size.
    const scale = display.viewport.scale || 1;
    const samples = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
    // Guard rather than trust. Coalesced events reporting zero movement under
    // pointer lock has been a real browser bug, and aiming silently dying is
    // far worse than losing the sub-frame detail, so fall back the moment the
    // samples disagree with the event that carried them.
    let dx = 0;
    let dy = 0;
    for (const sample of samples) { dx += sample.movementX; dy += sample.movementY; }
    if (samples.length === 0 || ((dx === 0 && dy === 0) && (e.movementX !== 0 || e.movementY !== 0))) {
      nudgePointer(e.movementX / scale, e.movementY / scale);
      return;
    }
    for (const sample of samples) nudgePointer(sample.movementX / scale, sample.movementY / scale);
    return;
  }
  const p = display.toWorld(e.clientX, e.clientY);
  placePointer(p.x, p.y);
});
canvas.addEventListener("mousedown", (e) => {
  if (editor.isOpen) {
    const p = display.toWorld(e.clientX, e.clientY);
    editor.pointer(p.x, p.y, e.buttons);
    e.preventDefault();
    return;
  }
  if (!pointerLocked) {
    const p = display.toWorld(e.clientX, e.clientY);
    placePointer(p.x, p.y);
    // Take the mouse. It stays taken until Escape.
    if (wantsPointerLock()) grabPointer();
  }
  mouseFire = true;
  soundBank.player.resume();
  maybeStart(); // a click also drops the coin on the title screen
  e.preventDefault();
});
window.addEventListener("mouseup", () => {
  mouseFire = false;
  editor.pointerUp();
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// --- Global keys the action map does not own. ------------------------------
window.addEventListener("keydown", (e) => {
  // A modal <dialog> closes itself on Escape and the same keydown still
  // bubbles here — handling it again would abandon a running match. The same
  // guard keeps the editor's brush shortcuts from firing out of a dialog,
  // whose focused <button> is not "text entry".
  if (uiHasFocus()) return;
  if (editor.handleKey(e)) {
    e.preventDefault();
    return;
  }
  // F: the frame-rate readout. Not a game action, so it works anywhere the
  // keyboard is not busy -- during play, on the title screen, in the editor --
  // and it writes through the settings store so the checkbox in Settings and
  // the next session both agree with what F just did.
  if (e.code === "KeyF") {
    settings.set("showFps", !settings.get("showFps"));
    if (settingsDialog.open) populateSettingsForm();
    updateFps();
    e.preventDefault();
    return;
  }

  // P: pause, and the mouse follows the pause. Handled here rather than
  // through the action map because resuming re-grabs the mouse, which needs a
  // real user gesture.
  if (e.code === "KeyP" && !editor.isOpen && mode !== "replay") {
    togglePauseAndMouse(true);
    e.preventDefault();
    return;
  }

  if (e.code === "Escape") {
    // The browser releases a locked pointer on Escape whatever this handler
    // does, so the only question is what else Escape means. During a run it
    // means pause -- and since the mouse is being taken away anyway, pausing
    // is the one behaviour that leaves the game in a coherent state.
    if (mode === "replay") {
      exitReplay();
      return;
    }
    if (!lobby.panel.classList.contains("hidden")) {
      lobby.panel.classList.add("hidden");
      return;
    }
    // Leaving a co-op match used to live here. It is the Leave button in the
    // Co-op panel now: Escape during a match pauses it for both players, which
    // is what you want far more often than dropping out of it.
    togglePauseAndMouse(true);
  }
});

// --- Fullscreen, lifecycle, loop. ------------------------------------------
const presentation = createPresentation({
  element: el("app"),
  settings,
  boundsField: "windowBounds",
});
presentation.bindButton(el<HTMLButtonElement>("btnFullscreen"));

/** A player-initiated solo pause. Deliberately NOT `loop.setPaused` — that
 * stops `update` running, and `update` is where the pause key is read, so a
 * loop-level pause could never be lifted from the keyboard or the pad. It
 * would also silence `coop.pump`. Gate the simulation instead, the way the
 * replay branch already does, and leave the loop turning. */
let soloPaused = false;

function isPaused(): boolean {
  return mode === "coop" ? coop.paused : soloPaused || lifecycle.paused;
}

function togglePause(): void {
  if (mode === "replay") return;
  if (mode === "coop" && coop.running) {
    coop.setPaused(!coop.paused);
  } else {
    soloPaused = !soloPaused;
  }
}

/** Pause and hand the mouse back; resume and take it again.
 *
 * `gesture` must be true only when called from a real user event. Chrome
 * grants pointer lock from a gesture and refuses it otherwise, and it refuses
 * for about a second after an Escape has released the lock -- so a resume that
 * cannot re-grab falls back to the absolute cursor rather than pretending. */
function togglePauseAndMouse(gesture: boolean): void {
  const wasPaused = isPaused();
  togglePause();
  updateLegend();

  if (!wasPaused) {
    // Pausing. A captured mouse with a paused game is a cursor nobody can
    // reach, so give it back unconditionally.
    if (pointerLocked || document.pointerLockElement === canvas) document.exitPointerLock();
    return;
  }
  // Resuming: take it back, if the player had it and this is a real gesture.
  if (gesture && !pointerLocked && wantsPointerLock()) grabPointer();
}

const legend = el<HTMLElement>("legend");
function updateLegend(): void {
  if (editor.isOpen) {
    legend.innerHTML =
      "<b>CLICK</b> plant &nbsp;·&nbsp; <b>RIGHT-CLICK</b> erase &nbsp;·&nbsp; <b>1-4</b> brush &nbsp;·&nbsp; <b>0/E</b> eraser &nbsp;·&nbsp; <b>CTRL+Z</b> undo &nbsp;·&nbsp; <b>ESC</b> close";
  } else if (mode === "replay") {
    legend.innerHTML = "<b>REPLAY</b> &nbsp;·&nbsp; watching a recorded run &nbsp;·&nbsp; <b>ESC</b> to exit";
  } else if (mode === "coop") {
    const seat = coop.running ? `you are <b>PLAYER ${coop.seat + 1}</b> (marked ⌄)` : "waiting";
    const release = "";
    legend.innerHTML =
      `<b>CO-OP</b> &nbsp;·&nbsp; ${seat} &nbsp;·&nbsp; <b>MOUSE</b>/<b>WASD</b> move &nbsp;·&nbsp; <b>SPACE</b> fire &nbsp;·&nbsp; <b>P</b>/<b>ESC</b> pause &nbsp;·&nbsp; <b>R</b> rematch${release}`;
  } else if (pointerLocked) {
    legend.innerHTML =
      "<b>MOUSE CAPTURED</b> &nbsp;·&nbsp; move to fly the blaster &nbsp;·&nbsp; <b>CLICK</b> fire &nbsp;·&nbsp; <b>R</b> restart &nbsp;·&nbsp; <b>P</b>/<b>ESC</b> pause and release the mouse";
  } else {
    legend.innerHTML =
      "<b>CLICK</b> to capture the mouse &nbsp;·&nbsp; <b>&larr; &uarr; &rarr; &darr;</b> / <b>WASD</b> move &nbsp;·&nbsp; <b>SPACE</b> fire &nbsp;·&nbsp; <b>ENTER</b> start &nbsp;·&nbsp; <b>P</b>/<b>ESC</b> pause";
  }
}

const netstats = el<HTMLElement>("netstats");

function overlayFor(): OverlayText {
  if (mode === "coop") {
    return {
      subtitle: "Internet co-op",
      startLine: "WAITING FOR THE MATCH",
      againLine: "CLICK OR PRESS R FOR A REMATCH",
    };
  }
  if (mode === "replay") {
    return {
      subtitle: "Replay",
      startLine: "REPLAY",
      againLine: "REPLAY OVER — PRESS ESC",
    };
  }
  return {
    subtitle: "A Rust game, ported to TypeScript",
    startLine: "CLICK OR PRESS ENTER TO START",
    againLine: "CLICK OR PRESS ENTER TO PLAY AGAIN",
  };
}

/** Sim state out, one track name in.
 *
 * Called from the RENDER path and nowhere else. `step()` cannot reach it, so a
 * rolled-back tick can never restart a piece -- which is the failure this
 * would otherwise have: co-op rewinds several ticks a second, and music that
 * reacted inside the simulation would stutter on every one of them.
 *
 * A death and a level clear are deliberately absent below: they leave the key
 * unchanged, so the level's track plays on through losing a blaster rather
 * than cutting out and restarting. */
let musicKey = "";
function updateMusic(): void {
  const g = currentGame();
  const key =
    editor.isOpen || g.state === STATE_ATTRACT ? "attract"
    : g.state === STATE_GAME_OVER ? "over"
    : g.state === STATE_PLAYING ? `level:${g.level}`
    : musicKey;
  if (key === musicKey) return;
  musicKey = key;

  if (key === "attract") void musicBank.music.play("attract");
  else if (key === "over") musicBank.music.stop({ fadeSeconds: 1.5 });
  // Levels are mapped in pairs, so this is a no-op on half of them and a
  // crossfade on the other half -- and a retried level never restarts it.
  else void musicBank.music.playFor(g.level);
}

/** The frame-rate readout.
 *
 * `perf` is already sampling every frame to decide when to shed the glow
 * effects, so this is a second reader of numbers the game was collecting
 * anyway rather than a new measurement.
 *
 * It shows the RENDER rate, which on a 120 Hz display is 120. The simulation
 * is a different number and always 60: `TPS` is fixed, every input is stamped
 * to a tick, and two machines agree because they agree on that. A faster
 * screen draws more frames of the same 60 ticks; it does not simulate more.
 */
const fpsReadout = el<HTMLElement>("fps");
let fpsShownAt = 0;
function updateFps(): void {
  if (!settings.get("showFps")) {
    if (fpsReadout.textContent !== "") fpsReadout.textContent = "";
    return;
  }
  // Four times a second. The number is a rolling median already, and a value
  // that changes every frame is unreadable.
  const now = performance.now();
  if (now - fpsShownAt < 250 && fpsReadout.textContent !== "") return;
  fpsShownAt = now;

  const { current, min } = perf.stats;
  if (current === null) { fpsReadout.textContent = "-- fps"; return; }
  const low = min === null ? "" : `  (low ${Math.round(min)})`;
  fpsReadout.textContent = `${Math.round(current)} fps${low}${perfDegraded ? "  glow off" : ""}`;
}

const loop = createLoop({
  fixedStep: null, // the co-op session or the solo accumulator owns sim time
  update: (dt) => {
    input.poll();

    // Whichever device moved last wins the blaster.
    if (
      input.pressed("left") ||
      input.pressed("right") ||
      input.pressed("up") ||
      input.pressed("down")
    ) {
      mouse.active = false;
    }
    // A modal dialog owns the keyboard AND the pad while it is up, or Space
    // on a focused button would also start a run behind it.
    if (!uiHasFocus()) {
      if (input.pressed("pause")) togglePause();
      if (input.pressed("start") || input.pressed("fire")) maybeStart();
      if (input.pressed("restart")) {
        if (mode === "coop" && coop.running) coop.rematch();
        else if (mode === "solo" && !editor.isOpen && game.state !== STATE_ATTRACT) {
          startSoloRun(pendingLayout);
        }
      }
    }

    if (mode === "coop" && coop.running) {
      accumulator = 0;
      coop.pump(performance.now());
      finishRunIfOver(game);
      return;
    }
    if (mode === "replay" && replayer) {
      if (!isPaused()) replayer.advance(dt);
      return;
    }
    if (editor.isOpen || soloPaused) {
      accumulator = 0;
      return;
    }
    // Solo: the classic fixed-timestep accumulator.
    accumulator += dt;
    let guard = 0;
    while (accumulator >= DT && guard < 8) {
      const inputs = [localInput()];
      // `game.over` is still false on the tick that ends the run, so the
      // recording covers every live tick and stops there — the game-over card
      // is not part of the run and must not inflate its length.
      if (recorderGame === game && !game.over) recorder?.capture(game.tick, inputs);
      game.step(inputs);
      finishRunIfOver(game);
      accumulator -= DT;
      guard += 1;
    }
    if (guard === 8) accumulator = 0; // discard what cannot be simulated
  },
  render: (dt) => {
    clock += dt;
    perf.frame(performance.now());
    updateMusic();
    updateFps();

    display.clear("#000");
    if (editor.isOpen) {
      editor.draw({
        colors: canvasColors,
        sprites: spriteBank.overrides(),
        glow: settings.get("glowEffects") && !perfDegraded,
        grid: true,
        clock,
        paused: false,
        overlay: overlayFor(),
        localSeat: mode === "coop" && coop.running ? coop.seat : -1,
      });
    } else {
      const g = currentGame();
      renderer.frame(g, {
        colors: canvasColors,
        sprites: spriteBank.overrides(),
        glow: settings.get("glowEffects") && !perfDegraded,
        grid: settings.get("showGrid"),
        clock,
        paused: isPaused(),
        overlay: overlayFor(),
        localSeat: mode === "coop" && coop.running ? coop.seat : -1,
      });
      soundBank.hear(g);
    }

    // While the mouse is flying the blaster, the blaster is the cursor.
    // Under pointer lock the browser hides it for us.
    const g = currentGame();
    const hide =
      !pointerLocked &&
      mouse.active &&
      !isPaused() &&
      g.state === STATE_PLAYING &&
      !editor.isOpen &&
      mode !== "replay";
    if (hide !== cursorHidden) {
      cursorHidden = hide;
      canvas.style.cursor = hide ? "none" : "";
    }

    if (coop.running) {
      const s = coop.stats;
      netstats.textContent = `ping ${Math.round(s.rtt)}ms · +${s.ahead}t · ${s.rollbacks} rewinds · ${s.checked} checks · delay ${s.inputDelay}t · tick ${(s.stepMs * 1000).toFixed(0)}µs`;
    } else if (netstats.textContent !== "") {
      netstats.textContent = "";
    }
  },
  report,
});

// The lifecycle pauses the loop on hide and releases held keys on blur; the
// co-op session keeps ticking from its own hidden-tab heartbeat, which is
// exactly the division we want. Created after the loop so it can pause it.
// Only the pause the hide path itself set is ours to lift. A pause either
// player asked for has to survive a tab switch — lifecycle's own `manual`
// flag cannot know about it, because co-op pauses travel through
// `coop.setPaused` rather than through the lifecycle.
let pausedByHide = false;

const lifecycle = createLifecycle({
  input,
  // Two audio graphs, one unlock. Lifecycle only ever calls `resume`, so an
  // adapter is enough and neither module needs to know about the other.
  audio: {
    resume: async () => {
      await Promise.all([soundBank.player.resume(), musicBank.music.resume()]);
    },
  },
  loop,
  onPause: () => {
    if (coop.running && !coop.paused) {
      pausedByHide = true;
      coop.setPaused(true);
    }
  },
  onResume: () => {
    if (coop.running && pausedByHide) coop.setPaused(false);
    pausedByHide = false;
  },
});

// A diagnostics handle. `__rustipede.coop.lagMs = 150` from a console is the
// documented way to meet your own netcode on one desk; the rest lets a test
// harness (or a curious player) drive the frame loop by hand.
(globalThis as unknown as Record<string, unknown>).__rustipede = {
  version: GAME_VERSION,
  get game() {
    return currentGame();
  },
  get mode() {
    return mode;
  },
  coop,
  loop,
  display,
  music: musicBank.music,
  musicRenderMs: musicBank.renderMs,
  musicUrls: musicBank.urls,
  settings,
  lifecycle,
  perf,
  startSolo: () => startSoloRun(pendingLayout),
  // Diagnostics for the input gates, which are easy to get stuck.
  get uiHasFocus() {
    return uiHasFocus();
  },
  get studioBusy() {
    return studio.busy;
  },
  get paused() {
    return isPaused();
  },
  get pointerLocked() {
    return pointerLocked;
  },
  get wantsPointerLock() {
    return wantsPointerLock();
  },
  get pointer() {
    return { ...mouse };
  },
  get wallsActive() {
    return shroomsAreWalls() !== null;
  },
  blockedAt: (x: number, y: number) => blockedAt(currentGame().field, x, y),
  slide: (fx: number, fy: number, tx: number, ty: number) =>
    slideThroughField(currentGame().field, fx, fy, tx, ty),
};

// --- Share links: a #level=… in the URL opens the designer on that field. --
const shared = levelStore.format.readShareFromLocation({ param: "level" });
if (shared.document) {
  editor.open(shared.document);
}

updateLegend();
loop.start();
telemetry?.event("boot", { version: GAME_VERSION });
