// aiScan.js (latest-content scan), the local activity log and the probe logic.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import i18n from "../../src/i18n";
import { scanLatestContent, linkFor } from "../../src/utils/aiScan";
import { buildProbes, interpretHealth, evaluateProbes } from "../../src/utils/moderationProbes";
import {
  _resetAIModerationState, _setModerationMode, recordAIActivity,
  checkBeforePublish, fetchVerdicts, getAIActivity, clearAIActivity,
} from "../../src/utils/aiModeration";

const realFetch = globalThis.fetch;
let calls;
let serverMode;

const classify = (text) => {
  if (/SCAM/.test(text)) return { verdict: "block", severity: 2, categories: ["scam_phishing"], confidence: 0.95, source: "ai", reason: "wallet drain" };
  if (/SPAMMY/.test(text)) return { verdict: "flag", severity: 1, categories: ["spam"], confidence: 0.85, source: "ai", reason: "boilerplate" };
  return { verdict: "allow", severity: 0, categories: [], confidence: 0.95, source: "ai" };
};

// a minimal in-memory localStorage (this test file runs without jsdom)
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

beforeEach(async () => {
  _resetAIModerationState();
  _setModerationMode({ strict: true });
  store.clear();
  await i18n.changeLanguage("en");
  calls = [];
  serverMode = "ok";
  delete globalThis.__fetchPosts;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (serverMode === "500") return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ success: true, results: body.items.map((it) => ({ id: it.id, ...classify(it.text) })) }), { status: 200 });
  };
});

const post = (id, content, extra = {}) => ({
  id, timestamp: "2026-09-20T10:00:00Z", metadata: { content, tags: [] },
  author: { username: { localName: "user" + id }, address: "0xabcdef123456" }, commentOn: null, ...extra,
});
const long = (s) => `${s} — long enough to be scanned by the client`;

// ── scan ───────────────────────────────────────────────────────────────────

test("scan: lists what the AI flagged, skips reports and moderation-log comments", async () => {
  globalThis.__fetchPosts = async () => ({
    items: [
      post("p1", long("A normal post about an arrest")),
      post("p2", long("SPAMMY visit my profile")),
      post("p3", long("SCAM claim your prize")),
      post("r1", "[HRDAO_REPORT] something"), // report comment → skipped
      post("m1", ""), // no text → skipped
    ],
  });
  const res = await scanLatestContent({ limit: 40 });
  assert.equal(res.scanned, 3);
  assert.equal(res.answered, 3);
  assert.deepEqual(res.flagged.map((f) => [f.id, f.result.verdict]), [["p2", "flag"], ["p3", "block"]]);
  assert.equal(res.flagged[0].author, "userp2");
});

test("scan: comments carry the parent's text as context and link to the parent", async () => {
  globalThis.__fetchPosts = async () => ({
    items: [post("c1", long("SPAMMY buy now"), { commentOn: { id: "parent1", metadata: { content: "Parent violation text", tags: ["violation"] } } })],
  });
  const res = await scanLatestContent();
  assert.equal(calls[0].items[0].kind, "comment");
  assert.equal(calls[0].items[0].context, "Parent violation text");
  assert.equal(res.flagged[0].link, "/violations/parent1");
});

test("linkFor: violation / help request / plain post", () => {
  assert.equal(linkFor({ id: "1", metadata: { tags: ["violation"] } }), "/violations/1");
  assert.equal(linkFor({ id: "2", metadata: { tags: ["help_request"] } }), "/help/2");
  assert.equal(linkFor({ id: "3", metadata: { tags: [] } }), "/post/3");
});

test("scan: follows pages until the limit, and stops without a cursor", async () => {
  let page = 0;
  globalThis.__fetchPosts = async (req) => {
    page++;
    if (page === 1) assert.equal(req.cursor, undefined);
    else assert.equal(req.cursor, `cursor${page - 1}`);
    const items = Array.from({ length: 5 }, (_, i) => post(`p${page}-${i}`, long(`item ${page}-${i}`)));
    return { items, next: page < 4 ? `cursor${page}` : null };
  };
  const res = await scanLatestContent({ limit: 12, maxPages: 5 });
  assert.equal(res.scanned, 12); // stops at the limit
  assert.equal(page, 3);
});

test("scan: an outage means answered=0, never a false 'all clear'", async () => {
  serverMode = "500";
  globalThis.__fetchPosts = async () => ({ items: [post("p1", long("SPAMMY one"))] });
  const res = await scanLatestContent();
  assert.equal(res.scanned, 1);
  assert.equal(res.answered, 0); // the panel turns this into "nothing could be checked"
  assert.equal(res.flagged.length, 0);
});

test("scan: a Lens error surfaces as an exception", async () => {
  globalThis.__fetchPosts = async () => ({ error: "Lens is down" });
  await assert.rejects(() => scanLatestContent(), /Lens is down/);
});

// ── activity log ───────────────────────────────────────────────────────────

test("activity: pre-publish checks are recorded WITHOUT any text", async () => {
  await checkBeforePublish({ text: long("SCAM claim your airdrop right now"), kind: "comment" });
  await checkBeforePublish({ text: long("A perfectly ordinary comment"), kind: "post" });
  const log = getAIActivity();
  assert.equal(log.length, 2);
  assert.deepEqual([log[0].stage, log[0].kind, log[0].verdict, log[0].blocked], ["publish", "post", "allow", false]);
  assert.deepEqual([log[1].kind, log[1].verdict, log[1].blocked, log[1].categories], ["comment", "block", true, ["scam_phishing"]]);
  assert.doesNotMatch(JSON.stringify(log), /airdrop|ordinary comment/i, "no user text is stored");
});

