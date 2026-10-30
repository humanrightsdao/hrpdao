// src/utils/mapPopupTheme.js
//
// Inline styles for Leaflet popups, matching the current light/dark theme.
// (Popups are plain HTML strings, so they can't use Tailwind's dark: variants.)

export const getPopupTheme = () => {
  const isDark = document.documentElement.classList.contains("dark");
  return {
    wrapper: isDark
      ? "background:#000d1f;border-radius:8px;border:1px solid rgba(255,255,255,0.07);"
      : "background:#ffffff;border-radius:8px;border:1px solid rgba(0,0,0,0.08);",
    title: isDark ? "rgba(255,255,255,0.85)" : "#374151",
    body: isDark ? "rgba(255,255,255,0.45)" : "#6b7280",
    label: isDark ? "rgba(255,255,255,0.35)" : "#9ca3af",
    button: isDark
      ? "background:#2B000A;border:1px solid rgba(180,30,60,0.3);color:rgba(232,160,176,0.7);"
      : "background:#8B1A2A;border:1px solid #8B1A2A;color:#ffffff;",
  };
};
