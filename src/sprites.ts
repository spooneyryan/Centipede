// Editable sprites: every drawable in the game can be replaced by a
// user-drawn SpriteAsset document (raster pixel art or vector shapes),
// authored in the studio's SpriteStudio and persisted in a document library.
// The renderer falls back to the original procedural drawing for any slot
// without an override, which is what keeps the default look pixel-perfect.

import { defineFormat, type DocumentFormat, type ReportSink } from "@ccllc/arcade/core";
import { defineLibrary, type Library } from "@ccllc/arcade/core";
import { normalizeAssets, type SpriteAsset } from "@ccllc/arcade/shmup";
import type { SpriteSlot } from "./render";
import { SPRITE_SLOTS } from "./render";

export const SPRITE_SLOT_LABELS: Record<SpriteSlot, string> = {
  mushroom: "Mushroom",
  head: "Centipede head",
  body: "Centipede body",
  player: "Blaster (P1)",
  player2: "Blaster (P2)",
  bullet: "Bullet",
  spider: "Spider",
  flea: "Flea",
  scorpion: "Scorpion",
  saucer: "Saucer",
  coin: "Power-up coin",
};

interface SpriteDoc {
  format: string;
  version: number;
  savedAt: string;
  name: string;
  asset: SpriteAsset;
}

export interface SpriteBank {
  format: DocumentFormat<SpriteDoc>;
  /** The current override, or null when the slot draws procedurally. */
  get(slot: SpriteSlot): SpriteAsset | null;
  /** Everything at once, in the shape the renderer takes. */
  overrides(): Partial<Record<SpriteSlot, SpriteAsset>>;
  set(slot: SpriteSlot, asset: SpriteAsset): void;
  reset(slot: SpriteSlot): void;
  /** A fresh 16x16 raster canvas to start drawing a slot from. */
  blank(slot: SpriteSlot): SpriteAsset;
}

export function createSpriteBank(options: { report?: ReportSink } = {}): SpriteBank {
  const format = defineFormat<SpriteDoc>({
    format: "rustipede-sprite",
    version: 1,
    sanitize: (raw) => {
      const assets = normalizeAssets([raw?.asset]);
      if (assets.length === 0) throw new Error("Not a sprite document.");
      return {
        name: typeof raw?.name === "string" ? raw.name.slice(0, 64) : "Sprite",
        asset: assets[0],
      };
    },
    report: options.report,
  });

  const library: Library<SpriteDoc> = defineLibrary({
    format,
    key: "rustipede.sprites.v1",
    limit: 30,
    report: options.report,
  });

  const overrides = new Map<SpriteSlot, SpriteAsset>();
  for (const slot of SPRITE_SLOTS) {
    const doc = library.readByName(slot);
    if (doc) overrides.set(slot, doc.asset);
  }

  let cached: Partial<Record<SpriteSlot, SpriteAsset>> | null = null;
  const rebuild = () => {
    cached = null;
  };

  return {
    format,
    get: (slot) => overrides.get(slot) ?? null,
    overrides: () => {
      if (!cached) {
        cached = {};
        for (const [slot, asset] of overrides) cached[slot] = asset;
      }
      return cached;
    },
    set: (slot, asset) => {
      // Normalize on the way in — the studio hands back sane documents, but an
      // imported file may not be one.
      const clean = normalizeAssets([asset])[0];
      if (!clean) return;
      overrides.set(slot, clean);
      library.save(format.create({ name: slot, asset: clean } as Partial<SpriteDoc>), { name: slot });
      rebuild();
    },
    reset: (slot) => {
      overrides.delete(slot);
      const entry = library.list().find((e) => e.name.toLowerCase() === slot.toLowerCase());
      if (entry) library.remove(entry.id);
      rebuild();
    },
    blank: (slot) => ({
      id: `sprite-${slot}-${Date.now().toString(36)}`,
      name: SPRITE_SLOT_LABELS[slot],
      kind: "raster",
      width: 16,
      height: 16,
      pixels: Array(256).fill(""),
    }),
  };
}
