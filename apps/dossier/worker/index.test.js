// worker/index.test.js
// Run with:  node --test worker/index.test.js
//
// Exercises the real Worker `fetch` handler with a fake Gemini upstream.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";
import { MEDIA_LIMITS } from "./moderation.js";

// The Worker logs a text-free "🛡️ moderation: …" line per request (visible with
// `wrangler tail`). Keep it out of the test output: Node's test runner reads
// the same stdout stream and chokes on unexpected multi-byte output.
const realLog = console.log;
console.log = (...args) => {
  if (String(args[0]).startsWith("🛡️")) return;
  realLog(...args);
};

const ORIGIN = "https://dossier.example";
const URL_MODERATE = `${ORIGIN}/api/moderate`;
const URL_MEDIA = `${ORIGIN}/api/moderate/media`;

let ipCounter = 0;
const freshIp = () => `203.0.113.${++ipCounter}`; // limiter state is module-level → unique IP per test

function req(body, { ip = freshIp(), origin = ORIGIN, method = "POST", raw = false } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  return new Request(URL_MODERATE, { method, headers, body: raw ? body : JSON.stringify(body) });
}

const assets = { fetch: async () => new Response("<html>spa</html>", { headers: { "Content-Type": "text/html" } }) };
const env = (extra = {}) => ({ GEMINI_API_KEY: "k-chat", ASSETS: assets, ...extra });

/** Installs a fake Gemini upstream; returns the recorded calls. */
function mockGemini(responder) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), key: options.headers["x-goog-api-key"], body });
    const text = responder ? responder(body, calls.length - 1) : null;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  text:
                    text ??
                    JSON.stringify({
                      results: (body.contents[0].parts[0].text.match(/<item id="(\d+)"/g) || []).map((m) => ({
                        id: m.match(/\d+/)[0],
                        severity: 0,
                        confidence: 0.95,
                        categories: [],
                        reason: "",
                      })),
                    }),
                },
              ],
            },
          },
        ],
      }),
      { status: 200 },
    );
  };
  calls.restore = () => (globalThis.fetch = original);
  return calls;
}

test("POST /api/moderate → verdicts with ids, no-store, security headers", async () => {
  const calls = mockGemini((body) =>
    JSON.stringify({
      results: [
        { id: "0", severity: 0, confidence: 0.95, categories: [], reason: "" },
        { id: "1", severity: 2, confidence: 0.92, categories: ["hate_speech"], reason: "slur" },
      ],
    }),
  );
  try {
    const res = await worker.fetch(
      req({ items: [{ id: "c1", kind: "comment", text: "The police beat me." }, { id: "c2", kind: "comment", text: "hateful stuff" }] }),
      env(),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.ok(res.headers.get("Strict-Transport-Security"), "goes through withSecurityHeaders");
    const data = await res.json();
    assert.equal(data.success, true);
    assert.deepEqual(data.results.map((r) => [r.id, r.verdict]), [["c1", "allow"], ["c2", "block"]]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, "k-chat");
  } finally {
    calls.restore();
  }
});

test("dedicated moderation key and model take priority over the chat ones", async () => {
  const calls = mockGemini();
  try {
    await worker.fetch(
      req({ text: "hello there my friend", kind: "comment" }),
      env({ GEMINI_MODERATION_API_KEY: "k-mod", MODERATION_MODEL: "flash-lite-x" }),
    );
    assert.equal(calls[0].key, "k-mod");
    assert.match(calls[0].url, /models\/flash-lite-x:generateContent/);
  } finally {
    calls.restore();
  }
});

test("rule-decided items never reach Gemini", async () => {
  const calls = mockGemini();
  try {
    const res = await worker.fetch(req({ text: "please send your seed phrase to claim", kind: "comment" }), env());
    const data = await res.json();
    assert.equal(data.results[0].verdict, "block");
    assert.equal(data.results[0].source, "rules");
    assert.equal(calls.length, 0);
  } finally {
    calls.restore();
  }
});

test("foreign Origin is rejected; same-origin and allow-listed origins pass", async () => {
  const calls = mockGemini();
  try {
    const bad = await worker.fetch(req({ text: "hello world friend" }, { origin: "https://evil.example" }), env());
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).error, "forbidden_origin");

    const extra = await worker.fetch(
      req({ text: "hello world friend" }, { origin: "https://staging.example" }),
      env({ MODERATION_ALLOWED_ORIGINS: "https://staging.example" }),
    );
    assert.equal(extra.status, 200);

    const none = await worker.fetch(req({ text: "hello world friend" }, { origin: null }), env());
    assert.equal(none.status, 200);
  } finally {
    calls.restore();
  }
});

