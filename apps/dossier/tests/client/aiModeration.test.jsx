// Tests for src/utils/aiModeration.js — the browser side of "Atticus Guard".
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import i18n from "../../src/i18n";
import {
  fetchVerdicts,
  checkBeforePublish,
  shouldScan,
  isFlagged,
  itemKey,
  primaryCategoryLabel,
  assertPublishAllowed,
  failsClosed,
  _setModerationMode,
  _resetAIModerationState,
} from "../../src/utils/aiModeration";

// ── fake server ────────────────────────────────────────────────────────────
let calls;
let mode; // "ok" | "429" | "500" | "network" | "disabled" | "hang"
const realFetch = globalThis.fetch;
const realNow = Date.now;

const classify = (text) => {
  if (/DEGRADED/.test(text)) return { verdict: "allow", severity: 0, categories: [], confidence: 1, source: "error", degraded: true };
  if (/SCAM/.test(text)) return { verdict: "block", severity: 2, categories: ["scam_phishing"], confidence: 0.95, source: "ai", reason: "wallet drain" };
  if (/SPAMMY/.test(text)) return { verdict: "flag", severity: 1, categories: ["spam"], confidence: 0.8, source: "ai" };
  return { verdict: "allow", severity: 0, categories: [], confidence: 0.95, source: "ai" };
};

beforeEach(async () => {
  _resetAIModerationState();
  // NOTE: default mode is now OPEN (see defaultMode.test.jsx and the header
  // comment in aiModeration.js). This file explicitly forces STRICT so the
  // strict-mode behaviour itself stays covered.
  _setModerationMode({ strict: true });
  await i18n.changeLanguage("en");
  calls = [];
  mode = "ok";
  Date.now = realNow;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, options });
    if (mode === "network") throw new TypeError("Failed to fetch");
    if (mode === "hang") return new Promise((_, rej) => options.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))));
    if (mode === "429") return new Response("{}", { status: 429, headers: { "Retry-After": "30" } });
    if (mode === "500") return new Response("{}", { status: 500 });
    if (mode === "disabled") return new Response(JSON.stringify({ success: true, disabled: true, results: [] }), { status: 200 });
    return new Response(
      JSON.stringify({ success: true, results: body.items.map((it) => ({ id: it.id, ...classify(it.text) })) }),
      { status: 200 },
    );
  };
});

const item = (id, text, extra = {}) => ({ id, kind: "comment", text, context: "", ...extra });
const longer = (s) => `${s} — some ordinary sentence to pass the length gate`;

test("shouldScan: skips empty/short replies, keeps links", () => {
  assert.equal(shouldScan({ text: "" }), false);
  assert.equal(shouldScan({ text: "thanks!" }), false);
  assert.equal(shouldScan({ text: "🙏" }), false);
  assert.equal(shouldScan({ text: "http://a.io" }), true);
  assert.equal(shouldScan({ text: "This is a normal comment." }), true);
});

test("fetchVerdicts: maps results to ids and never sends identity data", async () => {
  const map = await fetchVerdicts([
    item("c1", longer("SPAMMY buy now"), { author: { id: "0xWALLET" }, walletAddress: "0xWALLET" }),
    item("c2", longer("normal")),
  ]);
  assert.equal(map.get("c1").verdict, "flag");
  assert.equal(map.get("c2").verdict, "allow");
  assert.equal(calls.length, 1);
  const sent = JSON.stringify(calls[0].body);
  assert.doesNotMatch(sent, /0xWALLET|author|wallet/i);
  assert.deepEqual(Object.keys(calls[0].body.items[0]).sort(), ["context", "id", "kind", "text"]);
});

test("fetchVerdicts: 25 items → 3 requests of ≤10; identical items de-duplicated", async () => {
  const items = Array.from({ length: 24 }, (_, i) => item(`c${i}`, longer(`comment number ${i}`)));
  items.push(item("dup", longer("comment number 3"))); // same content as c3
  const map = await fetchVerdicts(items);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.body.items.length <= 10));
  assert.equal(calls.reduce((n, c) => n + c.body.items.length, 0), 24); // dup not sent twice
  assert.equal(map.size, 25); // …but still answered
  assert.equal(map.get("dup").verdict, "allow");
});

test("fetchVerdicts: answers from the cache without a second request", async () => {
  await fetchVerdicts([item("a", longer("SPAMMY one"))]);
  assert.equal(calls.length, 1);
  const again = await fetchVerdicts([item("other-id", longer("SPAMMY one"))]);
  assert.equal(calls.length, 1);
  assert.equal(again.get("other-id").verdict, "flag");
});

