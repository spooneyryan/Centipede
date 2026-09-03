// The centipede level editor: paint a mushroom field, keep it on a library
// shelf, share it as a link or a file, playtest it solo, or host it as a
// co-op match. Built on GameBase's editor toolkit — `createKeymap` for the
// shortcut table (which also renders the help line), `createHistory` for
// undo/redo with gesture coalescing — and, for everything about saving,
// `createDocumentSession`, the one document model every GameBase editor
// follows (docs/EDITOR-UX.md in the GameBase repository):
//
//   - the name field RENAMES the open field and never forks one;
//   - Save writes by id, the first save mints the id, and the button is
//     disabled while there is nothing unsaved;
//   - Duplicate copies what is on screen to "Name (copy)" and switches into it
//     — the only way a second field comes into being;
//   - New, opening another field and importing a file all ask before
//     discarding unsaved work; delete is undoable for six seconds; and the
//     browser itself asks before the tab is closed on unsaved work.
//
// Painting cells is a brush, not an item list, so the selection/commands
// half of the toolkit (built for object editors) stays out.

import {
  createDocumentSession,
  createHistory,
  type DocumentSession,
  type ReportSink,
} from "@ccllc/arcade/core";
import { createKeymap } from "@ccllc/arcade/editor";
import { BOTTOM_ROW, CELL, COLS, ROWS, SHROOM_HP, TOP_ROW } from "./config";
import type { LevelDoc, LevelStore } from "./levels";
import type { Renderer, RenderOptions } from "./render";

