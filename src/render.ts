// The renderer: a pixel-perfect port of the drawing code from the Rust
// version's web/index.html, drawing straight from simulation state.
//
// Everything here is presentation. It may use `Math.sin`, wall-clock time and
// per-machine settings freely — none of it feeds back into the simulation.
//
// Three GameBase extensions over the original, all defaulting off:
//  - a skinned mode that recolours the canvas from the active skin's
//    `canvas.*` tokens (the default "classic" look keeps the original palette
//    exactly);
//  - user-drawn sprite overrides (SpriteAsset documents from the studio
//    editors) rendered with `drawSpriteAsset`;
//  - a glow toggle, so the performance monitor can shed the shadowBlur cost
//    when a machine falls behind.

import type { CanvasColors } from "@ccllc/arcade/skin";
import type { SpriteAsset } from "@ccllc/arcade/shmup";
import { drawSpriteAsset } from "@ccllc/studio/render";
import { BULLET_LEN, CELL, COLS, HEIGHT, PLAYER_SIZE, WIDTH } from "./config";
import {
  Game,
  STATE_ATTRACT,
  STATE_DYING,
  STATE_GAME_OVER,
  STATE_LEVEL_CLEAR,
  STATE_PLAYING,
} from "./sim";

// Mushroom colour by remaining hit points (index 0 unused) — the original
// palette, verbatim.
const CAP = [null, "#6d7f99", "#c9b73f", "#dd7a3c", "#e2497e"] as const;
const STEM = [null, "#41506a", "#8e8130", "#9b5730", "#9c3459"] as const;

export type SpriteSlot = "mushroom" | "head" | "body" | "player" | "player2" | "bullet";

export const SPRITE_SLOTS: SpriteSlot[] = ["mushroom", "head", "body", "player", "player2", "bullet"];

export interface OverlayText {
  subtitle: string;
  startLine: string;
  againLine: string;
}

export interface RenderOptions {
  /** Canvas colours from the active skin, or null for the original palette. */
  colors: CanvasColors | null;
  /** User-drawn sprite overrides, by slot. */
  sprites: Partial<Record<SpriteSlot, SpriteAsset>>;
  glow: boolean;
  grid: boolean;
  /** Presentation clock in seconds — legs scuttle and prompts blink on it. */
  clock: number;
  paused: boolean;
  overlay: OverlayText;
  /** Which seat this machine is, marking "your" blaster in co-op. -1 outside
   * co-op, where "which one is mine" has no meaning. */
  localSeat: number;
}

const SEAT_COLORS = ["#4fd6ff", "#ffd447"] as const;
const SEAT_TRIM = ["#e9fbff", "#fff3c4"] as const;

export class Renderer {
  constructor(private ctx: CanvasRenderingContext2D) {}

  frame(game: Game, o: RenderOptions): void {
    const ctx = this.ctx;
    const w = WIDTH;
    const h = HEIGHT;

    this.drawBackground(w, h, CELL, o);

    for (const [col, row, hp] of game.field.iter()) {
      const x = (col + 0.5) * CELL;
      const y = (row + 0.5) * CELL;
      this.drawMushroom(x, y, CELL, hp, o);
    }

    for (const train of game.trains) {
      for (let i = 0; i < train.segments.length; i++) {
        const seg = train.segments[i];
        const [x, y] = seg.position(train.t);
        this.drawSegment(x, y, CELL, i === 0, seg.dirX, i, o);
      }
    }

    for (const bullet of game.bullets) {
      this.drawBullet(bullet.x, bullet.y, BULLET_LEN, o);
    }

    if (game.state === STATE_PLAYING) {
      for (let i = 0; i < game.slots.length; i++) {
        this.drawPlayer(game.slots[i].player.x, game.slots[i].player.y, PLAYER_SIZE, i, o, i === o.localSeat);
      }
    }

    this.drawHud(game, w, CELL, o);
    this.drawOverlay(game, w, h, o);

    if (o.paused) {
      ctx.fillStyle = "rgba(3, 5, 9, 0.7)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = o.colors ? o.colors.ink : "#cfe3ff";
      ctx.font = "700 110px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("PAUSED", w / 2, h / 2);
    }
  }