test("cache key depends on kind and context", () => {
  const a = itemKey({ kind: "comment", text: "same text here", context: "post A" });
  assert.notEqual(a, itemKey({ kind: "comment", text: "same text here", context: "post B" }));
  assert.notEqual(a, itemKey({ kind: "post", text: "same text here", context: "post A" }));
  assert.equal(a, itemKey({ kind: "comment", text: "  same text here ", context: "post A" }));
});

test("concurrent callers asking for the same item share ONE request", async () => {
  const [m1, m2] = await Promise.all([
    fetchVerdicts([item("x", longer("SPAMMY shared"))]),
    fetchVerdicts([item("y", longer("SPAMMY shared"))]),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(m1.get("x").verdict, "flag");
  assert.equal(m2.get("y").verdict, "flag");
});

test("degraded answers are treated as 'no opinion' and are not cached", async () => {
  const map = await fetchVerdicts([item("d", longer("DEGRADED text"))]);
  assert.equal(map.has("d"), false);
  await fetchVerdicts([item("d", longer("DEGRADED text"))]);
  assert.equal(calls.length, 2); // asked again, nothing was cached
});

test("failures fail open and open the circuit breaker (no request storm)", async () => {
  mode = "500";
  const first = await fetchVerdicts([item("a", longer("one"))]);
  assert.equal(first.size, 0);
  assert.equal(calls.length, 1);

  mode = "ok";
  const during = await fetchVerdicts([item("b", longer("two"))]);
  assert.equal(during.size, 0);
  assert.equal(calls.length, 1, "breaker open: no new request");

  const t0 = Date.now();
  Date.now = () => t0 + 60_000; // breaker expired
  const after = await fetchVerdicts([item("c", longer("three"))]);
  assert.equal(after.get("c").verdict, "allow");
  assert.equal(calls.length, 2);
});

test("an outage is announced ONCE with console.warn (silent for users, visible to operators)", async () => {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    mode = "500";
    await fetchVerdicts([item("a", longer("one"))]);
    await fetchVerdicts([item("b", longer("two"))]); // breaker open: no second warning
    assert.equal(warns.length, 1);
    assert.match(warns[0], /AI moderation unavailable \(HTTP 500\)/);
    assert.match(warns[0], /WITHOUT an AI check/);
  } finally {
    console.warn = realWarn;
  }
});

test("429 honours Retry-After", async () => {
  mode = "429";
  await fetchVerdicts([item("a", longer("one"))]);
  mode = "ok";
  const t0 = Date.now();
  Date.now = () => t0 + 20_000; // still inside the 30 s Retry-After
  assert.equal((await fetchVerdicts([item("b", longer("two"))])).size, 0);
  assert.equal(calls.length, 1);
  Date.now = () => t0 + 31_000;
  assert.equal((await fetchVerdicts([item("b", longer("two"))])).size, 1);
});

test("network error and server 'disabled' both mean no opinion", async () => {
  mode = "network";
  assert.equal((await fetchVerdicts([item("a", longer("one"))])).size, 0);
  _resetAIModerationState();
  mode = "disabled";
  assert.equal((await fetchVerdicts([item("a", longer("one"))])).size, 0);
});

// ── pre-publish gate ───────────────────────────────────────────────────────

test("checkBeforePublish: blocks a clear violation with a localised reason", async () => {
  const r = await checkBeforePublish({ text: longer("SCAM claim your airdrop"), kind: "comment", context: "post text" });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Atticus AI stopped this from being published/);
  assert.match(r.reason, /scam or phishing/);
  assert.equal(calls[0].body.items[0].kind, "comment");
  assert.equal(calls[0].body.items[0].context, "post text");

  await i18n.changeLanguage("uk");
  _resetAIModerationState();
  const uk = await checkBeforePublish({ text: longer("SCAM claim your airdrop") });
  assert.match(uk.reason, /Atticus AI зупинив публікацію/);
  assert.match(uk.reason, /шахрайство або фішинг/);
  await i18n.changeLanguage("en");
});

test("checkBeforePublish: 'flag' is allowed through (blurred for readers later)", async () => {
  const r = await checkBeforePublish({ text: longer("SPAMMY promo") });
  assert.equal(r.allowed, true);
  assert.equal(r.result.verdict, "flag");
});

