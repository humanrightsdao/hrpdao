import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // snarkjs/circomlibjs (ZK-доказ локації, src/lib/locationZk.js)
    // залежать від кількох вбудованих модулів Node (buffer/process/
    // events/assert) — без цього плагіна Vite лише "externalize"-ить їх
    // (попередження при build), і виклик згенерувати ZK-доказ у браузері
    // впав би в рантаймі з "buffer is not defined" тощо.
    nodePolyfills({
      include: ["buffer", "process", "events", "assert", "stream", "util"],
    }),
  ],
  server: {
    // Окремий порт від lens (5173) і nostr (5174), щоб можна було
    // тримати всі три застосунки запущеними одночасно локально.
    port: 5175,
  },
});
