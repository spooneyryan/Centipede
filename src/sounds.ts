// Sound: every effect in the game is a designed SfxDefinition document —
// GameBase's deterministic synth renders the same samples on every machine —
// and every one of them is editable in the SfxStudio designer and persisted in
// a document library. Sounds fire by diffing the simulation's event counters
// once per rendered frame, so a rolled-back tick can never play twice.

import { defineFormat, type DocumentFormat, type ReportSink } from "@ccllc/arcade/core";
import { defineLibrary, type Library } from "@ccllc/arcade/core";
import {
  createSfxPlayer,
  createSfxPreset,
  normalizeSfx,
  type SfxDefinition,
  type SfxPlayer,
} from "@ccllc/arcade/sfx";
import type { Game, GameEvents } from "./sim";

export type SoundSlot =
  | "shoot"
  | "mushroomHit"
  | "mushroomKill"
  | "bodyKill"
  | "headKill"
  | "death"
  | "levelClear"
  | "extraLife"
  | "start"
  | "spiderKill"
  | "fleaKill"
  | "scorpionKill"
  | "saucerKill"
  | "coinDrop"
  | "coinPickup"
  | "coinMiss"
  | "shieldSave"
  | "bonusShroom";

export const SOUND_SLOTS: { slot: SoundSlot; label: string }[] = [
  { slot: "shoot", label: "Shoot" },
  { slot: "mushroomHit", label: "Mushroom chipped" },
  { slot: "mushroomKill", label: "Mushroom destroyed" },
  { slot: "bodyKill", label: "Segment hit" },
  { slot: "headKill", label: "Head hit" },
  { slot: "death", label: "Blaster lost" },
  { slot: "levelClear", label: "Level cleared" },
  { slot: "extraLife", label: "Extra life" },
  { slot: "start", label: "Game start" },
  { slot: "spiderKill", label: "Spider destroyed" },
  { slot: "fleaKill", label: "Flea destroyed" },
  { slot: "scorpionKill", label: "Scorpion destroyed" },
  { slot: "saucerKill", label: "Saucer destroyed" },
  { slot: "coinDrop", label: "Coin appears" },
  { slot: "coinPickup", label: "Coin collected" },
  { slot: "coinMiss", label: "Coin lost" },
  { slot: "shieldSave", label: "Shield absorbs a hit" },
  { slot: "bonusShroom", label: "Bonus mushroom" },
];

/** The stock soundtrack: presets from the synth, nudged to fit the game. */
export function defaultSound(slot: SoundSlot): SfxDefinition {
  switch (slot) {
    case "shoot":
      return normalizeSfx({
        ...createSfxPreset("Laser"),
        name: "Shoot",
        frequency: 1240,
        slide: -6,
        sustain: 0.02,
        decay: 0.09,
        volume: 0.3,
      });
    case "mushroomHit":
      return normalizeSfx({ ...createSfxPreset("Blip"), name: "Mushroom chipped", frequency: 320, volume: 0.32 });
    case "mushroomKill":
      return normalizeSfx({ ...createSfxPreset("Hit"), name: "Mushroom destroyed", frequency: 220, volume: 0.4 });
    case "bodyKill":
      return normalizeSfx({ ...createSfxPreset("Hit"), name: "Segment hit", frequency: 480, decay: 0.16, volume: 0.42 });
    case "headKill":
      return normalizeSfx({
        ...createSfxPreset("Explosion"),
        name: "Head hit",
        decay: 0.35,
        volume: 0.5,
      });
    case "death":
      return normalizeSfx({ ...createSfxPreset("Explosion"), name: "Blaster lost", decay: 0.9, volume: 0.55 });
    case "levelClear":
      return normalizeSfx({ ...createSfxPreset("Powerup"), name: "Level cleared", volume: 0.45 });
    case "extraLife":
      return normalizeSfx({ ...createSfxPreset("Coin"), name: "Extra life", volume: 0.5 });
    case "start":
      return normalizeSfx({ ...createSfxPreset("Coin"), name: "Game start", frequency: 660, volume: 0.4 });
    case "spiderKill":
      return normalizeSfx({ ...createSfxPreset("Hit"), name: "Spider destroyed", frequency: 300, decay: 0.22, volume: 0.45 });
    case "fleaKill":
      return normalizeSfx({ ...createSfxPreset("Hit"), name: "Flea destroyed", frequency: 720, decay: 0.14, volume: 0.4 });
    case "scorpionKill":
      return normalizeSfx({ ...createSfxPreset("Explosion"), name: "Scorpion destroyed", decay: 0.3, volume: 0.48 });
    case "saucerKill":
      return normalizeSfx({ ...createSfxPreset("Powerup"), name: "Saucer destroyed", frequency: 900, volume: 0.5 });
    case "coinDrop":
      return normalizeSfx({ ...createSfxPreset("Blip"), name: "Coin appears", frequency: 1100, volume: 0.26 });
    case "coinPickup":
      return normalizeSfx({ ...createSfxPreset("Coin"), name: "Coin collected", frequency: 880, volume: 0.5 });
    // A falling raspberry: the coin you did not go and get.
    case "coinMiss":
      return normalizeSfx({
        ...createSfxPreset("Buzzer"),
        name: "Coin lost",
        frequency: 260,
        slide: -2.2,
        sustain: 0.03,
        decay: 0.22,
        volume: 0.3,
      });
    case "shieldSave":
      return normalizeSfx({ ...createSfxPreset("Powerup"), name: "Shield absorbs a hit", frequency: 520, volume: 0.5 });
    case "bonusShroom":
      return normalizeSfx({ ...createSfxPreset("Coin"), name: "Bonus mushroom", frequency: 1320, volume: 0.5 });
  }
}

