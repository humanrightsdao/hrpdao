# Live layer — how it works and how to connect it

The same overlays (Live + Danger zones) appear on three maps: the violations
map page, the Country page map, and the map on the login page. They share one
implementation: `src/hooks/useMapOverlays.js` (what is drawn),
`src/utils/mapOverlays.js` (Leaflet builders) and
`src/components/MapLayerControls.jsx` (the on-map switches).

The map's **Live** switch controls three things at once:

| What | Source | Needs setup? |
|---|---|---|
| Pulsing red pins | Serious (felony) violations on this platform from the last 48 h | No |
| Round badges 🌍🌀💧🌋🔥🌊 | **GDACS** (UN OCHA / EC JRC): natural hazards, Green / Orange / Red alert | No key — but needs the Worker (or `vite dev`, see below) |
| Diamond badges ⚔️⚠️💥 | **ACLED**: conflict events (battles, violence against civilians, explosions) | Yes — ACLED account with API access |

Green / zero-fatality events are drawn small and dim.

## Why a layer can look empty

* **Pins:** there must be a violation with severity 3 (felony), valid
  coordinates, and an event date *or* publication time within the last 48 h.
  Change the window in `src/utils/liveAlerts.js` (`LIVE_ALERT_WINDOW_HOURS`).
* **GDACS / ACLED events** come from `GET /api/events`.
  * `npm run dev` serves it by itself (see `vite.config.js`). Restart the dev
    server after pulling this change.
  * In production the Cloudflare Worker serves it (`worker/feeds.js`).
  * Check it directly: open `/api/events` in the browser. You should see
    `"sources": { "gdacs": { "ok": true, … } }`. If `ok` is `false`, the
    `error` field says why.

## Connecting ACLED

1. Get an ACLED account whose access level **includes the API** (Research,
   Partner or Enterprise). The free "Open" level — which a gmail.com-style
   address gets automatically — has no API. Ask ACLED for access for your
   organisation.
2. Read ACLED's Terms of Use / Attribution Policy: they require attribution
   (the map credits ACLED automatically) and restrict some secondary uses.
   Showing its events on a public site may need ACLED's permission.
3. Add the credentials:
   * **Production:** `npx wrangler secret put ACLED_EMAIL` and
     `npx wrangler secret put ACLED_PASSWORD`, then deploy.
   * **`npm run dev`:** put `ACLED_EMAIL=…` and `ACLED_PASSWORD=…` in
     `.env.local` — **without** a `VITE_` prefix (anything with that prefix is
     sent to the browser). Restart the dev server.
   * **`wrangler dev`:** put them in `.dev.vars`.
4. Optional: `ACLED_DAYS` (look-back window, default 14, max 90) and
   `ACLED_ENABLED=false` to switch it off without removing the secrets.

ACLED publishes weekly and some access levels receive data with a time lag, so
it is "recent", not real-time. If your level's lag is longer than
`ACLED_DAYS`, the layer stays empty. The Worker caches the ACLED result for
6 hours, and GDACS for 10 minutes.

## Adding another source

Add an entry to `FEED_SOURCES` in `worker/feeds.js` (`id`, `ttl`,
`enabled(env)`, `load(env, deps)`), return events in the documented shape,
and add its label to `EVENT_SOURCES` in `src/utils/liveEvents.js`.

## Map controls & zoom behaviour

- Green (minor) events are drawn only from zoom level 5 (`MINOR_EVENTS_MIN_ZOOM` in `src/utils/mapOverlays.js`) — roughly a country or part of a continent. Orange/red events and alert pins are always shown. The "Live" counter counts what is currently on the map.
- The layer panel (`MapLayerControls`) is a single "Layers" button with the live counter; tap it to open/close the panel. It starts collapsed on every map. Escape closes it.
