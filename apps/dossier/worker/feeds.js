// worker/feeds.js
//
// GET /api/events — a small, cached proxy that turns external event sources
// into one normalised JSON list for the "Live" map layer.
//
// Why a proxy instead of calling the sources from the browser:
//   • most don't send CORS headers, so the browser can't read them;
//   • credentials (ACLED) must never reach the browser;
//   • one cached upstream request serves every visitor, instead of every
//     visitor hitting the source;
//   • the browser gets one stable, already-validated format.
//
// SOURCES
//   gdacs — GDACS (UN OCHA / EC JRC): natural hazards (earthquakes, tropical
//           cyclones, floods, volcanoes, wildfires, tsunamis) with a
//           Green / Orange / Red humanitarian alert level. It already
//           includes the significant earthquakes USGS reports, so USGS and
//           NASA EONET are deliberately NOT added — they would only
//           duplicate markers. No key needed.
//   acled — ACLED: human-coded conflict events (battles, violence against
//           civilians, explosions / remote violence). OFF unless
//           ACLED_EMAIL and ACLED_PASSWORD are configured. See
//           docs in `fetchAcled` below.
//
// To add another source: add an entry to FEED_SOURCES (id, ttl, enabled(env),
// load(env, deps) → events). Events must have the shape documented below.

/*
 * Normalised event shape (what the browser receives):
 * {
 *   id, source ("gdacs" | "acled"), category ("natural" | "conflict"),
 *   type      — GDACS: EQ TC FL VO WF TS · ACLED: BAT VAC EXP
 *   level     — "green" | "orange" | "red"
 *               natural: GDACS alert level · conflict: from fatalities
 *   title, country, location, severity, actors, notes — short display text
 *   fatalities — number | null (conflict only)
 *   lat, lng, time (ms since epoch), link (known-source https URL | null)
 * }
 */

const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10000;
const BROWSER_CACHE_SECONDS = 300;
const USER_AGENT = "Dossier-Map/1.0 (human-rights violations map)";

// ─────────────────────────────────────────────
// Tiny XML helpers (no DOMParser in Workers; the GDACS feed is simple)
// ─────────────────────────────────────────────

const decodeEntities = (text) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

const cleanText = (raw) => {
  if (raw == null) return "";
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return (cdata ? cdata[1] : decodeEntities(raw)).trim();
};

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Text content of the first <tag>…</tag> in `block`, or "" if absent. */
export const getTag = (block, tag) => {
  const m = block.match(
    new RegExp(`<${escapeRegExp(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeRegExp(tag)}>`),
  );
  return m ? cleanText(m[1]) : "";
};

/** Value of an attribute on the first <tag …> in `block`. */
const getAttr = (block, tag, attr) => {
  const m = block.match(
    new RegExp(`<${escapeRegExp(tag)}\\s[^>]*?${escapeRegExp(attr)}="([^"]*)"`),
  );
  return m ? decodeEntities(m[1]) : "";
};

const toTime = (value) => {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
};

const validCoords = (lat, lng) =>
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180 &&
  !(lat === 0 && lng === 0);

// ─────────────────────────────────────────────
// GDACS (natural hazards)
// ─────────────────────────────────────────────

// Drought (DR) is left out on purpose: a months-long, area-wide condition,
// not a point event.
const GDACS_TYPES = new Set(["EQ", "TC", "FL", "VO", "WF", "TS"]);
const GDACS_LINK_PREFIX = "https://www.gdacs.org/";
const GDACS_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;
const GDACS_MAX_EVENTS = 400;

