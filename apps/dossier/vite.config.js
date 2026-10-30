import process from "node:process";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Dev-only: serves GET /api/events (the "Live" map layer's external events)
// straight from `vite dev`, using the same code as the production Worker
// (worker/feeds.js). Without this the request would be proxied to
// localhost:3005 and fail, and the layer would stay empty unless you ran
// `wrangler dev`. Secrets such as ACLED_EMAIL / ACLED_PASSWORD are read from
// .env.local (WITHOUT a VITE_ prefix, so they never reach the browser).
const liveEventsDevApi = (env) => ({
  name: "dossier-live-events-dev-api",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/api/events", async (req, res, next) => {
      if (req.method !== "GET") return next();
      try {
        const { handleEvents } = await import("./worker/feeds.js");
        const origin = `http://${req.headers.host || "localhost:5173"}`;
        const response = await handleEvents(new Request(`${origin}/api/events`), null, {
          env,
        });
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        res.end(await response.text());
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: String(err?.message || err) }));
      }
    });
  },
});

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), liveEventsDevApi(loadEnv(mode, process.cwd(), ""))],
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
}));
