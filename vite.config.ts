// The game references GameBase BY PATH — the form the GameBase docs bless for
// developing against source: one copy of the code, no feed auth, and a change
// on either side is visible immediately. Switching to the published packages
// (`npm install @ccllc/arcade @ccllc/coop @ccllc/studio`) would replace the
// aliases below with nothing else changing.

import { resolve } from "node:path";
import { defineConfig } from "vite";

const GB = resolve(__dirname, "../../../GameBase/GameBase/packages");

export default defineConfig({
  root: __dirname,
  base: "./", // relative asset paths survive a virtual-directory deployment
  resolve: {
    // The studio sources live in the GameBase checkout, whose own
    // node_modules also holds a React — without dedupe the bundle carries two
    // copies and every hook call dies on a null dispatcher.
    dedupe: ["react", "react-dom"],
    alias: [
      { find: "@ccllc/coop", replacement: resolve(GB, "coop/src/coop.ts") },
      { find: "@ccllc/studio/render", replacement: resolve(GB, "studio/src/render.ts") },
      { find: "@ccllc/studio/styles.css", replacement: resolve(GB, "studio/styles.css") },
      { find: "@ccllc/studio", replacement: resolve(GB, "studio/src/index.ts") },
      // One entry per arcade sub-path: `@ccllc/arcade/core` -> core/index.js …
      { find: /^@ccllc\/arcade\/(.+)$/, replacement: resolve(GB, "arcade") + "/$1/index.js" },
      { find: "@ccllc/arcade", replacement: resolve(GB, "arcade/index.js") },
    ],
  },
  server: {
    // In dev the relay runs separately (`npm run relay`); the page still finds
    // it at its own origin because Vite proxies the socket through.
    proxy: {
      "/ws/mp": { target: "ws://localhost:5190", ws: true },
    },
    fs: {
      // The aliases reach outside this project into the GameBase checkout.
      allow: [__dirname, GB],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
  },
})