test("input validation: bad JSON, missing items, too many items", async () => {
  const bad = await worker.fetch(req("{not json", { raw: true }), env());
  assert.equal(bad.status, 400);
  assert.equal((await worker.fetch(req({}), env())).status, 400);
  const many = await worker.fetch(req({ items: Array.from({ length: 21 }, () => ({ text: "x" })) }), env());
  assert.equal(many.status, 413);
});

test("per-IP rate limit counts ITEMS and answers 429 with Retry-After", async () => {
  const ip = freshIp();
  const items = Array.from({ length: 20 }, () => ({ text: "send your seed phrase to claim", kind: "comment" })); // rules → no upstream
  let last;
  let okCount = 0;
  for (let i = 0; i < 13; i++) {
    last = await worker.fetch(req({ items }, { ip }), env());
    if (last.status === 200) okCount++;
  }
  assert.equal(okCount, 12); // 12 × 20 = 240 items/min
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("Retry-After")) >= 1);
  assert.equal((await last.json()).error, "rate_limited");

  // another visitor is unaffected
  assert.equal((await worker.fetch(req({ items: [{ text: "hi there" }] }), env())).status, 200);
});

test("kill switch MODERATION_ENABLED=false → no verdicts, no upstream call", async () => {
  const calls = mockGemini();
  try {
    const res = await worker.fetch(req({ text: "send your seed phrase now" }), env({ MODERATION_ENABLED: "false" }));
    const data = await res.json();
    assert.equal(data.disabled, true);
    assert.deepEqual(data.results, []);
    assert.equal(calls.length, 0);
  } finally {
    calls.restore();
  }
});

test("no Gemini key at all → still 200, fails open (rules keep working)", async () => {
  const res = await worker.fetch(
    req({ items: [{ id: "a", text: "unique text for the no-key test" }, { id: "b", text: "send your seed phrase now" }] }),
    { ASSETS: assets },
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.results[0].verdict, "allow");
  assert.equal(data.results[0].degraded, true);
  assert.equal(data.results[1].verdict, "block");
});