interface SoundDoc {
  format: string;
  version: number;
  savedAt: string;
  name: string;
  sound: SfxDefinition;
}

export interface SoundBank {
  player: SfxPlayer;
  format: DocumentFormat<SoundDoc>;
  get(slot: SoundSlot): SfxDefinition;
  isCustom(slot: SoundSlot): boolean;
  setCustom(slot: SoundSlot, sound: SfxDefinition): void;
  reset(slot: SoundSlot): void;
  play(slot: SoundSlot): void;
  /** Diff the sim's event counters against what has been heard and voice the
   * difference. Call once per rendered frame. */
  hear(game: Game): void;
  /** Forget what has been heard — call when a new run or replay begins so the
   * counters of a fresh game do not read as a burst of events. */
  resync(game: Game | null): void;
  destroy(): void;
}

const EVENT_TO_SLOT: [keyof GameEvents, SoundSlot][] = [
  ["shots", "shoot"],
  ["mushroomHits", "mushroomHit"],
  ["mushroomKills", "mushroomKill"],
  ["bodyKills", "bodyKill"],
  ["headKills", "headKill"],
  ["deaths", "death"],
  ["levelClears", "levelClear"],
  ["extraLives", "extraLife"],
  ["starts", "start"],
  ["spiderKills", "spiderKill"],
  ["fleaKills", "fleaKill"],
  ["scorpionKills", "scorpionKill"],
  ["saucerKills", "saucerKill"],
  ["coinDrops", "coinDrop"],
  ["coinPickups", "coinPickup"],
  ["coinMisses", "coinMiss"],
  ["shieldSaves", "shieldSave"],
  ["bonusShrooms", "bonusShroom"],
];

export function createSoundBank(options: { report?: ReportSink } = {}): SoundBank {
  const format = defineFormat<SoundDoc>({
    format: "rustipede-sound",
    version: 1,
    sanitize: (raw) => ({
      name: typeof raw?.name === "string" ? raw.name.slice(0, 64) : "Sound",
      sound: normalizeSfx(raw?.sound),
    }),
    report: options.report,
  });

  const library: Library<SoundDoc> = defineLibrary({
    format,
    key: "rustipede.sounds.v1",
    limit: 30,
    report: options.report,
  });

  const player = createSfxPlayer();
  const custom = new Map<SoundSlot, SfxDefinition>();
  for (const { slot } of SOUND_SLOTS) {
    const doc = library.readByName(slot);
    if (doc) custom.set(slot, normalizeSfx(doc.sound));
  }

  const heard: Partial<Record<keyof GameEvents, number>> = {};

  const bank: SoundBank = {
    player,
    format,
    get: (slot) => custom.get(slot) ?? defaultSound(slot),
    isCustom: (slot) => custom.has(slot),
    setCustom: (slot, sound) => {
      const clean = normalizeSfx(sound);
      custom.set(slot, clean);
      library.save(format.create({ name: slot, sound: clean } as Partial<SoundDoc>), { name: slot });
    },
    reset: (slot) => {
      custom.delete(slot);
      const entry = library.list().find((e) => e.name.toLowerCase() === slot.toLowerCase());
      if (entry) library.remove(entry.id);
    },
    play: (slot) => {
      player.play(bank.get(slot));
    },
    hear: (game) => {
      for (const [key, slot] of EVENT_TO_SLOT) {
        const current = game.events[key];
        const before = heard[key] ?? current;
        if (current > before) {
          // Voice it once however many landed this frame; a burst of identical
          // sounds in one frame just clips.
          bank.play(slot);
        }
        heard[key] = current;
      }
    },
    resync: (game) => {
      for (const [key] of EVENT_TO_SLOT) {
        heard[key] = game ? game.events[key] : 0;
      }
    },
    destroy: () => player.destroy(),
  };

  return bank;
}
