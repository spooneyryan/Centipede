// The centipede level editor: paint a mushroom field, keep it on a library
// shelf, share it as a link or a file, playtest it solo, or host it as a
// co-op match. Built on GameBase's editor toolkit — `createKeymap` for the
// shortcut table (which also renders the help line), `createHistory` for
// undo/redo with gesture coalescing — plus the document format and library
// from levels.ts. Painting cells is a brush, not an item list, so the
// selection/commands half of the toolkit (built for object editors) stays out.

import { createHistory, type ReportSink } from "@ccllc/arcade/core";
import { createKeymap } from "@ccllc/arcade/editor";
import { BOTTOM_ROW, CELL, COLS, ROWS, SHROOM_HP, TOP_ROW } from "./config";
import type { LevelDoc, LevelStore } from "./levels";
import type { Renderer, RenderOptions } from "./render";

export interface LevelEditorElements {
  panel: HTMLElement;
  canvas: HTMLCanvasElement;
  name: HTMLInputElement;
  startLevel: HTMLInputElement;
  shelf: HTMLElement;
  status: HTMLElement;
  help: HTMLElement;
  buttons: {
    save: HTMLButtonElement;
    saveAs: HTMLButtonElement;
    newField: HTMLButtonElement;
    clear: HTMLButtonElement;
    scatter: HTMLButtonElement;
    playtest: HTMLButtonElement;
    hostCoop: HTMLButtonElement;
    download: HTMLButtonElement;
    share: HTMLButtonElement;
    importFile: HTMLButtonElement;
    close: HTMLButtonElement;
    undo: HTMLButtonElement;
    redo: HTMLButtonElement;
  };
  file: HTMLInputElement;
}

export interface LevelEditor {
  open(doc?: LevelDoc): void;
  close(): void;
  readonly isOpen: boolean;
  /** The document being edited, as it stands. */
  current(): LevelDoc;
  handleKey(event: KeyboardEvent): boolean;
  draw(renderOptions: RenderOptions): void;
  pointer(worldX: number, worldY: number, buttons: number): void;
  pointerUp(): void;
  pointerLeave(): void;
}

interface EditorState {
  name: string;
  startLevel: number;
  cells: number[];
}