test("checkBeforePublish (STRICT, opt-in): no AI verdict → NOT published, 'try again'", async () => {
  for (const [label, arrange] of [
    ["HTTP 500", () => { mode = "500"; }],
    ["timeout", () => { mode = "hang"; }],
    ["degraded answer", () => { mode = "ok"; }],
  ]) {
    _resetAIModerationState();
    arrange();
    const t0 = Date.now();
    const text = label === "degraded answer" ? longer("DEGRADED SCAM") : longer("SCAM claim your airdrop");
    const r = await checkBeforePublish({ text, timeoutMs: 30 });
    assert.equal(r.allowed, false, label);
    assert.equal(r.unavailable, true, label);
    assert.match(r.reason, /safety check \(Atticus AI\) is temporarily unavailable/, label);
    assert.ok(Date.now() - t0 < 1500, `${label}: must not hang`);
  }
});

test("strict mode: a user who just hit an outage can retry IMMEDIATELY (breaker is bypassed)", async () => {
  mode = "500";
  assert.equal((await checkBeforePublish({ text: longer("first try") })).allowed, false);
  assert.equal(calls.length, 1);

  mode = "ok"; // the service recovers; the 45 s circuit breaker is still "open" for DISPLAY lookups
  const retry = await checkBeforePublish({ text: longer("first try") });
  assert.equal(retry.allowed, true);
  assert.equal(calls.length, 2, "the retry really went to the server");
});

test("open mode (the default): no verdict → published", async () => {
  _setModerationMode({ strict: false });
  mode = "500";
  const r = await checkBeforePublish({ text: longer("published although the AI is down") });
  assert.equal(r.allowed, true);
  assert.equal(failsClosed("comment"), false);
});

test("fail-open KINDS: relax only some kinds (e.g. urgent help requests), keep the rest strict", async () => {
  _setModerationMode({ strict: true, failOpen: ["help_request"] });
  mode = "500";
  assert.equal(failsClosed("help_request"), false);
  assert.equal(failsClosed("comment"), true);
  assert.equal((await checkBeforePublish({ text: longer("I need urgent help, please"), kind: "help_request" })).allowed, true);
  assert.equal((await checkBeforePublish({ text: longer("some ordinary comment here"), kind: "comment" })).allowed, false);
});

test("a deliberate operator switch-off (MODERATION_ENABLED=false) is NOT an outage: nothing is held back", async () => {
  mode = "disabled";
  const first = await checkBeforePublish({ text: longer("published while moderation is switched off") });
  assert.equal(first.allowed, true);
  const n = calls.length;
  const second = await checkBeforePublish({ text: longer("another one, no need to ask the server again") });
  assert.equal(second.allowed, true);
  assert.equal(calls.length, n, "the switch-off is remembered for a minute");
});

test("too-short and empty texts never need a verdict, even in strict mode during an outage", async () => {
  mode = "500";
  calls.length = 0;
  assert.equal((await checkBeforePublish({ text: "   " })).allowed, true);
  assert.equal((await checkBeforePublish({ text: "thanks!" })).allowed, true);
  assert.equal(calls.length, 0);
});

// ── last-line-of-defence gate used inside the publishing functions ─────────

test("assertPublishAllowed: an unchecked text is judged; a blocked one throws a ready-to-show error", async () => {
  await assert.rejects(
    () => assertPublishAllowed({ text: longer("SCAM claim your airdrop"), kind: "comment" }),
    (err) => err.code === "MODERATION_BLOCKED" && /Atticus AI stopped this/.test(err.message) && err.moderation.verdict === "block",
  );
  await assert.doesNotReject(() => assertPublishAllowed({ text: longer("A perfectly ordinary comment"), kind: "post" }));
});

test("assertPublishAllowed: REUSES what the UI gate just decided (no second wait, no second opinion)", async () => {
  // UI gate judged it with a context …
  await checkBeforePublish({ text: longer("A normal comment about the arrest"), kind: "comment", context: "parent post text" });
  const n = calls.length;
  // … the hook then asks with the same kind but WITHOUT the context (it doesn't know it): must not hit the server again.
  await assertPublishAllowed({ text: longer("A normal comment about the arrest"), kind: "comment" });
  assert.equal(calls.length, n);

  // and a refusal by the UI gate is repeated verbatim
  await checkBeforePublish({ text: longer("SCAM claim your airdrop"), kind: "comment" });
  const m = calls.length;
  await assert.rejects(() => assertPublishAllowed({ text: longer("SCAM claim your airdrop"), kind: "comment" }), /Atticus AI stopped this/);
  assert.equal(calls.length, m);
});