  /** The level editor's view: background, grid, and a designed field, plus a
   * brush cursor. Same drawing code as play, so the editor is WYSIWYG. */
  drawField(
    cells: ArrayLike<number>,
    cursor: { col: number; row: number; hp: number } | null,
    o: RenderOptions,
  ): void {
    const ctx = this.ctx;
    this.drawBackground(WIDTH, HEIGHT, CELL, o);
    for (let i = 0; i < cells.length; i++) {
      const hp = cells[i];
      if (hp > 0) {
        const col = i % COLS;
        const row = Math.floor(i / COLS);
        this.drawMushroom((col + 0.5) * CELL, (row + 0.5) * CELL, CELL, hp, o);
      }
    }
    if (cursor) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      if (cursor.hp > 0) {
        this.drawMushroom((cursor.col + 0.5) * CELL, (cursor.row + 0.5) * CELL, CELL, cursor.hp, o);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = cursor.hp > 0 ? "#57d977" : "#ff6a8a";
      ctx.lineWidth = 2;
      ctx.strokeRect(cursor.col * CELL + 1, cursor.row * CELL + 1, CELL - 2, CELL - 2);
      ctx.restore();
    }
  }

  private drawBackground(w: number, h: number, cell: number, o: RenderOptions): void {
    const ctx = this.ctx;
    if (o.colors) {
      ctx.fillStyle = o.colors.ground;
      ctx.fillRect(0, 0, w, h);
    } else {
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#080b14");
      sky.addColorStop(1, "#04060a");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);
    }

