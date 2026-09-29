import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // ADDED: keep the production bundle's console clean. The app has ~50
  // debug console.log calls (theme, user-info cache, follow/timeline
  // requests, tx hashes ...) that are useful while developing but are
  // just noise — and expose internal state — for visitors of the
  // published site. Marking log/info/debug as pure makes the production
  // build (minified) drop them; they still print in `vite dev`.
  // console.warn / console.error are deliberately NOT listed: they report
  // real failures and stay in production.
  esbuild: {
    pure: ["console.log", "console.info", "console.debug"],
    drop: ["debugger"],
  },
  server: {
    headers: {
      // "same-origin-allow-popups" (not "same-origin") is required for
      // Privy's OAuth login popups (Google, plus the Coinbase/Base
      // Account SDKs it loads for the "wallet" login option) — plain
      // "same-origin" severs window.opener, so the popup completes
      // login but can never report success back to this page.
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    },
    proxy: {
      "/api": {
        target: "http://localhost:3005",
        changeOrigin: true,
      },
    },
  },
});