test("activity: an unavailable service is recorded, and says whether the draft was REFUSED", async () => {
  serverMode = "500";
  await checkBeforePublish({ text: long("Some comment while the service is down") }); // strict → refused
  _setModerationMode({ strict: false });
  await checkBeforePublish({ text: long("Another comment while the service is down") }); // open → published
  const [open, strict] = getAIActivity();
  assert.deepEqual([strict.unavailable, strict.refused, strict.verdict], [true, true, null]);
  assert.deepEqual([open.unavailable, open.refused], [true, false]);
});

test("activity: pre-publish entries carry how long the check took; the panel can add its own entries", async () => {
  await checkBeforePublish({ text: long("A normal comment") });
  recordAIActivity({ stage: "selfcheck", summary: "ok", ms: 1234 });
  recordAIActivity({ stage: "scan", scanned: 17, answered: 17, flagged: 0, ms: 2500 });
  const log = getAIActivity();
  assert.deepEqual(log.map((e) => e.stage), ["scan", "selfcheck", "publish"]);
  assert.equal(typeof log[2].ms, "number");
  assert.deepEqual([log[0].scanned, log[0].flagged, log[1].summary], [17, 0, "ok"]);
});

test("activity: short texts are not logged; flagged displays are logged once", async () => {
  await checkBeforePublish({ text: "thanks" });
  assert.equal(getAIActivity().length, 0);

  await fetchVerdicts([{ id: "a", kind: "comment", text: long("SPAMMY promo") }, { id: "b", kind: "comment", text: long("normal text") }]);
  let log = getAIActivity();
  assert.equal(log.length, 1, "only the flagged item is logged, not the harmless one");
  assert.equal(log[0].stage, "display");

  _resetAIModerationState(); // e.g. a page reload: the client cache is gone, the server answers again
  await fetchVerdicts([{ id: "a", kind: "comment", text: long("SPAMMY promo") }]);
  assert.equal(getAIActivity().length, 1, "no duplicate for the same content");
});

test("activity: capped at 50 entries, clearable, and safe without localStorage", async () => {
  for (let i = 0; i < 60; i++) await checkBeforePublish({ text: long(`comment number ${i}`) });
  assert.equal(getAIActivity().length, 50);
  clearAIActivity();
  assert.equal(getAIActivity().length, 0);

  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  await assert.doesNotReject(() => checkBeforePublish({ text: long("still works with broken storage") }));
  assert.deepEqual(getAIActivity(), []);
  globalThis.localStorage = saved;
});

// ── probes / health interpretation ─────────────────────────────────────────

test("interpretHealth", () => {
  assert.equal(interpretHealth(null).state, "not_atticus");
  assert.equal(interpretHealth({ status: "ok", model: "m" }).state, "old_deployment");
  assert.equal(interpretHealth({ status: "ok", moderation: { enabled: false, configured: true } }).state, "disabled");
  assert.equal(interpretHealth({ status: "ok", moderation: { enabled: true, configured: false } }).state, "unconfigured");
  const ready = interpretHealth({ status: "ok", model: "m", moderation: { enabled: true, configured: true, promptVersion: "v1", sharedCache: true } });
  assert.deepEqual([ready.state, ready.promptVersion, ready.sharedCache], ["ready", "v1", true]);
});

test("evaluateProbes: ok / rules-only / rule failure", () => {
  const probes = buildProbes("n0nce");
  assert.ok(probes.every((p) => !p.text.includes("undefined")));
  assert.ok(probes.filter((p) => p.aiPath).every((p) => p.text.includes("n0nce")), "AI probes carry the nonce (no cache hit)");

  const good = [
    { id: "seed", verdict: "block", source: "rules" }, { id: "invest", verdict: "block", source: "rules" },
    { id: "inject", verdict: "flag", source: "ai" }, { id: "testimony", verdict: "allow", source: "ai" },
    { id: "spam", verdict: "flag", source: "ai" }, { id: "harass", verdict: "flag", source: "ai" },
  ];
  assert.equal(evaluateProbes(probes, good).summary, "ok");
  assert.equal(evaluateProbes(probes, good).failures, 0);

  // advisory misses only warn
  const soft = good.map((r) => (r.id === "spam" ? { ...r, verdict: "allow" } : r));
  const e = evaluateProbes(probes, soft);
  assert.equal(e.summary, "ok");
  assert.equal(e.rows.find((r) => r.probe.id === "spam").level, "warn");

  // Gemini down: AI probes degraded → rules_only (counts as a failure)
  const rulesOnly = good.map((r) => (["testimony", "spam", "harass"].includes(r.id) ? { ...r, verdict: "allow", source: "error", degraded: true } : r));
  const ro = evaluateProbes(probes, rulesOnly);
  assert.equal(ro.summary, "rules_only");
  assert.ok(ro.failures >= 1);

  // an OLD route answering "allow" to a phishing text is a hard failure
  const broken = good.map((r) => (r.id === "seed" ? { id: "seed", verdict: "allow", source: "ai" } : r));
  const b = evaluateProbes(probes, broken);
  assert.equal(b.summary, "fail");
  assert.equal(b.rows.find((r) => r.probe.id === "seed").level, "fail");

  // a missing result
  assert.equal(evaluateProbes(probes, good.slice(1)).rows[0].level, "fail");
});

test.after(() => { globalThis.fetch = realFetch; });
