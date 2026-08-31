// Local declarations for @ccllc/studio. At build time Vite bundles the real
// studio SOURCE (see the aliases in vite.config.ts); these declarations keep
// the studio's .tsx files out of this project's typecheck program, where our
// stricter compiler settings — and the upstream SFX_FIELD_LIST bug that our
// Vite plugin patches — would fail the build. Shapes match
// packages/studio/src/{types.ts,SfxStudio.tsx,image.ts,render.ts} at v2.0.9.
//
// The cost of the shim, paid here rather than discovered: it is a copy, so
// it goes stale silently. `blankImageAsset` and the `image` sprite kind
// existed upstream and did not exist here, and the symptom was a member
// this file had never heard of rather than anything pointing at this file.

declare module "@ccllc/studio" {
  import type { ReactElement } from "react";
  import type { SfxDefinition } from "@ccllc/arcade/sfx";
  import type { ImageSpriteAsset, SpriteAsset } from "@ccllc/arcade/shmup";

  export interface StudioProps {
    asset: SpriteAsset;
    onSave: (asset: SpriteAsset) => void;
    onCancel: () => void;
  }

  export function SpriteStudio(props: StudioProps): ReactElement | null;

  export function SfxStudio(props: {
    sound: SfxDefinition;
    onApply: (sound: SfxDefinition) => void;
    onCancel: () => void;
  }): ReactElement | null;

  export function BulletPatternStudio(props: {
    pattern: unknown;
    onApply: (pattern: unknown) => void;
    onSaveComponent: (pattern: unknown) => void;
    onCancel: () => void;
  }): ReactElement | null;

  export const makeId: () => string;

  /**
   * A new, empty full-resolution image asset. An image asset is defined by
   * carrying real bytes, so this returns one holding a transparent PNG —
   * an asset with an empty `data` is dropped by normalizeAssets.
   */
  export function blankImageAsset(
    id: string,
    name?: string,
    width?: number,
    height?: number,
  ): ImageSpriteAsset;
}

declare module "@ccllc/studio/render" {
  import type { RasterSpriteAsset, SpriteAsset, VectorShape } from "@ccllc/arcade/shmup";

  export function drawChecker(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    cell?: number,
    dark?: string,
    light?: string,
  ): void;

  export interface DrawVectorShapeOptions {
    scaleX?: number;
    scaleY?: number;
  }

  export function drawVectorShape(
    context: CanvasRenderingContext2D,
    shape: VectorShape,
    options?: DrawVectorShapeOptions,
  ): void;

  export function rasterAssetCanvas(
    asset: RasterSpriteAsset,
    createCanvas?: () => HTMLCanvasElement,
  ): HTMLCanvasElement;

  /** Draw ANY kind of asset — pixel grid, image or vector — centred on the
   * current origin, fitted inside a square of `extent` units on its longest
   * side. An `image` draws nothing until its data URL has decoded. */
  export function drawSpriteAsset(
    context: CanvasRenderingContext2D,
    asset: SpriteAsset,
    extent: number,
  ): void;
}

declare module "@ccllc/studio/styles.css";
