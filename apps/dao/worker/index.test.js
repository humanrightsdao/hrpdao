// worker/index.test.js — the AI moderation route added to dao's own Worker.
// Run with:  node --test worker/index.test.js
//
// dao's Worker also serves /api/chat, /verify-captcha, etc. — those are
// untouched by this change and are not re-tested here; this file covers
// only what was ADDED: /api/moderate and its bit of /api/health.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "./index.js";

const ORIGIN = "https://dao.example";
const URL_MODERATE = `${ORIGIN}/api/moderate`;

let ipCounter = 0;
const freshIp = () => `203.0.113.${++ipCounter}`; // limiter state is module-level → unique IP per test

function req(body, { ip = freshIp(), origin = ORIGIN, method = "POST", raw = false } = {}) {
  const headers = { "Content-Type": "application/json", "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  return new Request(URL_MODERATE, { method, headers, body: raw ? body : JSON.stringify(body) });
}

const assets = { fetch: async () => new Response("<html>spa</html>", { headers: { "Content-Type": "text/html" } }) };
const env = (extra = {}) => ({ GEMINI_API_KEY: "k-chat", ASSETS: assets, ...extra });

// Silence the text-free "🛡️ moderation: …" log line — Node's test runner
// reads the same stdout stream for its own protocol (see dossier's
// worker/index.test.js for the same fix and why it's needed).
const realLog = console.log;
console.log = (...args) => {
  if (String(args[0]).startsWith("🛡️")) return;
  realLog(...args);
};

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

test("POST /api/moderate: proposal and forum kinds are accepted, verdicts returned with ids", async () => {
  const calls = mockGemini((body) =>
    JSON.stringify({
      results: [
        { id: "0", severity: 0, confidence: 0.95, categories: [], reason: "" },
        { id: "1", severity: 2, confidence: 0.9, categories: ["threats_violence"], reason: "credible threat" },
      ],
    }),
  );
  try {
    const res = await worker.fetch(
      req({
        items: [
          { id: "p1", kind: "proposal", text: "Propose repealing the outdated travel-grant policy." },
          { id: "p2", kind: "forum_thread", text: "hateful threat text" },
        ],
      }),
      env(),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const data = await res.json();
    assert.equal(data.success, true);
    assert.deepEqual(data.results.map((r) => [r.id, r.verdict]), [["p1", "allow"], ["p2", "block"]]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].key, "k-chat");
  } finally {
    calls.restore();
  }
});

test("rule-decided items (e.g. seed-phrase phishing in a forum post) never reach Gemini", async () => {
  const calls = mockGemini();
  try {
    const res = await worker.fetch(req({ text: "please send your seed phrase to claim the prize", kind: "forum_reply" }), env());
    const data = await res.json();
    assert.equal(data.results[0].verdict, "block");
    assert.equal(data.results[0].source, "rules");
    assert.equal(calls.length, 0);
  } finally {
    calls.restore();
  }
});

test("foreign Origin is rejected; same-origin passes", async () => {
  const calls = mockGemini();
  try {
    const bad = await worker.fetch(req({ text: "hello world friend" }, { origin: "https://evil.example" }), env());
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).error, "forbidden_origin");

    const ok = await worker.fetch(req({ text: "hello world friend" }), env());
    assert.equal(ok.status, 200);
  } finally {
    calls.restore();
  }
});

test("input validation: bad JSON, missing items, too many items", async () => {
  assert.equal((await worker.fetch(req("{not json", { raw: true }), env())).status, 400);
  assert.equal((await worker.fetch(req({}), env())).status, 400);
  const many = await worker.fetch(req({ items: Array.from({ length: 21 }, () => ({ text: "x" })) }), env());
  assert.equal(many.status, 413);
});

test("per-IP rate limit counts ITEMS and answers 429 with Retry-After", async () => {
  const ip = freshIp();
  const items = Array.from({ length: 20 }, () => ({ text: "send your seed phrase to claim", kind: "forum_reply" })); // rules → no upstream
  let last;
  let okCount = 0;
  for (let i = 0; i < 13; i++) {
    last = await worker.fetch(req({ items }, { ip }), env());
    if (last.status === 200) okCount++;
  }
  assert.equal(okCount, 12); // 12 × 20 = 240 items/min
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get("Retry-After")) >= 1);

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

test("Gemini outage → 200 with degraded allow (never blocks the route from responding)", async () => {
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

test("/api/health reports moderation status without leaking secrets", async () => {
  const res = await worker.fetch(new Request(`${ORIGIN}/api/health`), env({ GEMINI_MODERATION_API_KEY: "secret-mod-key" }));
  const text = await res.text();
  const data = JSON.parse(text);
  assert.equal(data.status, "ok");
  assert.equal(data.moderation.enabled, true);
  assert.equal(data.moderation.configured, true);
  assert.doesNotMatch(text, /secret-mod-key|k-chat/);
});

test("existing routes are untouched: chat guard and static fallthrough", async () => {
  const chat = await worker.fetch(
    new Request(`${ORIGIN}/api/chat`, { method: "POST", body: JSON.stringify({ message: "hi" }) }),
    { ASSETS: assets }, // no GEMINI_API_KEY
  );
  assert.equal(chat.status, 500);

  const page = await worker.fetch(new Request(`${ORIGIN}/some/spa/route`), env());
  assert.equal(page.status, 200);
  assert.match(await page.text(), /spa/);
});
