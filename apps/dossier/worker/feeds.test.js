// worker/feeds.test.js
// Run with:  node --test worker/feeds.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGdacsRss,
  parseAcledJson,
  handleEvents,
  getTag,
  acledConfigured,
  resetAcledTokenCache,
} from "./feeds.js";
import worker from "./index.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");

// Modelled on the structure of a real GDACS RSS item.
const item = ({
  type = "EQ",
  id = "1001",
  level = "Orange",
  lat = "38.2",
  lng = "37.1",
  from = "Mon, 26 Oct 2026 08:00:00 GMT",
  to = "Mon, 26 Oct 2026 08:00:00 GMT",
  title = "Orange earthquake alert in Turkey",
  country = "Turkey",
  link = "https://www.gdacs.org/report.aspx?eventtype=EQ&amp;eventid=1001",
  extra = "",
} = {}) => `
<item>
  <title>${title}</title>
  <description>desc</description>
  <link>${link}</link>
  <pubDate>${from}</pubDate>
  <gdacs:fromdate>${from}</gdacs:fromdate>
  <gdacs:todate>${to}</gdacs:todate>
  <gdacs:datemodified>${to}</gdacs:datemodified>
  <geo:Point><geo:lat>${lat}</geo:lat><geo:long>${lng}</geo:long></geo:Point>
  <georss:point>${lat} ${lng}</georss:point>
  <gdacs:eventtype>${type}</gdacs:eventtype>
  <gdacs:eventid>${id}</gdacs:eventid>
  <gdacs:alertlevel>${level}</gdacs:alertlevel>
  <gdacs:severity unit="M" value="6.1">Magnitude 6.1M, Depth:10km</gdacs:severity>
  <gdacs:country>${country}</gdacs:country>
  ${extra}
</item>`;
const feed = (...items) =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>GDACS</title>${items.join("")}</channel></rss>`;

test("getTag reads plain, CDATA and entity-encoded text", () => {
  assert.equal(getTag("<a>x &amp; y</a>", "a"), "x & y");
  assert.equal(getTag("<a><![CDATA[<b>hi</b>]]></a>", "a"), "<b>hi</b>");
  assert.equal(getTag('<gdacs:severity unit="M" value="6">M6</gdacs:severity>', "gdacs:severity"), "M6");
  assert.equal(getTag("<a>1</a>", "missing"), "");
});

test("parses coordinates, level, type, country, link and time", () => {
  const [e] = parseGdacsRss(feed(item()), { now: NOW });
  assert.equal(e.id, "gdacs:EQ1001");
  assert.equal(e.type, "EQ");
  assert.equal(e.level, "orange");
  assert.equal(e.lat, 38.2);
  assert.equal(e.lng, 37.1);
  assert.equal(e.country, "Turkey");
  assert.equal(e.time, Date.parse("2026-10-26T08:00:00Z"));
  assert.equal(e.link, "https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1001");
  assert.match(e.severity, /Magnitude 6\.1M/);
});

test("drought, bad coordinates, missing id and old events are dropped", () => {
  const events = parseGdacsRss(
    feed(
      item({ type: "DR", id: "1" }),
      item({ id: "2", lat: "abc" }),
      item({ id: "3", lat: "95" }),
      item({ id: "", }),
      item({ id: "4", from: "Mon, 01 Sep 2026 08:00:00 GMT", to: "Mon, 01 Sep 2026 08:00:00 GMT" }),
      item({ id: "5" }),
    ),
    { now: NOW },
  );
  assert.deepEqual(events.map((e) => e.id), ["gdacs:EQ5"]);
});

test("a long-running event stays while its end date is recent", () => {
  const events = parseGdacsRss(
    feed(item({ type: "FL", id: "9", from: "Mon, 01 Sep 2026 08:00:00 GMT", to: "Mon, 26 Oct 2026 08:00:00 GMT" })),
    { now: NOW },
  );
  assert.equal(events.length, 1);
});

test("a link that is not on gdacs.org is discarded; unknown level falls back to green", () => {
  const [e] = parseGdacsRss(
    feed(item({ link: "javascript:alert(1)", level: "Purple" })),
    { now: NOW },
  );
  assert.equal(e.link, null);
  assert.equal(e.level, "green");
});

test("georss:point is used when geo:Point is missing; duplicate events are merged", () => {
  const noGeo = item({ id: "7" }).replace(/<geo:Point>.*<\/geo:Point>/, "");
  const [a] = parseGdacsRss(feed(noGeo), { now: NOW });
  assert.equal(a.lat, 38.2);
  const dup = parseGdacsRss(feed(item({ id: "8", level: "Green" }), item({ id: "8", level: "Red", to: "Tue, 27 Oct 2026 06:00:00 GMT" })), { now: NOW });
  assert.equal(dup.length, 1);
  assert.equal(dup[0].level, "red");
});

test("garbage input never throws", () => {
  assert.deepEqual(parseGdacsRss("", { now: NOW }), []);
  assert.deepEqual(parseGdacsRss(null, { now: NOW }), []);
  assert.deepEqual(parseGdacsRss("<html>blocked</html>", { now: NOW }), []);
});

// ── ACLED parsing ───────────────────────────────────────────────────────
const acledRow = (over = {}) => ({
  event_id_cnty: "UKR100",
  event_date: "2026-10-20",
  event_type: "Explosions/Remote violence",
  sub_event_type: "Shelling/artillery/missile attack",
  actor1: "Military Forces of Russia",
  actor2: "Civilians (Ukraine)",
  country: "Ukraine",
  admin1: "Kharkiv",
  location: "Kharkiv",
  latitude: "49.99",
  longitude: "36.23",
  geo_precision: "1",
  fatalities: "3",
  notes: "A <b>strike</b> hit a residential area.",
  ...over,
});

test("ACLED rows are normalised; level comes from fatalities", () => {
  const events = parseAcledJson(
    { status: 200, data: [acledRow(), acledRow({ event_id_cnty: "B", fatalities: "12" }), acledRow({ event_id_cnty: "C", fatalities: "0" })] },
    { now: NOW },
  );
  assert.deepEqual(events.map((e) => e.id), ["acled:B", "acled:UKR100", "acled:C"]); // deadliest first
  assert.deepEqual(events.map((e) => e.level), ["red", "orange", "green"]);
  const e = events[1];
  assert.equal(e.source, "acled");
  assert.equal(e.category, "conflict");
  assert.equal(e.type, "EXP");
  assert.equal(e.lat, 49.99);
  assert.equal(e.fatalities, 3);
  assert.equal(e.location, "Kharkiv, Kharkiv");
  assert.equal(e.actors, "Military Forces of Russia / Civilians (Ukraine)");
  assert.equal(e.time, Date.parse("2026-10-20"));
});

test("ACLED: protests, region-level or invalid locations and future dates are dropped", () => {
  const events = parseAcledJson(
    {
      data: [
        acledRow({ event_id_cnty: "P", event_type: "Protests" }),
        acledRow({ event_id_cnty: "G", geo_precision: "3" }),
        acledRow({ event_id_cnty: "L", latitude: "x" }),
        acledRow({ event_id_cnty: "F", event_date: "2027-03-01" }),
        acledRow({ event_id_cnty: "", }),
        acledRow({ event_id_cnty: "OK", event_type: "Violence against civilians" }),
        acledRow({ event_id_cnty: "BAT", event_type: "Battles" }),
      ],
    },
    { now: NOW },
  );
  assert.deepEqual(events.map((e) => e.id).sort(), ["acled:BAT", "acled:OK"]);
});

test("ACLED: malformed payloads never throw", () => {
  assert.deepEqual(parseAcledJson(null), []);
  assert.deepEqual(parseAcledJson({ data: "nope" }), []);
  assert.deepEqual(parseAcledJson({ data: [null, 1, "x"] }, { now: NOW }), []);
});

test("ACLED is only enabled with credentials and can be switched off", () => {
  assert.equal(acledConfigured({}), false);
  assert.equal(acledConfigured({ ACLED_EMAIL: "a@b.org" }), false);
  assert.equal(acledConfigured({ ACLED_EMAIL: "a@b.org", ACLED_PASSWORD: "p" }), true);
  assert.equal(acledConfigured({ ACLED_EMAIL: "a@b.org", ACLED_PASSWORD: "p", ACLED_ENABLED: "false" }), false);
});

// ── request handler ─────────────────────────────────────────────────────
const req = () => new Request("https://dossier.example/api/events");
const memoryCache = () => {
  const store = new Map();
  return {
    store,
    match: async (k) => store.get(k.url)?.clone(),
    put: async (k, r) => void store.set(k.url, r),
  };
};
/** Fake upstream: routes by URL; records every call. */
const upstream = (routes) => {
  const calls = [];
  const fn = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    for (const [needle, respond] of Object.entries(routes)) {
      if (String(url).includes(needle)) return respond(url, options);
    }
    return new Response("not found", { status: 404 });
  };
  fn.calls = calls;
  return fn;
};
const gdacsOk = () => new Response(feed(item()), { status: 200 });

test("handler returns normalised events, caches per source, ACLED reported as disabled", async () => {
  const cache = memoryCache();
  const fetchImpl = upstream({ "gdacs.org": gdacsOk });

  const res = await handleEvents(req(), null, { fetchImpl, now: NOW, cache, env: {} });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.sources.gdacs.ok, true);
  assert.deepEqual(body.sources.acled, { enabled: false });
  assert.equal(body.events.length, 1);

  const again = await handleEvents(req(), null, { fetchImpl, now: NOW, cache, env: {} });
  assert.equal((await again.json()).events.length, 1);
  assert.equal(fetchImpl.calls.length, 1, "second request is served from the cache");
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes("acleddata")), "ACLED is never contacted without credentials");
});

test("an upstream failure answers 200 with an empty list and is NOT cached", async () => {
  const cache = memoryCache();
  const fetchImpl = upstream({ "gdacs.org": () => new Response("nope", { status: 503 }) });
  const res = await handleEvents(req(), null, { fetchImpl, now: NOW, cache, env: {} });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.sources.gdacs.ok, false);
  assert.equal(body.sources.gdacs.error, "HTTP 503");
  assert.deepEqual(body.events, []);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.equal(cache.store.size, 0);
});

test("a network error is reported, not thrown", async () => {
  const fetchImpl = async () => { throw new Error("boom"); };
  const res = await handleEvents(req(), null, { fetchImpl, now: NOW, cache: null, env: {} });
  assert.equal((await res.json()).sources.gdacs.error, "boom");
});

const ACLED_ENV = { ACLED_EMAIL: "team@org.example", ACLED_PASSWORD: "s3cret" };
const acledRoutes = (extra = {}) => ({
  "gdacs.org": gdacsOk,
  "acleddata.com/oauth/token": () =>
    new Response(JSON.stringify({ access_token: "TOKEN-1", expires_in: 86400 }), { status: 200 }),
  "acleddata.com/api/acled/read": () =>
    new Response(JSON.stringify({ status: 200, data: [acledRow()] }), { status: 200 }),
  ...extra,
});

test("ACLED: logs in with the documented form, then reads events with the Bearer token", async () => {
  resetAcledTokenCache();
  const fetchImpl = upstream(acledRoutes());
  const res = await handleEvents(req(), null, { fetchImpl, now: NOW, cache: null, env: ACLED_ENV });
  const body = await res.json();

  assert.equal(body.sources.acled.ok, true);
  assert.equal(body.events.filter((e) => e.source === "acled").length, 1);

  const login = fetchImpl.calls.find((c) => c.url.includes("oauth/token"));
  const form = new URLSearchParams(String(login.options.body));
  assert.equal(form.get("grant_type"), "password");
  assert.equal(form.get("client_id"), "acled");
  assert.equal(form.get("scope"), "authenticated");
  assert.equal(form.get("username"), "team@org.example");

  const read = fetchImpl.calls.find((c) => c.url.includes("api/acled/read"));
  assert.equal(read.options.headers.Authorization, "Bearer TOKEN-1");
  const q = new URL(read.url).searchParams;
  assert.equal(q.get("_format"), "json");
  assert.equal(q.get("event_date_where"), "BETWEEN");
  assert.match(q.get("event_date"), /^2026-10-13\|2026-10-27$/); // default 14-day window
  assert.match(q.get("fields"), /latitude\|longitude/);
});

test("ACLED: the token is reused; a failed login is reported without leaking credentials", async () => {
  resetAcledTokenCache();
  const fetchImpl = upstream(acledRoutes());
  await handleEvents(req(), null, { fetchImpl, now: NOW, cache: null, env: ACLED_ENV });
  await handleEvents(req(), null, { fetchImpl, now: NOW + 1000, cache: null, env: ACLED_ENV });
  assert.equal(fetchImpl.calls.filter((c) => c.url.includes("oauth/token")).length, 1);

  resetAcledTokenCache();
  const failing = upstream(acledRoutes({
    "acleddata.com/oauth/token": () => new Response("denied: s3cret", { status: 401 }),
  }));
  const res = await handleEvents(req(), null, { fetchImpl: failing, now: NOW, cache: null, env: ACLED_ENV });
  const raw = await res.text();
  const body = JSON.parse(raw);
  assert.equal(body.sources.acled.ok, false);
  assert.equal(body.sources.acled.error, "ACLED login failed (HTTP 401)");
  assert.ok(!raw.includes("s3cret") && !raw.includes("team@org.example"));
  assert.equal(body.sources.gdacs.ok, true, "GDACS still works when ACLED fails");
  assert.equal(body.events.length, 1);
});

test("the Worker routes GET /api/events (with security headers), other methods fall through", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = upstream({ "gdacs.org": gdacsOk });
  try {
    const env = { ASSETS: { fetch: async () => new Response("spa", { headers: { "Content-Type": "text/html" } }) } };
    const res = await worker.fetch(new Request("https://dossier.example/api/events"), env, {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal((await res.json()).events.length, 1);

    const post = await worker.fetch(new Request("https://dossier.example/api/events", { method: "POST" }), env, {});
    assert.equal(await post.text(), "spa");
  } finally {
    globalThis.fetch = original;
  }
});