export interface LevelEditorElements {
  panel: HTMLElement;
  canvas: HTMLCanvasElement;
  name: HTMLInputElement;
  startLevel: HTMLInputElement;
  /** The dot after the name while the field has unsaved changes. */
  dirty: HTMLElement;
  shelf: HTMLElement;
  status: HTMLElement;
  help: HTMLElement;
  buttons: {
    save: HTMLButtonElement;
    duplicate: HTMLButtonElement;
    newField: HTMLButtonElement;
    clear: HTMLButtonElement;
    scatter: HTMLButtonElement;
    playtest: HTMLButtonElement;
    hostCoop: HTMLButtonElement;
    exportFile: HTMLButtonElement;
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

/** What undo remembers: the editable parts of a field, and nothing else. */
interface EditorState {
  name: string;
  startLevel: number;
  cells: number[];
}

const UNDO_WINDOW_MS = 6000;

/**
 * A modal question with named answers. The browser offers confirm() with
 * two answers it will not let you name; "save, discard or stay" is three,
 * and "rename it, or save a copy" deserves its own words. Resolves the index
 * of the answer chosen, or null when the dialog is dismissed with Escape.
 */
function createChoiceDialog(): (text: string, choices: string[]) => Promise<number | null> {
  let dialog: HTMLDialogElement | null = null;
  return (text, choices) =>
    new Promise((resolve) => {
      if (!dialog) {
        dialog = document.createElement("dialog");
        dialog.className = "choice-dialog";
        document.body.append(dialog);
      }
      const box = dialog;
      const message = document.createElement("p");
      message.textContent = text;
      const row = document.createElement("div");
      row.className = "button-row";
      let done = false;
      const onClose = () => finish(null);
      const finish = (index: number | null) => {
        if (done) return;
        done = true;
        box.removeEventListener("close", onClose);
        if (box.open) box.close();
        resolve(index);
      };
      choices.forEach((label, index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        if (index === 0) button.className = "primary";
        button.addEventListener("click", () => finish(index));
        row.append(button);
      });
      box.replaceChildren(message, row);
      box.addEventListener("close", onClose);
      box.showModal();
      row.querySelector("button")?.focus();
    });
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
  let brush = SHROOM_HP;
  const ask = createChoiceDialog();
  let hover: { col: number; row: number } | null = null;
  let painting = false;
  let paintValue = 0;

  // The session owns identity, dirtiness, the shelf and the draft. The editor
  // owns the brush, the undo history, and the inputs — and pushes every
  // change into the session so the two never disagree about what is open.
  const session: DocumentSession<LevelDoc> = createDocumentSession<LevelDoc>({
    format,
    library,
    blank: () => format.parse(format.create()),
    nameOf: (doc) => doc.name,
    withName: (doc, name) => ({ ...doc, name }),
    undoWindowMs: UNDO_WINDOW_MS,
    report: options.report,
  });

  let state: EditorState = fromDoc(session.state.doc);
  const history = createHistory<EditorState>({ limit: 80, coalesceMs: 700 });
  history.reset(state);

  function fromDoc(doc: LevelDoc): EditorState {
    return { name: doc.name, startLevel: doc.startLevel, cells: [...doc.cells] };
  }

  function toDoc(): LevelDoc {
    return format.parse(
      format.create({ name: state.name, startLevel: state.startLevel, cells: state.cells } as Partial<LevelDoc>),
    );
  }

  /** The session just loaded a document; make it the one on screen. */
  function adopt(doc: LevelDoc): void {
    state = fromDoc(doc);
    elements.name.value = state.name;
    elements.startLevel.value = String(state.startLevel);
    history.reset(state);
    refreshUndoButtons();
  }

  /** The editor changed the field; tell the session. */
  function sync(): void {
    const doc = toDoc();
    // A rename goes through the session's own verb so a saved field's shelf
    // label follows at once, before the next save.
    if (doc.name !== session.state.name) session.rename(doc.name);
    session.update(doc);
  }

  function say(text: string): void {
    elements.status.replaceChildren(text);
  }

  /** A status line with an action on it — "Deleted X. [Undo]". */
  function sayWithAction(text: string, label: string, run: () => void): void {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", run);
    elements.status.replaceChildren(text + " ", button);
  }

  function commit(coalesceKey?: string): void {
    history.commit(state, coalesceKey);
    refreshUndoButtons();
    sync();
  }

  function refreshUndoButtons(): void {
    elements.buttons.undo.disabled = !history.canUndo;
    elements.buttons.redo.disabled = !history.canRedo;
  }

  /** The chrome the session drives: the dot, Save, and the undo offer. */
  function refreshChrome(): void {
    const current = session.state;
    elements.dirty.hidden = !current.dirty;
    elements.buttons.save.disabled = !current.dirty;
    if (!current.canUndoRemove && elements.status.querySelector("button")) {
      // The window closed on an undo nobody took; the offer goes with it.
      elements.status.replaceChildren(elements.status.firstChild?.textContent ?? "");
    }
  }

  function applyHistory(next: EditorState | undefined): void {
    if (!next) return;
    state = { name: next.name, startLevel: next.startLevel, cells: [...next.cells] };
    elements.name.value = state.name;
    elements.startLevel.value = String(state.startLevel);
    refreshUndoButtons();
    sync();
  }

  /** Read the two inputs into the state; a change is an undo step. */
  function applyInputs(): void {
    const name = elements.name.value.trim() || "Untitled field";
    const startLevel = Math.min(Math.max(Math.floor(Number(elements.startLevel.value) || 1), 1), 50);
    elements.startLevel.value = String(startLevel);
    if (name === state.name && startLevel === state.startLevel) return;
    state.name = name;
    state.startLevel = startLevel;
    commit("meta");
  }

  /**
   * Unsaved work is never thrown away in silence. Before New, opening
   * another field, or importing, the person chooses: save it, discard it,
   * or stay.
   */
  async function settleDirty(before: string): Promise<boolean> {
    if (!session.state.dirty) return true;
    const label = session.state.name;
    const choice = await ask(`"${label}" has unsaved changes. Save them before ${before}?`, ["Save", "Discard", "Cancel"]);
    if (choice === 0) {
      await save();
      return !session.state.dirty;
    }
    return choice === 1;
  }

  function paint(col: number, row: number, value: number): void {
    if (col < 0 || col >= COLS || row < TOP_ROW || row > BOTTOM_ROW) return;
    const i = row * COLS + col;
    if (state.cells[i] === value) return;
    state.cells = [...state.cells];
    state.cells[i] = value;
    commit("paint");
  }

  // --- The verbs. Each one is a sentence from the contract. -----------------

  async function save(): Promise<void> {
    applyInputs();
    const { id, renamed, savedName, name } = session.state;
    if (id !== null && renamed && savedName !== null) {
      // A saved field under a changed name: did they mean to rename it, or
      // to keep the old one and save this as a new field? Ryan asked for the
      // question after Save had, correctly but silently, renamed a field.
      const choice = await ask(
        `You changed the name from "${savedName}" to "${name}". Rename the saved field, or keep "${savedName}" as it was and save this as a new field?`,
        ["Rename it", "Save as a new field", "Cancel"],
      );
      if (choice === null || choice === 2) return;
      if (choice === 1) {
        duplicate();
        return;
      }
    }
    const entry = session.save();
    if (entry) {
      renderShelf();
      say(`Saved "${entry.name}".`);
    } else {
      say("The browser refused to save — export a file instead.");
    }
  }

  function duplicate(): void {
    applyInputs();
    const entry = session.duplicate();
    if (!entry) {
      say("The browser refused to save the copy — export a file instead.");
      return;
    }
    adopt(session.state.doc);
    renderShelf();
    say(`Duplicated as "${entry.name}" — you are editing the copy.`);
  }

  async function newField(): Promise<void> {
    if (!(await settleDirty("starting a new field"))) return;
    session.new({ force: true });
    adopt(session.state.doc);
    renderShelf();
    say("A new, empty field.");
  }

  async function openEntry(entry: { id: string; name: string }): Promise<void> {
    if (entry.id === session.state.id) {
      say(`"${entry.name}" is already open.`);
      return;
    }
    if (!(await settleDirty(`opening "${entry.name}"`))) return;
    if (!session.open(entry.id, { force: true })) return;
    adopt(session.state.doc);
    renderShelf();
    say(`Editing "${entry.name}".`);
  }

  function renameEntry(entry: { id: string; name: string }): void {
    const next = window.prompt(`Rename "${entry.name}" to:`, entry.name)?.trim();
    if (!next || next === entry.name) return;
    if (entry.id === session.state.id) {
      elements.name.value = next;
      applyInputs();
      session.save(); // explicit intent: the open field is renamed in place
    } else {
      library.rename(entry.id, next);
    }
    renderShelf();
    say(`Renamed to "${next}".`);
  }

  function removeEntry(entry: { id: string; name: string }): void {
    if (!session.remove(entry.id)) return;
    renderShelf();
    sayWithAction(`Deleted "${entry.name}".`, "Undo", () => {
      if (session.undoRemove()) {
        renderShelf();
        say(`Restored "${entry.name}".`);
      }
    });
  }

  async function importFile(file: File): Promise<void> {
    if (!(await settleDirty("importing a file"))) return;
    try {
      await session.importFile(file, { force: true });
      adopt(session.state.doc);
      say(`Imported "${session.state.name}" — it is not on the shelf until you save it.`);
    } catch (err) {
      say(err instanceof Error ? err.message : "That file is not a level.");
    }
  }

  function renderShelf(): void {
    const entries = session.entries();
    elements.shelf.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "shelf-empty";
      empty.textContent = "No saved fields yet.";
      elements.shelf.append(empty);
      return;
    }
    const action = (label: string, title: string, run: () => void): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "shelf-action";
      button.textContent = label;
      button.title = title;
      button.addEventListener("click", run);
      return button;
    };
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "shelf-entry";
      if (entry.id === session.state.id) row.classList.add("open");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "shelf-load";
      const count = entry.document.cells.filter((c) => c > 0).length;
      open.textContent = `${entry.name} · ${count} mushrooms · L${entry.document.startLevel}`;
      open.title = `Open "${entry.name}"`;
      open.addEventListener("click", () => openEntry(entry));
      row.append(
        open,
        action("Rename", `Rename "${entry.name}"`, () => renameEntry(entry)),
        action("Delete", `Delete "${entry.name}" (undo for a few seconds)`, () => removeEntry(entry)),
      );
      elements.shelf.append(row);
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
      shift: true,
      allowInTextEntry: true,
      label: "Ctrl+Shift+S",
      description: "duplicate",
      run: duplicate,
    },
    {
      code: "KeyS",
      ctrl: true,
      allowInTextEntry: true,
      label: "Ctrl+S",
      description: "save",
      run: () => void save(),
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
  elements.buttons.save.addEventListener("click", () => void save());
  elements.buttons.duplicate.addEventListener("click", duplicate);
  elements.buttons.newField.addEventListener("click", () => void newField());
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
    applyInputs();
    const doc = toDoc();
    editor.close();
    options.onPlaytest(doc);
  });
  elements.buttons.hostCoop.addEventListener("click", () => {
    applyInputs();
    const doc = toDoc();
    editor.close();
    options.onHostCoop(doc);
  });
  elements.buttons.exportFile.addEventListener("click", () => {
    applyInputs();
    const filename = session.exportFile();
    say(filename ? `Exported ${filename}.` : "Could not export here.");
  });
  elements.buttons.share.addEventListener("click", async () => {
    applyInputs();
    try {
      const link = session.shareLink({ param: "level" });
      if (!link) throw new Error("no share transport");
      await navigator.clipboard.writeText(link);
      say("Copied a share link.");
    } catch {
      say("Could not build a share link here.");
    }
  });
  elements.buttons.importFile.addEventListener("click", () => elements.file.click());
  elements.file.addEventListener("change", () => {
    const file = elements.file.files?.[0];
    elements.file.value = "";
    if (file) void importFile(file);
  });
  elements.buttons.close.addEventListener("click", () => editor.close());
  elements.buttons.undo.addEventListener("click", () => applyHistory(history.undo()));
  elements.buttons.redo.addEventListener("click", () => applyHistory(history.redo()));

  elements.name.addEventListener("change", applyInputs);
  elements.startLevel.addEventListener("change", applyInputs);

  history.subscribe(refreshUndoButtons);
  session.subscribe(refreshChrome);
  session.guardUnload(window);
  refreshUndoButtons();
  refreshChrome();

  const editor: LevelEditor = {
    open(doc) {
      openFlag = true;
      elements.panel.classList.remove("hidden");
      renderShelf();
      say("Paint with the mouse; right-click erases.");
      if (doc) {
        // A shared link or a hand-in: a new, unsaved field.
        void settleDirty("opening the shared field").then((ok) => {
          if (!ok) return;
          session.openDocument(doc, { force: true });
          adopt(session.state.doc);
          renderShelf();
          say(`Editing the shared field "${session.state.name}" — save it to keep it.`);
        });
      } else if (!session.state.dirty && session.state.id === null && session.hasDraft()) {
        void ask("Restore the unsaved field from last time?", ["Restore", "Discard"]).then((choice) => {
          if (choice === 0) {
            session.restoreDraft();
            adopt(session.state.doc);
            say("Restored the unsaved field.");
          } else {
            session.discardDraft();
          }
        });
      }
    },
    close() {
      if (!openFlag) return;
      openFlag = false;
      // The debounced draft may not have landed yet; an unsaved field keeps.
      if (session.state.dirty) library.saveDraft(session.state.doc);
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