export function parseGdacsRss(xml, { now = Date.now() } = {}) {
  if (typeof xml !== "string") return [];
  const events = new Map();

  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = match[1];

    const type = getTag(item, "gdacs:eventtype").toUpperCase();
    if (!GDACS_TYPES.has(type)) continue;

    let lat = parseFloat(getTag(item, "geo:lat"));
    let lng = parseFloat(getTag(item, "geo:long"));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      [lat, lng] = getTag(item, "georss:point").split(/\s+/).map(parseFloat);
    }
    if (!validCoords(lat, lng)) continue;

    const eventId = getTag(item, "gdacs:eventid");
    if (!eventId) continue;

    const started =
      toTime(getTag(item, "gdacs:fromdate")) ?? toTime(getTag(item, "pubDate"));
    const lastSeen = Math.max(
      ...[
        toTime(getTag(item, "gdacs:todate")),
        toTime(getTag(item, "gdacs:datemodified")),
        toTime(getTag(item, "pubDate")),
        started,
      ].filter((t) => t !== null),
    );
    if (started === null || !Number.isFinite(lastSeen)) continue;
    if (now - lastSeen > GDACS_MAX_AGE_MS) continue;

    const levelRaw = (
      getTag(item, "gdacs:alertlevel") || getTag(item, "gdacs:episodealertlevel")
    ).toLowerCase();
    const level = ["red", "orange", "green"].includes(levelRaw) ? levelRaw : "green";

    const link = getTag(item, "link");

    const event = {
      id: `gdacs:${type}${eventId}`,
      source: "gdacs",
      category: "natural",
      type,
      level,
      title: getTag(item, "title").slice(0, 200),
      country: getTag(item, "gdacs:country").slice(0, 80),
      location: "",
      severity: (getTag(item, "gdacs:severity") || getAttr(item, "gdacs:severity", "value"))
        .slice(0, 120),
      actors: "",
      notes: "",
      fatalities: null,
      lat,
      lng,
      time: started,
      link: link.startsWith(GDACS_LINK_PREFIX) ? link : null,
    };

    // One entry per event; keep the most recently seen one.
    const previous = events.get(event.id);
    if (!previous || lastSeen >= previous.lastSeen) {
      events.set(event.id, { event, lastSeen });
    }
  }

  return [...events.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, GDACS_MAX_EVENTS)
    .map(({ event }) => event);
}

