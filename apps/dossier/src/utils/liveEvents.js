// src/utils/liveEvents.js
//
// Constants and small pure helpers for the "Live events" map layer
// (external feed events delivered by the Worker's /api/events).

// Event type codes → i18n key suffix + marker emoji.
//   GDACS (natural hazards): EQ TC FL VO WF TS
//   ACLED (conflict events): BAT VAC EXP
export const EVENT_TYPES = {
  EQ: { key: "earthquake", label: "Earthquake", emoji: "🌍" },
  TC: { key: "cyclone", label: "Tropical cyclone", emoji: "🌀" },
  FL: { key: "flood", label: "Flood", emoji: "💧" },
  VO: { key: "volcano", label: "Volcano", emoji: "🌋" },
  WF: { key: "wildfire", label: "Wildfire", emoji: "🔥" },
  TS: { key: "tsunami", label: "Tsunami", emoji: "🌊" },
  BAT: { key: "battle", label: "Battle", emoji: "⚔️" },
  VAC: {
    key: "violence_civilians",
    label: "Violence against civilians",
    emoji: "⚠️",
  },
  EXP: { key: "explosion", label: "Explosion / remote violence", emoji: "💥" },
};

// Where an event came from (shown in popups and the map attribution).
export const EVENT_SOURCES = {
  gdacs: "GDACS (UN / EC JRC)",
  acled: "ACLED",
};

export const EVENT_LEVELS = {
  red: { key: "red", label: "Red alert", color: "#dc2626", rank: 3 },
  orange: { key: "orange", label: "Orange alert", color: "#f59e0b", rank: 2 },
  green: { key: "green", label: "Green alert", color: "#16a34a", rank: 1 },
};

export const getEventType = (code) =>
  EVENT_TYPES[code] || { key: "event", label: "Event", emoji: "❗" };

export const getEventLevel = (level) => EVENT_LEVELS[level] || EVENT_LEVELS.green;

/** Green events ("minor") are drawn smaller and dimmer so they don't compete. */
export const isMinorEvent = (event) => getEventLevel(event?.level).rank <= 1;

/** Natural hazards and conflict events look different on the map. */
export const isConflictEvent = (event) => event?.category === "conflict";

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text from an external feed must be escaped before it goes into popup HTML. */
export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

const SAFE_LINK_PREFIXES = ["https://www.gdacs.org/"];

/** Only links to known sources are ever put into an href. */
export const isSafeSourceUrl = (url) =>
  typeof url === "string" && SAFE_LINK_PREFIXES.some((p) => url.startsWith(p));
