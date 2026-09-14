import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
