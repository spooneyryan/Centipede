# Rustipede — TypeScript

The Rust Centipede (`../Rust`) ported to TypeScript, pixel-perfect at its
native 1920×1080, and rebuilt on **GameBase** (`../../../GameBase/GameBase`)
so it picks up everything the framework offers:

| Feature | How |
|---|---|
| **Internet co-op** | `@ccllc/coop` — lockstep + rollback, two blasters on one field, nothing on the wire but inputs. The C# relay (`CCLLC.Coop.Relay`) is hosted by `server/Program.cs` at `/ws/mp`. |
| **Editable sprites** | Every drawable (mushroom, head, body, both blasters, bullet) can be redrawn in `@ccllc/studio`'s pixel/vector editor. Overrides persist on a library shelf; Reset returns the original procedural art. |
| **Editable sounds** | Every effect is a `SfxDefinition` synth document (Atari-2600-to-NES era), editable in the sound designer, exportable as WAV/JSON. |
| **Background music** | `platform/music` — three chiptune loops, assigned to levels in pairs and crossfaded. The module plays *files*; these are synthesised at boot and handed over as blob URLs, so the game still ships no audio assets. See below. |
| **Level editor** | Paint a mushroom field, keep it on a shelf, download it, share it as a `#level=…` link, playtest it solo, or host it as a co-op match. Undo via `core/history`, shortcuts via `editor/keymap`. |
| **Replays** | Deterministic ghosts: seed + inputs, a few KB. Save the last run (solo or co-op), watch it back, import/export as files. |
| **Fullscreen** | `platform/presentation` — DOM fullscreen in a browser, the real window under the Electron wrapper, windowed size remembered in settings. |
| **Settings** | `core/settings` — one schema, applied live: sound, volume, mouse control, grid, glow, skins, player name, telemetry opt-in. |
| **The full bestiary** | Spider, flea, scorpion and saucer alongside the centipede, poisoned mushrooms, and Apeiron-style power-up coins. See below. |
| **Game tuning** | 14 sliders in Settings — fire rate, shots on screen, bullet and blaster speed, the whole centipede speed curve, mushroom toughness and density, lives, extra-life threshold. See below. |
| **Skins** | The page chrome wears the skin contract's `--game-*` tokens. The canvas defaults to the original palette (pixel-perfect); pick a built-in skin, derive one from a hue, or import a skin file. |
| **Controller** | `platform/input` — keyboard and gamepad behind one action map (d-pad/left stick move, A/RT fire, Start starts, button 8 pauses, Y restarts). |
| **Telemetry** | `createTelemetry` — off by default, nothing identifying; every GameBase module reports into it (`loop.overrun`, `document.rejected`, …). Needs an endpoint configured in Settings. |
| **FPS counter** | `Show FPS` in Settings. It reads the same samples `core/perf` already collects to decide when to shed the glow, and reports the **render** rate — the simulation is 60 Hz and fixed. |
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

## Deploying

```powershell
./infra/provision.ps1 -Deploy
```

One idempotent command: resource group, App Service plan, web app, the
settings the defaults get wrong, build, publish, ship. `-WhatIf` shows the
plan and changes nothing. Live at <https://rustipede.azurewebsites.net>.

It has to be App Service rather than Static Web Apps: co-op needs the relay to
hold a WebSocket per player, and Static Web Apps back onto HTTP-triggered
Functions that cannot. The full write-up, including the three non-default
settings and the per-region quota trap, is in [infra/DEPLOY.md](infra/DEPLOY.md).

`azure-pipelines.yml` does the same build on every push to `main`. Because
GameBase is referenced by path, the pipeline checks out **two** repositories
and places them so those paths resolve untouched — the game at
`Games/Centipede/TypeScript`, GameBase at `GameBase/GameBase`, both under one
root. That layout was reproduced locally and every step passed.

It is green: the two-repository checkout, the typecheck, the determinism and
netcode proof (including the two-client co-op run) and both builds all pass on
a hosted Linux agent, against GameBase at the exact commit the game is
verified with.