test("Gemini outage → 200 with degraded allow (never blocks publishing)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("down", { status: 500 });
  try {
    const res = await worker.fetch(req({ text: "unique text for the outage test" }), env());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.results[0].verdict, "allow");
    assert.equal(data.results[0].degraded, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("MODERATION_KV: verdict is stored once and served from the cache afterwards", async () => {
  const store = new Map();
  const kv = {
    get: async (k, type) => (store.has(k) ? JSON.parse(store.get(k)) : null),
    put: async (k, v, opts) => {
      assert.ok(opts.expirationTtl >= 60);
      store.set(k, v);
    },
  };
  const calls = mockGemini(() => JSON.stringify({ results: [{ id: "0", severity: 1, confidence: 0.9, categories: ["spam"], reason: "boilerplate" }] }));
  try {
    const text = "Great initiative, keep it up everyone! kv-test-unique-1";
    const first = await (await worker.fetch(req({ text, kind: "comment" }), env({ MODERATION_KV: kv }))).json();
    assert.equal(first.results[0].source, "ai");
    assert.equal(store.size, 1);

    // Same content from a different "isolate" (fresh memory can't be simulated, but KV is what we assert on)
    const kvOnly = { ...kv };
    const second = await (await worker.fetch(req({ text, kind: "comment" }), env({ MODERATION_KV: kvOnly }))).json();
    assert.equal(second.results[0].source, "cache");
    assert.equal(calls.length, 1);
  } finally {
    calls.restore();
  }
});

test("/api/health reports moderation status without leaking secrets", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/health`), env({ GEMINI_MODERATION_API_KEY: "secret-mod-key" }));
  const text = await res.text();
  const data = JSON.parse(text);
  assert.equal(data.status, "ok");
  assert.equal(data.moderation.enabled, true);
  assert.equal(data.moderation.configured, true);
  assert.equal(data.moderation.sharedCache, false);
  assert.doesNotMatch(text, /secret-mod-key|k-chat/);
});

test("existing routes are untouched: chat guard, captcha, static fallthrough", async () => {
  const chat = await worker.fetch(
    new Request(`${ORIGIN}/api/chat`, { method: "POST", body: JSON.stringify({ message: "hi" }) }),
    { ASSETS: assets }, // no GEMINI_API_KEY
  );
  assert.equal(chat.status, 500);

  const captcha = await worker.fetch(
    new Request(`${ORIGIN}/verify-captcha`, { method: "POST", body: JSON.stringify({}) }),
    env(),
  );
  assert.equal(captcha.status, 400);

  const page = await worker.fetch(new Request(`${ORIGIN}/some/spa/route`), env());
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("Cache-Control"), "no-store"); // html rule preserved
  assert.match(await page.text(), /spa/);

  // GET on the moderation URL is not the API → falls through to assets, never crashes
  const get = await worker.fetch(new Request(URL_MODERATE), env());
  assert.equal(get.status, 200);
});


// ── media moderation route ──────────────────────────────────────────────────

const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// The media moderation cache is content-addressed and lives at module scope
// (mediaMemoryCache in worker/index.js), so identical bytes across tests would
// hit the cache from an EARLIER test instead of calling the mocked Gemini.
// A unique tail keeps each test's "file" distinct.
let imgSeq = 0;
const image = (id = "0") => ({
  id,
  kind: "image",
  parts: [{ mime: "image/png", data: PNG_1PX.slice(0, -4) + String(++imgSeq).padStart(4, "0") }],
});

function mediaReq(body, { ip = freshIp(), origin = ORIGIN } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  return new Request(URL_MEDIA, { method: "POST", headers, body: JSON.stringify(body) });
}

function mockGeminiMedia(severity = 0, categories = []) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify({ severity, confidence: 0.9, categories, reason: "x" }) }] } }] }),
      { status: 200 },
    );
  };
  return { restore: () => (globalThis.fetch = original), calls: () => calls };
}

test("POST /api/moderate/media: image is analysed, verdict returned with id", async () => {
  const g = mockGeminiMedia(0);
  try {
    const res = await worker.fetch(mediaReq({ items: [image("img1")] }), env());
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.results[0].id, "img1");
    assert.equal(data.results[0].verdict, "allow");
    assert.equal(g.calls(), 1);
  } finally {
    g.restore();
  }
});

test("media: a disguised file is blocked without calling Gemini", async () => {
  const g = mockGeminiMedia(0);
  try {
    const disguised = { id: "x", kind: "image", parts: [{ mime: "image/png", data: Buffer.from("not really a png file").toString("base64") }] };
    const res = await worker.fetch(mediaReq({ items: [disguised] }), env());
    const data = await res.json();
    assert.equal(data.results[0].verdict, "block");
    assert.equal(data.results[0].source, "rules");
    assert.equal(g.calls(), 0);
  } finally {
    g.restore();
  }
});

test("media: dedicated model override (MODERATION_MEDIA_MODEL) is used", async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: '{"severity":0,"confidence":1}' }] } }] }), { status: 200 });
  };
  try {
    await worker.fetch(mediaReq({ items: [image()] }), env({ MODERATION_MEDIA_MODEL: "media-flash" }));
    assert.match(calls[0], /models\/media-flash:generateContent/);
  } finally {
    globalThis.fetch = original;
  }
});

test("media: validation, origin, kill switch, and outage fails open", async () => {
  assert.equal((await worker.fetch(mediaReq({}), env())).status, 400);
  assert.equal((await worker.fetch(mediaReq({ items: [image()] }, { origin: "https://evil.example" }), env())).status, 403);

  const off = await worker.fetch(mediaReq({ items: [image()] }), env({ MODERATION_ENABLED: "false" }));
  assert.deepEqual((await off.json()).results, []);

  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("down", { status: 500 });
  try {
    const res = await worker.fetch(mediaReq({ items: [image()] }), env());
    const data = await res.json();
    assert.equal(data.results[0].degraded, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("media: rate limit is on BYTES per IP, not item count", async () => {
  const g = mockGeminiMedia(0);
  const ip = freshIp();
  try {
    // Just under the per-image cap (4MB decoded) so each request is accepted on
    // its own; ~4 requests already exceed the 60MB/min budget. Unique bytes per
    // request, since the moderation cache is content-addressed (identical bytes
    // would be served from cache — the rate limiter itself still runs either way,
    // but keeping requests distinct makes the byte counting easy to reason about).
    const bigBytes = MEDIA_LIMITS.maxImageBytes - 1024;
    const bigB64Len = Math.ceil(bigBytes / 3) * 4;
    const heavy = (n) => ({
      id: `h${n}`,
      kind: "image",
      parts: [{ mime: "image/png", data: "A".repeat(bigB64Len - 4) + String(n).padStart(4, "0") }],
    });
    let last;
    for (let i = 0; i < 18 && (!last || last.status !== 429); i++) {
      last = await worker.fetch(mediaReq({ items: [heavy(i)] }, { ip }), env());
    }
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get("Retry-After")) >= 1);
  } finally {
    g.restore();
  }
});

test("/api/health reports media moderation availability", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/health`), env());
  const data = await res.json();
  assert.equal(data.moderation.media, true);
});