export function createLevelEditor(options: {
  elements: LevelEditorElements;
  store: LevelStore;
  renderer: Renderer;
  report?: ReportSink;
  onPlaytest: (doc: LevelDoc) => void;
  onHostCoop: (doc: LevelDoc) => void;
  onClose: () => void;
}): LevelEditor {
  const { elements, store, renderer } = options;
  const { format, library } = store;

  let openFlag = false;
  let docId: string | null = null;
  let state: EditorState = fresh();
  let brush = SHROOM_HP;
  let hover: { col: number; row: number } | null = null;
  let painting = false;
  let paintValue = 0;
  let dirty = false;

  const history = createHistory<EditorState>({ limit: 80, coalesceMs: 700 });
  history.reset(state);

  function fresh(): EditorState {
    return { name: "Untitled field", startLevel: 1, cells: new Array(COLS * ROWS).fill(0) };
  }

  function toDoc(): LevelDoc {
    return format.parse(
      format.create({ name: state.name, startLevel: state.startLevel, cells: state.cells } as Partial<LevelDoc>),
    );
  }

  function fromDoc(doc: LevelDoc, id: string | null): void {
    state = { name: doc.name, startLevel: doc.startLevel, cells: [...doc.cells] };
    docId = id;
    elements.name.value = state.name;
    elements.startLevel.value = String(state.startLevel);
    history.reset(state);
    dirty = false;
    say(`Editing "${doc.name}".`);
  }

  function say(text: string): void {
    elements.status.textContent = text;
  }

  function commit(coalesceKey?: string): void {
    history.commit(state, coalesceKey);
    dirty = true;
    refreshUndoButtons();
  }

  function refreshUndoButtons(): void {
    elements.buttons.undo.disabled = !history.canUndo;
    elements.buttons.redo.disabled = !history.canRedo;
  }

  function applyHistory(next: EditorState | undefined): void {
    if (!next) return;
    state = { name: next.name, startLevel: next.startLevel, cells: [...next.cells] };
    elements.name.value = state.name;
    elements.startLevel.value = String(state.startLevel);
    dirty = true;
    refreshUndoButtons();
  }

  function paint(col: number, row: number, value: number): void {
    if (col < 0 || col >= COLS || row < TOP_ROW || row > BOTTOM_ROW) return;
    const i = row * COLS + col;
    if (state.cells[i] === value) return;
    state.cells = [...state.cells];
    state.cells[i] = value;
    commit("paint");
  }

  function renderShelf(): void {
    const entries = library.entries();
    elements.shelf.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "shelf-empty";
      empty.textContent = "No saved fields yet.";
      elements.shelf.append(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "shelf-entry";
      const label = document.createElement("button");
      label.type = "button";
      label.className = "shelf-load";
      const count = entry.document.cells.filter((c) => c > 0).length;
      label.textContent = `${entry.name} · ${count} mushrooms · L${entry.document.startLevel}`;
      label.addEventListener("click", () => fromDoc(entry.document, entry.id));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "shelf-delete";
      del.textContent = "✕";
      del.title = "Delete";
      del.addEventListener("click", () => {
        library.remove(entry.id);
        if (docId === entry.id) docId = null;
        renderShelf();
        say(`Deleted "${entry.name}".`);
      });
      row.append(label, del);
      elements.shelf.append(row);
    }
  }

  function save(as: boolean): void {
    state.name = elements.name.value.trim() || "Untitled field";
    state.startLevel = Math.min(Math.max(Math.floor(Number(elements.startLevel.value) || 1), 1), 50);
    const doc = toDoc();
    const entry = as
      ? library.save(doc, { name: library.uniqueName(doc.name) })
      : library.save(doc, docId ? { id: docId, name: doc.name } : { name: doc.name });
    if (entry) {
      docId = entry.id;
      dirty = false;
      renderShelf();
      say(`Saved "${entry.name}".`);
    } else {
      say("The browser refused to save — export a file instead.");
    }
  }

  // The shortcut table is a value: the same rows run the handler and render
  // the help line, so the two cannot drift.
  const keymap = createKeymap([
    { code: "KeyZ", ctrl: true, label: "Ctrl+Z", description: "undo", run: () => applyHistory(history.undo()) },
    {
      code: "KeyZ",
      ctrl: true,
      shift: true,
      label: "Ctrl+Shift+Z",
      description: "redo",
      run: () => applyHistory(history.redo()),
    },
    { code: "KeyY", ctrl: true, label: "Ctrl+Y", description: "redo", run: () => applyHistory(history.redo()) },
    {
      code: "KeyS",
      ctrl: true,
      allowInTextEntry: true,
      label: "Ctrl+S",
      description: "save",
      run: () => save(false),
    },
    ...[1, 2, 3, 4].map((hp) => ({
      code: `Digit${hp}`,
      label: String(hp),
      description: hp === SHROOM_HP ? "brush: full mushroom" : `brush: ${hp} hp`,
      run: () => {
        brush = hp;
        say(`Brush: mushroom with ${hp} hp.`);
      },
    })),
    {
      code: ["Digit0", "KeyE"],
      label: "0 / E",
      description: "eraser",
      run: () => {
        brush = 0;
        say("Brush: eraser.");
      },
    },
    { code: "Escape", label: "Esc", description: "close", run: () => editor.close() },
  ]);

  elements.help.textContent = keymap
    .describe()
    .map((b) => `${b.label ?? b.code.join("/")} ${b.description ?? ""}`.trim())
    .join("  ·  ");

  // --- Wire the chrome. ----------------------------------------------------
  elements.buttons.save.addEventListener("click", () => save(false));
  elements.buttons.saveAs.addEventListener("click", () => save(true));
  elements.buttons.newField.addEventListener("click", () => fromDoc(format.parse(format.create()), null));
  elements.buttons.clear.addEventListener("click", () => {
    state.cells = new Array(COLS * ROWS).fill(0);
    commit();
    say("Cleared.");
  });
  elements.buttons.scatter.addEventListener("click", () => {
    // A starting point that matches what the game itself would deal: the
    // classic scatter, minted from the wall clock — this is authoring, not
    // simulation, so `Date.now` is honest here.
    const cells = new Array(COLS * ROWS).fill(0);
    let seed = Date.now() >>> 0;
    const next = () => {
      seed ^= seed << 13;
      seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed;
    };
    let planted = 0;
    let attempts = 68 * 40;
    while (planted < 68 && attempts-- > 0) {
      const col = next() % COLS;
      const row = (TOP_ROW + 1) + (next() % (BOTTOM_ROW - 2 - (TOP_ROW + 1) + 1));
      const i = row * COLS + col;
      if (cells[i] === 0) {
        cells[i] = SHROOM_HP;
        planted += 1;
      }
    }
    state.cells = cells;
    commit();
    say("Scattered a classic field.");
  });
  elements.buttons.playtest.addEventListener("click", () => {
    const doc = toDoc();
    editor.close();
    options.onPlaytest(doc);
  });
  elements.buttons.hostCoop.addEventListener("click", () => {
    const doc = toDoc();
    editor.close();
    options.onHostCoop(doc);
  });
  elements.buttons.download.addEventListener("click", () => {
    const doc = toDoc();
    format.download(doc, doc.name);
    say("Downloaded.");
  });
  elements.buttons.share.addEventListener("click", async () => {
    try {
      const link = format.shareLink(toDoc(), { param: "level" });
      await navigator.clipboard.writeText(link);
      say("Share link copied to the clipboard.");
    } catch {
      say("Could not build a share link here.");
    }
  });
  elements.buttons.importFile.addEventListener("click", () => elements.file.click());
  elements.file.addEventListener("change", async () => {
    const file = elements.file.files?.[0];
    elements.file.value = "";
    if (!file) return;
    try {
      const doc = await format.readFile(file);
      fromDoc(doc, null);
      say(`Imported "${doc.name}".`);
    } catch (err) {
      say(err instanceof Error ? err.message : "That file is not a level.");
    }
  });
  elements.buttons.close.addEventListener("click", () => editor.close());
  elements.buttons.undo.addEventListener("click", () => applyHistory(history.undo()));
  elements.buttons.redo.addEventListener("click", () => applyHistory(history.redo()));

  elements.name.addEventListener("change", () => {
    state.name = elements.name.value.trim() || "Untitled field";
    commit("meta");
  });
  elements.startLevel.addEventListener("change", () => {
    state.startLevel = Math.min(Math.max(Math.floor(Number(elements.startLevel.value) || 1), 1), 50);
    elements.startLevel.value = String(state.startLevel);
    commit("meta");
  });

  history.subscribe(refreshUndoButtons);
  refreshUndoButtons();

  const editor: LevelEditor = {
    open(doc) {
      openFlag = true;
      elements.panel.classList.remove("hidden");
      if (doc) {
        fromDoc(doc, null);
      } else {
        const draft = library.readDraft();
        if (draft && dirty === false && docId === null) fromDoc(draft, null);
      }
      renderShelf();
      say("Paint with the mouse; right-click erases.");
    },
    close() {
      if (!openFlag) return;
      openFlag = false;
      library.saveDraft(toDoc());
      elements.panel.classList.add("hidden");
      options.onClose();
    },
    get isOpen() {
      return openFlag;
    },
    current: toDoc,
    handleKey: (event) => (openFlag ? keymap.handle(event) : false),
    draw(renderOptions) {
      const cursor = hover ? { col: hover.col, row: hover.row, hp: brush } : null;
      renderer.drawField(state.cells, cursor, renderOptions);
    },
    pointer(worldX, worldY, buttons) {
      const col = Math.floor(worldX / CELL);
      const row = Math.floor(worldY / CELL);
      hover = { col, row };
      if (buttons & 2) {
        painting = true;
        paintValue = 0;
      } else if (buttons & 1) {
        painting = true;
        paintValue = brush;
      }
      if (painting) paint(col, row, paintValue);
    },
    pointerUp() {
      painting = false;
      history.breakCoalescing();
    },
    pointerLeave() {
      hover = null;
      painting = false;
    },
  };

  return editor;
}