GameBase is developed in a different Azure DevOps organisation, which a
build's own token cannot reach, so the pipeline reads a **mirror** of it
alongside this repo. That needs refreshing by hand — one command, in
[DEPLOY.md](infra/DEPLOY.md#refreshing-it) — and refreshing it runs the
checks against the new GameBase, which is the automatic version of the advice
above about re-running them after a pull. It cannot deploy: a run triggered by
another repository does not carry `refs/heads/main`. The one thing still
outstanding is an ARM service connection, which is a credential and so yours
to make.

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

## The bestiary, the coins, and the odd mushrooms

The 1981 original ships three enemies beyond the centipede, and each one exists
to punish a different habit:

| | What it does | Punishes |
|---|---|---|
| **Spider** | Bounces through your band at 45 degrees eating mushrooms; changes direction at random so it cannot be timed. Pays by range — the closer you let it get, the more it is worth (300/600/900) | camping |
| **Flea** | Drops straight down leaving a trail of mushrooms. Only comes when your band is running low on cover. Takes **two** hits — the first just speeds it up | clearing your band out |
| **Scorpion** | Crosses the middle poisoning every mushroom it touches. A centipede that walks into poison stops zig-zagging and **dives for the floor** | ignoring the field |
| **Saucer** | Apeiron's addition. Crosses high and flattens the field in its lane. Worth the most, and never slows down | — |

**Coins** are Apeiron's best idea, and they are here: they fall out of destroyed
mushrooms and dead bugs, bounce around, and **expire with a raspberry if you
leave them** — which is what keeps prising you out of the safe corner. Rapid
fire, curve gun (steer a shot in flight with left/right), shield, **ghost**
(you and your shots both pass through mushrooms), extra life, score
multiplier, and a padlock that carries your power-ups through one death. **In co-op whoever touches the coin gets it** — they are
per-player, so they are worth racing for.

**Mushrooms are solid.** They block the blaster as well as the centipede, so
the field you carve is also the maze you have to live in — you shoot your way
out of a corner rather than strolling through it. The blaster slides along a
wall rather than sticking to it, and if something plants a mushroom on top of
you (a flea can, and a shot segment becomes one where it died) you can always
walk out rather than being sealed in. The ghost coin suspends the rule, and
`Mushrooms block you` in Settings turns it off entirely.

From level 4, the field grows **odd mushrooms**: ones that come loose and fall
on you, ones that reflect your shots, and flashing ones that pay a multiplier.

All of it is tunable, and any of it can be switched off — setting a spawn
interval or the coin chance to 0 turns that thing off entirely, so you can dial
back to plain 1981 Centipede if you want it.


## The music

Three loops — a march, a faster chase, and a slow attract theme — live in
[src/music.ts](src/music.ts) as note data for a small tracker: a wave, a decay,
and a row of steps per part. They are rendered to WAV at boot with the sfx
module's own encoder and handed to GameBase as blob URLs.

That indirection is the point. `platform/music` plays **files**, which is right
for a game with recorded music and wrong for this one: the sound effects are
already synth documents rendered on the machine that plays them, and shipping
megabytes of MP3 to a client that is 370 kB would be a strange trade. Three
tracks cost **~40 ms** at startup and nothing on the wire.

Levels are mapped to tracks **in pairs** — 1-2 march, 3-4 chase, 5-6 march —
so `playFor(level)` at each level start crossfades on every other level and is
a no-op in between. A level retried after a death does not restart the music,
which is the behaviour that mapping buys you.

Two things the first render got wrong, both caught by decoding the buffers back
and measuring them rather than by listening:

- **The loop clicked.** The last sample met the first 0.5 of full scale away,
  every few seconds, forever. Four milliseconds of fade at each end pins both
  ends to zero — the seam now measures 0.
- **A third of the march was silence.** A rest cut off the note still ringing,
  because a decay longer than a step was being gated at the step boundary. A
  rest now lets the note ring; the track went from 69% audible to 100%.

Music is presentation, always. The state-to-track mapping is read in the render
path and is unreachable from `step()` — co-op rewinds several ticks a second,
and music that reacted inside the simulation would stutter on every one.

## The mouse

Clicking the playfield **captures the mouse**: the cursor disappears and the
physical mouse becomes the cabinet's trackball, read as relative motion.
Escape gives it back, and Escape means that before it means anything else — a
captured mouse can never cost you a co-op match.

The pointer the game steers by is *virtual*, and it is clamped by exactly what
clamps the blaster: the box at the bottom of the screen, and the mushrooms.
That clamp is the whole trick. Shove the mouse a foot past the edge of the box
and the pointer is still sitting on the edge, so the first millimetre back the
other way moves the blaster. Track the raw position instead and you would have
to wind that foot back before anything happened — and against a mushroom you
would eventually surface on the far side and warp through it.

Both use one shared sweep (`src/collide.ts`), so the pointer and the blaster
cannot disagree about where a wall is.

The cursor is tracked on the **window**, not on the canvas. A canvas-scoped
listener stops firing the moment the cursor leaves the element, so sliding off
the edge of the playfield froze the blaster wherever it stood — it read as the
game losing the mouse. Watching the window means the pointer keeps tracking
wherever the cursor goes, and the clamp maps it to the nearest legal spot: run
the cursor along under the playfield and the blaster still follows you left and
right.

Chrome is the exception. The editor and lobby panels are absolutely positioned
*inside* the stage, so they float over the right-hand third of the playfield
and a cursor on one is geometrically “inside the canvas” while pointing at
nothing of the sort. Panels and modals are asked about by hit target rather
than by rectangle, and they suppress pointer input the way `keyboardIsBusy`
already suppresses keys — otherwise scrolling the lobby would drag the blaster
underneath it, and dragging in the editor's own panel would paint the columns
it covers.

**Pausing gives the mouse back.** `P` or `Escape` pauses, and pausing releases
the pointer -- a captured mouse over a paused game is a cursor nobody can
reach. Either key resumes and takes it again. Escape is not optional here: the
browser releases a locked pointer on Escape whatever the page wants, so pausing
is simply the only behaviour that leaves the game coherent afterwards. (Leaving
a co-op match moved to the **Leave** button in the Co-op panel, because Escape
during a match now pauses it for both players.)

Re-grabbing can fail, and the game does not pretend otherwise. Pointer lock
needs a real user gesture -- which is why `P` is handled in the keydown
listener rather than through the action map, since polling that map inside
`requestAnimationFrame` is not a gesture -- and Chrome additionally refuses for
about a second after an Escape released the lock. A resume that cannot re-grab
falls back to the absolute cursor, which still works.

**Raw mouse input.** The pointer is taken with
`requestPointerLock({ unadjustedMovement: true })`, which asks the platform for
deltas with no pointer ballistics and no OS acceleration curve, so the same
physical sweep always moves the blaster the same distance whether you flick it
or ease it. Chrome and Edge implement it; Safari rejects the promise and older
builds throw on being handed an argument at all, and both fall back to a plain
grab. `Raw mouse` in Settings turns it off to compare.

Motion is read from `pointermove` and its **coalesced** samples rather than
`mousemove`. A 1000 Hz mouse produces about eight samples between two frames of
a 120 Hz display, and the browser merges them into one event whose movement is
their sum. For a pointer that only had to end up somewhere that is identical --
but this pointer is swept against the mushrooms on the way, and one long sweep
rounds corners that eight short ones catch on.

None of that changes the frame rate, and none of it can. **The simulation is
60 Hz and fixed**: every input is stamped to a tick, and two machines agree
because they agree on that. A 120 Hz display already draws 120 frames of those
60 ticks, because the loop is variable-delta and only the simulation is
stepped. What raw input and coalescing buy is fidelity within a tick, not more
ticks.

**Pointer lock needs a real browser.** Embedded webviews often block it by
Permissions Policy (Claude Code's preview pane does), and the game falls back
to plain absolute cursor tracking there. Control is kept either way; what lock
adds is that overshooting an axis no longer costs you anything on the way back,
because a captured cursor cannot overshoot in the first place.

## Tuning the game

Everything that changes how the game *feels* lives in [src/tuning.ts](src/tuning.ts)
as one `Tuning` value with one `TUNING_FIELDS` table beside it. The settings
schema, the sanitizer, and the sliders in the Settings dialog are all generated
from that table, so a range cannot drift between what the UI offers and what
the game accepts. Most defaults are the original constants, imported from
`config.ts` so the two cannot drift. Six are deliberately not, and they are
marked `TUNED` with the original value beside them: one shot on screen (the
1981 cabinet's rule, where the Rust port allowed two), a slower level-1
centipede that ramps more gently, fleas every 7s, and coins that are rare
(2.3%) and short-lived (5s) rather than common and lingering.

`config.ts` keeps the **structural** constants (the 48x27 grid, the cell size,
the row limits). Those are not tunable: the renderer and the level format are
built around them.

Three rules make this safe against the netcode:

- **A tuning is frozen into a run when it starts.** `Game` takes one at
  construction and reads it from there forever. Moving a slider mid-game does
  nothing to the game in progress — which is the point, because in co-op the
  alternative is two machines silently disagreeing about the rules.
- **In co-op the host's tuning wins.** It rides in the match payload and the
  joiner's own sliders are ignored for the duration, exactly as the level
  layout already worked. The lobby says so before you host.
- **A mismatch fails loudly.** The tuning is folded into the simulation
  fingerprint, so two machines running different rules trip the desync alarm on
  the first settled tick rather than drifting apart quietly.

Replays carry their tuning too — a run recorded with a slow bullet replays with
a slow bullet.

`npm run check` proves each of the 14 knobs actually moves the simulation: a
control wired to nothing is worse than no control at all.

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
  music.ts       three chiptune loops, synthesised to WAV and played per level
  sprites.ts     the editable sprite overrides
  levels.ts      the level document format + shelf
  tuning.ts      the 14 tunables, their ranges, and the sanitizer
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
