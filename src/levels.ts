// Level documents: a designed mushroom field, with the versioned envelope,
// refusal of foreign/future files, downloads and base64url share links all
// supplied by GameBase's document format — and a library shelf to keep them on.

import {
  boundedInteger,
  boundedString,
  defineFormat,
  defineLibrary,
  type DocumentFormat,
  type Library,
  type ReportSink,
} from "@ccllc/arcade/core";
import { COLS, ROWS, SHROOM_HP } from "./config";

export interface LevelDoc {
  format: string;
  version: number;
  savedAt: string;
  name: string;
  /** Level number the run begins on; the wave and speeds scale from it. */
  startLevel: number;
  /** COLS*ROWS mushroom hit points, row-major, 0..SHROOM_HP. */
  cells: number[];
}

export interface LevelStore {
  format: DocumentFormat<LevelDoc>;
  library: Library<LevelDoc>;
}

export function createLevelStore(options: { report?: ReportSink } = {}): LevelStore {
  const format = defineFormat<LevelDoc>({
    format: "rustipede-level",
    version: 1,
    sanitize: (raw) => {
      const source = Array.isArray(raw?.cells) ? (raw.cells as unknown[]) : [];
      const cells = new Array<number>(COLS * ROWS).fill(0);
      for (let i = 0; i < cells.length; i++) {
        cells[i] = boundedInteger(source[i], 0, 0, SHROOM_HP);
      }
      // Row 0 is the HUD; nothing may grow there.
      for (let col = 0; col < COLS; col++) cells[col] = 0;
      return {
        name: boundedString(raw?.name, "Untitled field", 48),
        startLevel: boundedInteger(raw?.startLevel, 1, 1, 50),
        cells,
      };
    },
    report: options.report,
  });

  const library = defineLibrary({
    format,
    key: "rustipede.levels.v1",
    draftKey: "rustipede.levels.draft.v1",
    limit: 30,
    report: options.report,
  });

  return { format, library };
}