    if (o.grid) {
      ctx.strokeStyle = o.colors ? o.colors.grid : "rgba(120, 170, 220, 0.035)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = cell; x < w; x += cell) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      for (let y = cell; y < h; y += cell) {
        ctx.moveTo(0, y + 0.5);
        ctx.lineTo(w, y + 0.5);
      }
      ctx.stroke();
    }

    // The line the player cannot cross.
    const boxTop = h - cell * 5;
    ctx.strokeStyle = o.colors ? o.colors.dim : "rgba(87, 217, 119, 0.16)";
    ctx.setLineDash([12, 14]);
    ctx.beginPath();
    ctx.moveTo(0, boxTop);
    ctx.lineTo(w, boxTop);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawMushroom(x: number, y: number, size: number, hp: number, o: RenderOptions): void {
    const custom = o.sprites.mushroom;
    if (custom) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(x, y);
      // Damage reads as fading when the art is user-drawn.
      ctx.globalAlpha = 0.4 + (Math.min(hp, 4) / 4) * 0.6;
      drawSpriteAsset(ctx, custom, size * 0.9);
      ctx.restore();
      return;
    }

    const ctx = this.ctx;
    const r = size * 0.36;
    const capColour = o.colors ? o.colors.alt : (CAP[hp] ?? CAP[4]!);
    const stemColour = o.colors ? o.colors.dim : (STEM[hp] ?? STEM[4]!);

    ctx.fillStyle = stemColour;
    ctx.fillRect(x - r * 0.34, y - r * 0.1, r * 0.68, r * 1.05);

    ctx.fillStyle = capColour;
    ctx.beginPath();
    ctx.arc(x, y - r * 0.1, r, Math.PI, 0);
    ctx.lineTo(x + r, y - r * 0.1);
    ctx.lineTo(x - r, y - r * 0.1);
    ctx.closePath();
    ctx.fill();

    // Spots fall off as the mushroom is chipped away.
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    const spots = [
      [-0.42, -0.42],
      [0.36, -0.5],
      [0.0, -0.72],
    ] as const;
    for (let i = 0; i < hp - 1 && i < spots.length; i++) {
      ctx.beginPath();
      ctx.arc(x + spots[i][0] * r, y + spots[i][1] * r, r * 0.15, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawSegment(
    x: number,
    y: number,
    size: number,
    isHead: boolean,
    dirX: number,
    index: number,
    o: RenderOptions,
  ): void {
    const custom = isHead ? o.sprites.head : o.sprites.body;
    const ctx = this.ctx;
    if (custom) {
      ctx.save();
      ctx.translate(x, y);
      if ((dirX || 1) < 0) ctx.scale(-1, 1);
      drawSpriteAsset(ctx, custom, size * 0.9);
      ctx.restore();
      return;
    }

    const r = size * 0.4;
    const t = o.clock;

    // Legs scuttle; the phase offset per segment makes the wave run down the body.
    ctx.strokeStyle = isHead
      ? o.colors
        ? o.colors.danger
        : "#c9a52c"
      : o.colors
        ? o.colors.accent
        : "#2f8a4b";
    ctx.lineWidth = Math.max(2, size * 0.07);
    ctx.lineCap = "round";
    const wave = Math.sin(t * 16 + index * 0.9) * r * 0.28;
    ctx.beginPath();
    for (const side of [-1, 1]) {
      ctx.moveTo(x + side * r * 0.7, y - r * 0.15);
      ctx.lineTo(x + side * r * 1.25, y + r * 0.5 + wave * side);
    }
    ctx.stroke();

    const body = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    if (o.colors) {
      const base = isHead ? o.colors.danger : o.colors.accent;
      body.addColorStop(0, o.colors.accentBright);
      body.addColorStop(1, base);
    } else if (isHead) {
      body.addColorStop(0, "#ffe89a");
      body.addColorStop(1, "#e0a91f");
    } else {
      body.addColorStop(0, "#9dffb6");
      body.addColorStop(1, "#3aa85c");
    }
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = isHead ? "rgba(120,80,0,0.6)" : "rgba(10,60,25,0.65)";
    ctx.lineWidth = Math.max(1.5, size * 0.05);
    ctx.stroke();

    if (isHead) {
      ctx.fillStyle = "#160f00";
      const dx = (dirX || 1) * r * 0.34;
      for (const oy of [-r * 0.22, r * 0.22]) {
        ctx.beginPath();
        ctx.arc(x + dx, y + oy, r * 0.15, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /** `isLocal` marks this machine's own blaster in co-op. It is passed
   * explicitly rather than derived from `o.localSeat` inside here, because the
   * HUD life icons draw through this same helper as seat 0 and must never
   * light up. */
  private drawPlayer(
    x: number,
    y: number,
    size: number,
    seat: number,
    o: RenderOptions,
    isLocal = false,
  ): void {
    const custom = seat === 1 ? (o.sprites.player2 ?? o.sprites.player) : o.sprites.player;
    const ctx = this.ctx;
    if (custom) {
      ctx.save();
      ctx.translate(x, y);
      drawSpriteAsset(ctx, custom, size);
      ctx.restore();
      if (isLocal) this.markLocal(x, y, size);
      return;
    }

    const r = size * 0.5;
    const hull = o.colors && seat === 0 ? o.colors.accentBright : SEAT_COLORS[seat] ?? SEAT_COLORS[0];
    const trim = SEAT_TRIM[seat] ?? SEAT_TRIM[0];
    ctx.save();
    if (o.glow) {
      ctx.shadowColor = seat === 1 ? "rgba(255, 212, 71, 0.7)" : "rgba(79, 214, 255, 0.7)";
      ctx.shadowBlur = size * 0.5;
    }

    ctx.fillStyle = hull;
    ctx.beginPath();
    ctx.moveTo(x, y - r);
    ctx.lineTo(x + r * 0.85, y + r * 0.7);
    ctx.lineTo(x, y + r * 0.3);
    ctx.lineTo(x - r * 0.85, y + r * 0.7);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = trim;
    ctx.fillRect(x - r * 0.14, y - r * 0.85, r * 0.28, r * 0.9);
    ctx.restore();

    if (isLocal) this.markLocal(x, y, size);
  }

  /** A small chevron under this machine's own blaster. Colour alone would not
   * carry it — both players draw both hulls identically, and it has to read
   * for a colour-blind player too. */
  private markLocal(x: number, y: number, size: number): void {
    const ctx = this.ctx;
    const r = size * 0.5;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = Math.max(2, size * 0.06);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - r * 0.36, y + r * 0.95);
    ctx.lineTo(x, y + r * 1.28);
    ctx.lineTo(x + r * 0.36, y + r * 0.95);
    ctx.stroke();
    ctx.restore();
  }

  private drawBullet(x: number, y: number, size: number, o: RenderOptions): void {
    const custom = o.sprites.bullet;
    const ctx = this.ctx;
    if (custom) {
      ctx.save();
      ctx.translate(x, y);
      drawSpriteAsset(ctx, custom, size * 2);
      ctx.restore();
      return;
    }

    ctx.save();
    if (o.glow) {
      ctx.shadowColor = "#ffe680";
      ctx.shadowBlur = size;
    }
    ctx.fillStyle = o.colors ? o.colors.ink : "#fffbe8";
    ctx.fillRect(x - size * 0.16, y - size, size * 0.32, size * 2);
    ctx.restore();
  }

  private drawHud(game: Game, w: number, cell: number, o: RenderOptions): void {
    const ctx = this.ctx;
    ctx.font = `600 ${cell * 0.75}px ui-monospace, monospace`;
    ctx.textBaseline = "middle";

    ctx.fillStyle = o.colors ? o.colors.ink : "#cfe3ff";
    ctx.textAlign = "left";
    ctx.fillText(String(game.score).padStart(6, "0"), cell * 0.6, cell * 0.55);

    ctx.fillStyle = o.colors ? o.colors.dim : "#6b7c96";
    ctx.textAlign = "center";
    ctx.fillText(`HI ${String(game.highScore).padStart(6, "0")}`, w * 0.5, cell * 0.55);

    ctx.textAlign = "right";
    ctx.fillText(`LEVEL ${game.level}`, w - cell * 0.6, cell * 0.55);

    // Remaining lives, as little blasters.
    for (let i = 0; i < Math.min(game.lives, 8); i++) {
      this.drawPlayer(cell * 6.2 + i * cell, cell * 0.55, cell * 0.6, 0, o);
    }
  }

  private drawOverlay(game: Game, w: number, h: number, o: RenderOptions): void {
    const state = game.state;
    if (state === STATE_PLAYING) return;

    const ctx = this.ctx;
    ctx.fillStyle = "rgba(3, 5, 9, 0.72)";
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const title = (text: string, colour: string, y: number, size: number): void => {
      ctx.fillStyle = colour;
      ctx.font = `700 ${size}px ui-monospace, monospace`;
      ctx.fillText(text, w / 2, y);
    };

    const ink = o.colors ? o.colors.ink : "#cfe3ff";
    const dim = o.colors ? o.colors.dim : "#6b7c96";
    const accent = o.colors ? o.colors.accent : "#57d977";
    const danger = o.colors ? o.colors.danger : "#ff6a8a";
    const blink = Math.floor(o.clock * 1.6) % 2 === 0;

    if (state === STATE_ATTRACT) {
      title("CENTIPEDE", accent, h * 0.36, 150);
      title(o.overlay.subtitle, dim, h * 0.47, 34);
      if (blink) {
        title(o.overlay.startLine, ink, h * 0.6, 46);
      }
      title("Mouse or arrows / WASD to move  ·  Click or SPACE to fire", "#4a5a72", h * 0.7, 30);
    } else if (state === STATE_DYING) {
      title("HIT!", danger, h * 0.45, 110);
    } else if (state === STATE_LEVEL_CLEAR) {
      title(`LEVEL ${game.level} CLEARED`, "#ffd447", h * 0.44, 96);
      title("Mushrooms restored", dim, h * 0.54, 34);
    } else if (state === STATE_GAME_OVER) {
      title("GAME OVER", danger, h * 0.38, 130);
      title(`SCORE ${game.score}`, ink, h * 0.5, 56);
      if (blink) {
        title(o.overlay.againLine, ink, h * 0.62, 42);
      }
    }
  }
}
