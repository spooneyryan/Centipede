# Rustipede — TypeScript

The Rust Centipede (`../Rust`) ported to TypeScript, pixel-perfect at its
native 1920×1080, and rebuilt on **GameBase** (`../../../GameBase/GameBase`)
so it picks up everything the framework offers:

| Feature | How |
|---|---|
| **Internet co-op** | `@ccllc/coop` — lockstep + rollback, two blasters on one field, nothing on the wire but inputs. The C# relay (`CCLLC.Coop.Relay`) is hosted by `server/Program.cs` at `/ws/mp`. |
| **Editable sprites** | Every drawable (mushroom, head, body, both blasters, bullet) can be redrawn in `@ccllc/studio`'s pixel/vector editor. Overrides persist on a library shelf; Reset returns the original procedural art. |
| **Editable sounds** | Every effect is a `SfxDefinition` synth document (Atari-2600-to-NES era), editable in the sound designer, exportable as WAV/JSON. |
| **Level editor** | Paint a mushroom field, keep it on a shelf, download it, share it as a `#level=…` link, playtest it solo, or host it as a co-op match. Undo via `core/history`, shortcuts via `editor/keymap`. |
| **Replays** | Deterministic ghosts: seed + inputs, a few KB. Save the last run (solo or co-op), watch it back, import/export as files. |
| **Fullscreen** | `platform/presentation` — DOM fullscreen in a browser, the real window under the Electron wrapper, windowed size remembered in settings. |
| **Settings** | `core/settings` — one schema, applied live: sound, volume, mouse control, grid, glow, skins, player name, telemetry opt-in. |
| **Skins** | The page chrome wears the skin contract's `--game-*` tokens. The canvas defaults to the original palette (pixel-perfect); pick a built-in skin, derive one from a hue, or import a skin file. |
| **Controller** | `platform/input` — keyboard and gamepad behind one action map (d-pad/left stick move, A/RT fire, Start starts, button 8 pauses, Y restarts). |
| **Telemetry** | `createTelemetry` — off by default, nothing identifying; every GameBase module reports into it (`loop.overrun`, `document.rejected`, …). Needs an endpoint configured in Settings. |
| **Perf scaling** | `core/perf` — when a machine falls below its own baseline frame rate, the glow effects shed automatically. |

## Run it

```powershell
npm install
npm run build
npm run relay        # builds nothing, serves dist/ + the relay on http://localhost:5190
```

Open <http://localhost:5190> — in **two windows** for co-op (two tabs pause
each other: a hidden tab sends the shared pause).

Dev loop with HMR (relay in a second terminal):

```powershell
npm run dev          # Vite on 5173, proxies /ws/mp to 5190
```

```powershell
npm run relay
```

## Prove it

```powershell
npm run check
```

Runs headlessly in Node — the simulation has no DOM imports, and the co-op
client takes a fake socket — covering, in order:

- **the oracle itself.** Every other assertion compares fingerprints, so the
  suite first proves the fingerprint *discriminates*: fourteen perturbations
  (a tick, a life, the RNG stream, one mushroom, a bullet, …) must each change
  it. Without this, a fingerprint that stopped working would make every
  remaining check pass vacuously.
- determinism over 3000 ticks, and that the game actually did something;
- snapshot/restore exactness under rewind, from four points chosen so at least
  one lands **inside** a death or a level clear — a stale `stateTimer` is dead
  data during play, so a rewind that never enters an interlude cannot catch a
  restore that forgets one;
- that a snapshot is **not aliased** to live state (the session recycles
  snapshot buffers, so a shared array is a silently corrupted rewind target);
- replay reproduction from change-only frames;
- **two complete co-op clients over a simulated 120 ms link**, checked against
  a single machine holding both inputs — GameBase's AGENTS.md step 10 — with
  the drain the docs insist on, and assertions that rollback was genuinely
  exercised and the desync alarm was genuinely armed.

The suite is mutation-tested: breaking the fingerprint, dropping `stateTimer`
from `restoreSnapshot`, or aliasing the mushroom field into a snapshot each
fail it loudly (14, 10 and 9 assertions respectively). All three used to pass.

```powershell
npm run typecheck
```

## Desktop

```powershell
npm i -D electron
npm run desktop
```

The wrapper starts the server if nothing answers on 5190 and gives the
Full screen button the real window via GameBase's desktop bridge.

## How it references GameBase

**By path, not by feed** — the form GameBase's docs bless for developing
against source: `vite.config.ts` aliases `@ccllc/coop`, `@ccllc/arcade/*` and
`@ccllc/studio` into `../../../GameBase/GameBase/packages`, and
`server/Server.csproj` holds a `ProjectReference` to the relay. Switching to
the published packages is an `npm install` plus deleting the aliases.

Because the aliases point at a live checkout rather than a pinned package,
GameBase can change underneath the game. Re-run `npm run check` and
`npm run typecheck` after pulling it — they are cheap and they are what would
catch a breaking change.

## Layout

```
src/
  config.ts      constants — a 48×27 grid of 40px cells, ported 1:1 from config.rs
  rng.ts         xorshift64* on BigInt, bit-identical to the Rust sequence
  mushrooms.ts   the field                             (mushrooms.rs)
  centipede.ts   segments, trains, waves               (centipede.rs)
  entities.ts    blaster + bullets                     (entities.rs)
  sim.ts         the Game: fixed-tick step(inputs), 1–2 players,
                 snapshot/restore/fingerprint for rollback   (game.rs)
  render.ts      pixel-perfect port of the original canvas drawing,
                 plus skin colours, sprite overrides, glow toggle
  sounds.ts      the editable synth-document soundtrack
  sprites.ts     the editable sprite overrides
  levels.ts      the level document format + shelf
  replay.ts      record/replay documents
  editor.ts      the field designer
  ui/studioHost.tsx  the React island hosting the studio editors
  main.ts        boot: every GameBase module wired together
server/          ASP.NET host: static files + Relay.Run at /ws/mp
scripts/check.mjs  the headless proof
desktop/main.cjs   the Electron wrapper
```

The rule that decides where code goes, from GameBase's AGENTS.md: *does it
affect what happens, or only what it looks like?* Everything in the first
category lives in `sim.ts` and its imports, uses only `+ - * / sqrt` and the
seeded RNG, and is bit-identical on every machine. Everything else is free to
use `Math.sin` and wall clocks, and does.

Simulation input is **one packed integer** per player per tick: six button
bits, a pointer-active bit, and an 11+11-bit quantized pointer position — so
the co-op session's `===` prediction check and the JSON wire format both get
exactly comparable values, and mouse play stays deterministic in co-op.
