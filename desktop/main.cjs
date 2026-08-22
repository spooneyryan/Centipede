// The Electron wrapper: a window, and the server if needed. The game itself
// is unchanged — @ccllc/arcade's preload exposes the desktop bridge on
// globalThis, createPresentation prefers it over the DOM Fullscreen API
// automatically, so the same Full screen button drives the real window, and
// leaving fullscreen restores the windowed size remembered in settings.
//
// Run with:  npm run build && npx electron desktop/main.cjs
// (electron is not a dependency of this project — `npm i -D electron` first.)

const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

// GameBase is referenced by path, same as the rest of the game.
const ARCADE = path.join(__dirname, "..", "..", "..", "..", "GameBase", "GameBase", "packages", "arcade");
const { registerArcadeDesktop } = require(path.join(ARCADE, "desktop", "electron-main.cjs"));
const PRELOAD = path.join(ARCADE, "desktop", "electron-preload.cjs");

const PORT = 5190;
const ORIGIN = `http://localhost:${PORT}`;
let server = null;

// The server is up and it is THIS server when a plain GET to the socket path
// answers 400 (not-a-websocket-request).
function probe() {
  return new Promise((resolveProbe) => {
    const req = http.get(`${ORIGIN}/ws/mp`, (res) => {
      res.resume();
      resolveProbe(res.statusCode === 400);
    });
    req.on("error", () => resolveProbe(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolveProbe(false);
    });
  });
}

async function ensureServer() {
  if (await probe()) return;
  server = spawn(
    "dotnet",
    ["run", "--project", path.join(__dirname, "..", "server"), "--urls", ORIGIN],
    { stdio: "inherit" },
  );
  for (let i = 0; i < 90; i++) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("The server never came up.");
}

app.whenReady().then(async () => {
  await ensureServer();
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    autoHideMenuBar: true,
    backgroundColor: "#05060a",
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  registerArcadeDesktop(window);
  await window.loadURL(ORIGIN);
});

app.on("window-all-closed", () => app.quit());
app.on("quit", () => {
  if (server) server.kill();
});