async function fetchGdacs(_env, { fetchImpl, now }) {
  const res = await fetchImpl("https://www.gdacs.org/xml/rss.xml", {
    headers: {
      Accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseGdacsRss(await readLimited(res), { now });
}

// ─────────────────────────────────────────────
// ACLED (conflict events) — optional, needs credentials
// ─────────────────────────────────────────────
//
// HOW IT WORKS (per ACLED's API documentation):
//   1. POST https://acleddata.com/oauth/token  (form-encoded:
//      username=<myACLED email>, password, grant_type=password,
//      client_id=acled, scope=authenticated) → a Bearer token valid 24 h.
//   2. GET  https://acleddata.com/api/acled/read?_format=json&
//      event_date=<from>|<to>&event_date_where=BETWEEN&fields=…&limit=…
//
// REQUIREMENTS / LIMITS you must check on your own account:
//   • The API is only included in ACLED's Research / Partner / Enterprise
//     access levels — NOT in "Open" (which is what a gmail.com-style address
//     gets automatically). Ask ACLED for access for your organisation.
//   • ACLED's event data is published weekly, and some levels get it with a
//     time lag, so this is "recent", not real-time. If your level has a lag
//     longer than ACLED_DAYS, the layer will simply be empty.
//   • ACLED's terms require attribution and restrict some secondary uses;
//     read the EULA / Attribution Policy before showing its events publicly.
//
// CONFIG (Worker secrets / env):
//   ACLED_EMAIL, ACLED_PASSWORD   required
//   ACLED_DAYS                    look-back window in days (default 14)
//   ACLED_ENABLED=false           switch it off without removing the secrets

const ACLED_TOKEN_URL = "https://acleddata.com/oauth/token";
const ACLED_READ_URL = "https://acleddata.com/api/acled/read";
const ACLED_DEFAULT_DAYS = 14;
const ACLED_MAX_EVENTS = 500;
const ACLED_FIELDS = [
  "event_id_cnty",
  "event_date",
  "event_type",
  "sub_event_type",
  "actor1",
  "actor2",
  "country",
  "admin1",
  "location",
  "latitude",
  "longitude",
  "geo_precision",
  "fatalities",
  "notes",
];

// Event types shown on the map. Protests, riots and "strategic developments"
// are left out: thousands per week, mostly non-violent, would drown the map.
const ACLED_TYPES = {
  Battles: "BAT",
  "Violence against civilians": "VAC",
  "Explosions/Remote violence": "EXP",
};

export const acledConfigured = (env) =>
  Boolean(env?.ACLED_EMAIL && env?.ACLED_PASSWORD) && env?.ACLED_ENABLED !== "false";

const levelFromFatalities = (n) => (n >= 10 ? "red" : n >= 1 ? "orange" : "green");

export function parseAcledJson(payload, { now = Date.now() } = {}) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const events = [];

  for (const row of rows) {
    const type = ACLED_TYPES[row?.event_type];
    if (!type) continue;

    const lat = parseFloat(row.latitude);
    const lng = parseFloat(row.longitude);
    if (!validCoords(lat, lng)) continue;
    // geo_precision 3 = only a region/area is known: a pin would be misleading.
    if (String(row.geo_precision) === "3") continue;

    const time = toTime(row.event_date);
    if (time === null || time > now + 24 * 60 * 60 * 1000) continue;
    if (!row.event_id_cnty) continue;

    const fatalities = Number.isFinite(Number(row.fatalities)) ? Number(row.fatalities) : 0;
    const actors = [row.actor1, row.actor2].filter(Boolean).join(" / ");

    events.push({
      id: `acled:${row.event_id_cnty}`,
      source: "acled",
      category: "conflict",
      type,
      level: levelFromFatalities(fatalities),
      title: String(row.sub_event_type || row.event_type).slice(0, 120),
      country: String(row.country || "").slice(0, 80),
      location: [row.location, row.admin1].filter(Boolean).join(", ").slice(0, 120),
      severity: "",
      actors: actors.slice(0, 200),
      notes: String(row.notes || "").slice(0, 300),
      fatalities,
      lat,
      lng,
      time,
      link: null,
    });
  }

  // Deadliest first, then newest; keep the map readable.
  return events
    .sort((a, b) => b.fatalities - a.fatalities || b.time - a.time)
    .slice(0, ACLED_MAX_EVENTS);
}

// One OAuth token is reused for its lifetime (per Worker isolate).
let acledToken = { value: null, expiresAt: 0 };
export const resetAcledTokenCache = () => {
  acledToken = { value: null, expiresAt: 0 };
};

async function getAcledToken(env, { fetchImpl, now }) {
  if (acledToken.value && acledToken.expiresAt - 60_000 > now) return acledToken.value;

  const res = await fetchImpl(ACLED_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      username: env.ACLED_EMAIL,
      password: env.ACLED_PASSWORD,
      grant_type: "password",
      client_id: "acled",
      scope: "authenticated",
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  // Never include the response body or credentials in the error text.
  if (!res.ok) throw new Error(`ACLED login failed (HTTP ${res.status})`);
  const data = await res.json();
  if (!data?.access_token) throw new Error("ACLED login failed (no token)");

  const lifetimeMs = (Number(data.expires_in) || 3600) * 1000;
  acledToken = { value: data.access_token, expiresAt: now + lifetimeMs };
  return acledToken.value;
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function fetchAcled(env, { fetchImpl, now }) {
  const days = Math.min(Math.max(parseInt(env.ACLED_DAYS, 10) || ACLED_DEFAULT_DAYS, 1), 90);
  const token = await getAcledToken(env, { fetchImpl, now });

  const url = new URL(ACLED_READ_URL);
  url.search = new URLSearchParams({
    _format: "json",
    event_date: `${isoDay(now - days * 86400_000)}|${isoDay(now)}`,
    event_date_where: "BETWEEN",
    fields: ACLED_FIELDS.join("|"),
    limit: "5000",
  }).toString();

  const res = await fetchImpl(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    resetAcledTokenCache(); // maybe expired early; log in again next time
    throw new Error(`ACLED refused the request (HTTP ${res.status})`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const payload = JSON.parse(await readLimited(res));
  return parseAcledJson(payload, { now });
}

// ─────────────────────────────────────────────
// Source registry
// ─────────────────────────────────────────────

// ttl = how long (seconds) a successful result is cached at the edge.
export const FEED_SOURCES = [
  { id: "gdacs", ttl: 600, enabled: () => true, load: fetchGdacs },
  { id: "acled", ttl: 6 * 3600, enabled: acledConfigured, load: fetchAcled },
];

// ─────────────────────────────────────────────
// Request handler
// ─────────────────────────────────────────────

async function readLimited(res) {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_UPSTREAM_BYTES) throw new Error("response too large");
  const text = await res.text();
  if (text.length > MAX_UPSTREAM_BYTES) throw new Error("response too large");
  return text;
}

async function loadSource(source, env, { fetchImpl, now, edgeCache, ctx, origin }) {
  const cacheKey = new Request(`${origin}/api/events/${source.id}`, { method: "GET" });

  if (edgeCache) {
    const hit = await edgeCache.match(cacheKey);
    if (hit) {
      try {
        return { ok: true, events: await hit.json(), cached: true };
      } catch {
        /* unreadable cache entry: fall through and reload */
      }
    }
  }

  try {
    const events = await source.load(env, { fetchImpl, now });
    if (edgeCache) {
      const store = edgeCache.put(
        cacheKey,
        new Response(JSON.stringify(events), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${source.ttl}`,
          },
        }),
      );
      if (ctx?.waitUntil) ctx.waitUntil(store);
      else await store;
    }
    return { ok: true, events, cached: false };
  } catch (err) {
    return {
      ok: false,
      events: [],
      error: err?.name === "TimeoutError" ? "timeout" : String(err?.message || err),
    };
  }
}

/**
 * GET /api/events
 * → { generatedAt, sources: { gdacs: { ok, count, error? }, acled: {...} }, events }
 *
 * Always answers 200 so a failing source never breaks the map; the
 * per-source status says what happened. Each source is cached separately
 * (successful results only), so an outage is retried on the next request.
 * Sources that are not configured (ACLED without credentials) are reported
 * as { enabled: false } and never contacted.
 */
export async function handleEvents(
  request,
  ctx,
  { env = {}, fetchImpl = globalThis.fetch, now = Date.now(), cache } = {},
) {
  const edgeCache =
    cache === undefined ? (typeof caches !== "undefined" ? caches.default : null) : cache;
  const origin = new URL(request.url).origin;

  const sources = {};
  const events = [];

  const results = await Promise.all(
    FEED_SOURCES.map(async (source) => {
      if (!source.enabled(env)) return { source, skipped: true };
      return {
        source,
        ...(await loadSource(source, env, { fetchImpl, now, edgeCache, ctx, origin })),
      };
    }),
  );

  let allOk = true;
  for (const r of results) {
    if (r.skipped) {
      sources[r.source.id] = { enabled: false };
      continue;
    }
    if (!r.ok) allOk = false;
    sources[r.source.id] = {
      ok: r.ok,
      count: r.events.length,
      ...(r.error ? { error: r.error } : {}),
    };
    events.push(...r.events);
  }

  return new Response(
    JSON.stringify({ generatedAt: new Date(now).toISOString(), sources, events }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        // Public, read-only data: the DAO app (another origin) reads it too.
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": allOk ? `public, max-age=${BROWSER_CACHE_SECONDS}` : "no-store",
      },
    },
  );
}
