// src/lib/mapPopupTheme.js
//
// Inline styles for Leaflet popups. The DAO map's popups are always light
// (white card, grey text), so this is the light variant of dossier's helper.
export const getPopupTheme = () => ({
  wrapper: "background:#ffffff;border-radius:8px;border:1px solid rgba(0,0,0,0.08);",
  title: "#374151",
  body: "#6b7280",
  label: "#9ca3af",
  button: "background:#8B1A2A;border:1px solid #8B1A2A;color:#ffffff;",
});