test("assertPublishAllowed: the gate is keyed by KIND — the same text as a different kind is judged afresh", async () => {
  await checkBeforePublish({ text: longer("A normal text judged as a comment"), kind: "comment" });
  const n = calls.length;
  await assertPublishAllowed({ text: longer("A normal text judged as a comment"), kind: "post" });
  assert.equal(calls.length, n + 1, "post ≠ comment → a fresh check");
});

test("an outage 'published without a verdict' for one kind is NOT reused to wave through another kind", async () => {
  _setModerationMode({ strict: true, failOpen: ["comment"] }); // comments fail open, posts fail closed
  mode = "500";
  const text = longer("identical text sent first as a comment and then as a post");
  const asComment = await checkBeforePublish({ text, kind: "comment" });
  assert.equal(asComment.allowed, true, "comment fails open during the outage");
  await assert.rejects(
    () => assertPublishAllowed({ text, kind: "post" }),
    (err) => err.code === "MODERATION_BLOCKED" && err.unavailable === true,
    "the comment's unverified pass must not be reused for a post (strict kind)",
  );
});

test("assertPublishAllowed: strict mode + outage throws 'unavailable' (nothing unchecked reaches Lens)", async () => {
  mode = "500";
  await assert.rejects(
    () => assertPublishAllowed({ text: longer("a comment nobody has checked"), kind: "comment" }),
    (err) => err.code === "MODERATION_BLOCKED" && err.unavailable === true && /temporarily unavailable/.test(err.message),
  );
});

test("assertPublishAllowed: open mode + outage waits ONCE, then the hook does not wait again", async () => {
  _setModerationMode({ strict: false });
  mode = "500";
  await checkBeforePublish({ text: longer("comment published in open mode") });
  const n = calls.length;
  await assertPublishAllowed({ text: longer("comment published in open mode"), kind: "post" });
  assert.equal(calls.length, n);
});

test("blocked drafts are remembered: re-submitting the same text needs no request", async () => {
  await checkBeforePublish({ text: longer("SCAM one") });
  const again = await checkBeforePublish({ text: longer("SCAM one") });
  assert.equal(again.allowed, false);
  assert.equal(calls.length, 1);
});

test("isFlagged / primaryCategoryLabel", () => {
  assert.equal(isFlagged({ verdict: "flag" }), true);
  assert.equal(isFlagged({ verdict: "block" }), true);
  assert.equal(isFlagged({ verdict: "allow" }), false);
  assert.equal(isFlagged({ verdict: "block", degraded: true }), false);
  assert.equal(isFlagged(undefined), false);
  assert.equal(primaryCategoryLabel({ categories: ["hate_speech"] }), "hate speech");
  assert.equal(primaryCategoryLabel({ categories: [] }), "other");
  assert.equal(primaryCategoryLabel({ categories: ["unknown_new_category"] }), "unknown new category"); // graceful fallback
});

test("every category the engine can emit has a translation in every language", async () => {
  const { readFileSync } = await import("node:fs");
  const cats = ["spam", "scam_phishing", "hate_speech", "harassment", "threats_violence", "doxxing", "sexual_content", "child_safety", "self_harm", "illegal_goods", "other"];
  const keys = [...cats.map((c) => `ai_category_${c}`), "ai_moderation_blocked", "ai_moderation_post_flagged", "ai_moderation_comment_flagged", "ai_moderation_show_anyway"];
  for (const lang of ["en", "uk", "ru", "de", "fr", "es", "pt", "ja", "zh", "hi", "ar"]) {
    // The runner bundles this file into node_modules/.cache, so resolve from the project root (cwd).
    const dict = JSON.parse(readFileSync(`${process.cwd()}/src/i18n/locales/${lang}.json`, "utf8"));
    for (const k of keys) assert.ok(typeof dict[k] === "string" && dict[k].length > 0, `${lang}: missing ${k}`);
    for (const k of ["ai_moderation_blocked", "ai_moderation_post_flagged", "ai_moderation_comment_flagged"]) {
      assert.match(dict[k], /\{\{category\}\}/, `${lang}: ${k} lost its {{category}} placeholder`);
    }
  }
});

globalThis.fetch = realFetch;
