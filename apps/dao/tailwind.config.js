/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Взято напряму з існуючого бренду hrpdaolens/hrpdaonostr ──
        ink: "#00091c", // фон, як у CountryPage.jsx
        surface: "#000d1f", // картки
        surface2: "#0a0f1a", // піднятий/hover стан
        hairline: "rgba(255,255,255,0.08)",
        hairlineStrong: "rgba(255,255,255,0.14)",
        parchment: "#F4F2ED",
        parchmentDim: "rgba(244,242,237,0.55)",
        // бордовий акцент бренду (violations/danger/proti)
        seal: "#8B1A2A",
        sealBright: "#e8a0b0",
        sealDeep: "#2B000A",
        // синій акцент бренду (active/за/interactive)
        verdigris: "#3B7DFF",
        verdigrisBright: "#6FA0FF",
        verdigrisDeep: "#1a3f7a",
        gold: "#C9A227",
      },
      fontFamily: {
        display: ["'Space Grotesk'", "sans-serif"],
        body: ["Inter", "sans-serif"],
        mono: ["'IBM Plex Mono'", "monospace"],
        cinzel: ["Cinzel", "serif"],
      },
    },
  },
  plugins: [],
};

