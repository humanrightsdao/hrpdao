// Tests for src/lib/aiModeration.js — ported from dossier's
// tests/client/aiModeration.test.jsx, plus dedicated coverage for
// forceStrict (the mandatory check used for governance proposals).
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
  MANDATORY_KINDS,
  threadModerationText,
  _setModerationMode,
  _resetAIModerationState,
} from "../../src/lib/aiModeration";

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
  // NOTE: default mode is OPEN (see defaultMode.test.jsx). This file
  // explicitly forces STRICT so the strict-mode behaviour itself stays
  // covered, matching dossier's approach.
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

const item = (id, text, extra = {}) => ({ id, kind: "forum_reply", text, context: "", ...extra });
const longer = (s) => `${s} — some ordinary sentence to pass the length gate`;

test("shouldScan: skips empty/short replies, keeps links", () => {
  assert.equal(shouldScan({ text: "" }), false);
  assert.equal(shouldScan({ text: "thanks!" }), false);
  assert.equal(shouldScan({ text: "🙏" }), false);
  assert.equal(shouldScan({ text: "http://a.io" }), true);
  assert.equal(shouldScan({ text: "This is a normal reply." }), true);
});

test("fetchVerdicts: maps results to ids, no identity data sent", async () => {
  const map = await fetchVerdicts([
    item("c1", longer("SPAMMY buy now"), { author: { pubkey: "abc123" } }),
    item("c2", longer("normal")),
  ]);
  assert.equal(map.get("c1").verdict, "flag");
  assert.equal(map.get("c2").verdict, "allow");
  assert.equal(calls.length, 1);
  const sent = JSON.stringify(calls[0].body);
  assert.doesNotMatch(sent, /abc123|pubkey|author/i);
  assert.deepEqual(Object.keys(calls[0].body.items[0]).sort(), ["context", "id", "kind", "text"]);
});

test("fetchVerdicts: identical content answered from cache without a second request", async () => {
  await fetchVerdicts([item("a", longer("SPAMMY one"))]);
  assert.equal(calls.length, 1);
  const again = await fetchVerdicts([item("other-id", longer("SPAMMY one"))]);
  assert.equal(calls.length, 1);
  assert.equal(again.get("other-id").verdict, "flag");
});

test("cache key depends on kind and context", () => {
  const a = itemKey({ kind: "forum_reply", text: "same text here", context: "thread A" });
  assert.notEqual(a, itemKey({ kind: "forum_reply", text: "same text here", context: "thread B" }));
  assert.notEqual(a, itemKey({ kind: "proposal", text: "same text here", context: "thread A" }));
  assert.equal(a, itemKey({ kind: "forum_reply", text: "  same text here ", context: "thread A" }));
});

test("degraded answers are 'no opinion' and are not cached", async () => {
  const map = await fetchVerdicts([item("d", longer("DEGRADED text"))]);
  assert.equal(map.has("d"), false);
  await fetchVerdicts([item("d", longer("DEGRADED text"))]);
  assert.equal(calls.length, 2);
});

test("failures fail open (for display) and open the circuit breaker", async () => {
  mode = "500";
  const first = await fetchVerdicts([item("a", longer("one"))]);
  assert.equal(first.size, 0);
  assert.equal(calls.length, 1);
  mode = "ok";
  const during = await fetchVerdicts([item("b", longer("two"))]);
  assert.equal(during.size, 0);
  assert.equal(calls.length, 1, "breaker open: no new request");
  const t0 = Date.now();
  Date.now = () => t0 + 60_000;
  const after = await fetchVerdicts([item("c", longer("three"))]);
  assert.equal(after.get("c").verdict, "allow");
  assert.equal(calls.length, 2);
});

// ── pre-publish gate (default = open, this file forces strict) ─────────────

test("checkBeforePublish: blocks a clear violation with a localised reason", async () => {
  const r = await checkBeforePublish({ text: longer("SCAM claim your airdrop"), kind: "forum_reply", context: "thread text" });
  assert.equal(r.allowed, false);
  assert.match(r.reason, /Atticus AI stopped this from being published/);
  assert.match(r.reason, /scam or phishing/);
  assert.equal(calls[0].body.items[0].kind, "forum_reply");
  assert.equal(calls[0].body.items[0].context, "thread text");

  await i18n.changeLanguage("uk");
  _resetAIModerationState();
  const uk = await checkBeforePublish({ text: longer("SCAM claim your airdrop") });
  assert.match(uk.reason, /Atticus AI зупинив публікацію/);
  await i18n.changeLanguage("en");
});

test("checkBeforePublish: 'flag' is allowed through", async () => {
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

test("open mode (the default): no verdict → published", async () => {
  _setModerationMode({ strict: false });
  mode = "500";
  const r = await checkBeforePublish({ text: longer("published although the AI is down") });
  assert.equal(r.allowed, true);
  assert.equal(failsClosed("forum_reply"), false);
});

test("a deliberate operator switch-off is NOT an outage: nothing is held back", async () => {
  mode = "disabled";
  const first = await checkBeforePublish({ text: longer("published while moderation is switched off") });
  assert.equal(first.allowed, true);
  const n = calls.length;
  const second = await checkBeforePublish({ text: longer("another one, no need to ask the server again") });
  assert.equal(second.allowed, true);
  assert.equal(calls.length, n, "the switch-off is remembered for a minute");
});

// ── forceStrict: the MANDATORY check used for governance proposals ─────────

test("forceStrict=true requires a real verdict EVEN when the global mode is open", async () => {
  _setModerationMode({ strict: false }); // the app-wide default
  mode = "500"; // Gemini is down
  const r = await checkBeforePublish({ text: longer("a governance proposal text"), kind: "proposal", forceStrict: true });
  assert.equal(r.allowed, false);
  assert.equal(r.unavailable, true);
  assert.match(r.reason, /temporarily unavailable/);
});

test("forceStrict=true still allows a proposal through once the AI actually answers 'allow'", async () => {
  _setModerationMode({ strict: false });
  mode = "ok";
  const r = await checkBeforePublish({ text: longer("propose repealing an outdated policy"), kind: "proposal", forceStrict: true });
  assert.equal(r.allowed, true);
  assert.equal(r.result.verdict, "allow");
});

test("forceStrict=true still BLOCKS a clear violation (forceStrict only affects the no-verdict case)", async () => {
  const r = await checkBeforePublish({ text: longer("SCAM claim your airdrop"), kind: "proposal", forceStrict: true });
  assert.equal(r.allowed, false);
  assert.equal(r.unavailable, undefined);
  assert.match(r.reason, /Atticus AI stopped this from being published/);
});

test("forceStrict=false (default) is unaffected — same as the existing open-mode test", async () => {
  _setModerationMode({ strict: false });
  mode = "500";
  const r = await checkBeforePublish({ text: longer("a normal forum reply"), kind: "forum_reply", forceStrict: false });
  assert.equal(r.allowed, true);
});

test("assertPublishAllowed: forceStrict propagates and throws 'unavailable' during an outage", async () => {
  _setModerationMode({ strict: false });
  mode = "500";
  await assert.rejects(
    () => assertPublishAllowed({ text: longer("a proposal nobody could check"), kind: "proposal", forceStrict: true }),
    (err) => err.code === "MODERATION_BLOCKED" && err.unavailable === true,
  );
  // A forum reply in the SAME outage, WITHOUT forceStrict, is unaffected (open mode).
  await assert.doesNotReject(() =>
    assertPublishAllowed({ text: longer("a proposal nobody could check"), kind: "forum_reply" }),
  );
});

// ── last-line-of-defence gate / cross-kind reuse ────────────────────────────

test("assertPublishAllowed: a blocked draft throws a ready-to-show error", async () => {
  await assert.rejects(
    () => assertPublishAllowed({ text: longer("SCAM claim your airdrop"), kind: "forum_reply" }),
    (err) => err.code === "MODERATION_BLOCKED" && /Atticus AI stopped this/.test(err.message) && err.moderation.verdict === "block",
  );
  await assert.doesNotReject(() => assertPublishAllowed({ text: longer("A perfectly ordinary reply"), kind: "forum_thread" }));
});

test("assertPublishAllowed: REUSES what the UI gate already decided (no second request)", async () => {
  await checkBeforePublish({ text: longer("A normal reply about a proposal"), kind: "forum_reply", context: "thread text" });
  const n = calls.length;
  await assertPublishAllowed({ text: longer("A normal reply about a proposal"), kind: "forum_reply" });
  assert.equal(calls.length, n);
});

test("isFlagged / primaryCategoryLabel / categoryLabel translations exist", async () => {
  assert.equal(isFlagged({ verdict: "flag" }), true);
  assert.equal(isFlagged({ verdict: "block" }), true);
  assert.equal(isFlagged({ verdict: "allow" }), false);
  assert.equal(isFlagged({ verdict: "block", degraded: true }), false);
  assert.equal(primaryCategoryLabel({ categories: ["hate_speech"] }), "hate speech");
  assert.equal(primaryCategoryLabel({ categories: [] }), "other");
});

test("every category the engine can emit has a translation in every language", async () => {
  const { readFileSync } = await import("node:fs");
  const cats = ["spam", "scam_phishing", "hate_speech", "harassment", "threats_violence", "doxxing", "sexual_content", "child_safety", "self_harm", "illegal_goods", "other"];
  for (const lang of ["en", "uk", "ru", "de", "fr", "es", "pt", "ja", "zh", "hi", "ar"]) {
    const dict = JSON.parse(readFileSync(`${process.cwd()}/src/i18n/locales/${lang}.json`, "utf8"));
    const node = dict.dao?.aiModeration?.category;
    assert.ok(node, `${lang}: missing dao.aiModeration.category`);
    for (const c of cats) assert.ok(typeof node[c] === "string" && node[c].length > 0, `${lang}: missing category.${c}`);
    assert.ok(typeof dict.dao?.aiModeration?.blocked === "string", `${lang}: missing dao.aiModeration.blocked`);
    assert.match(dict.dao.aiModeration.blocked, /\{\{category\}\}/, `${lang}: blocked lost its {{category}} placeholder`);
    assert.ok(typeof dict.dao?.aiModeration?.unavailable === "string", `${lang}: missing dao.aiModeration.unavailable`);
    for (const key of ["unavailableProposal", "flaggedNotice", "flaggedShort"]) {
      assert.ok(typeof dict.dao.aiModeration[key] === "string" && dict.dao.aiModeration[key].length > 0, `${lang}: missing dao.aiModeration.${key}`);
    }
    assert.match(dict.dao.aiModeration.flaggedNotice, /\{\{category\}\}/, `${lang}: flaggedNotice lost its {{category}} placeholder`);
  }
});

// ── proposals are mandatory BY KIND (no forceStrict needed at the call site) ─

test("proposal is a MANDATORY kind: fails closed with the app-wide default open mode, no forceStrict", async () => {
  _setModerationMode({ strict: false });
  assert.ok(MANDATORY_KINDS.has("proposal"));
  assert.equal(failsClosed("proposal"), true);
  assert.equal(failsClosed("forum_reply"), false);
  mode = "500"; // Gemini is down
  const r = await checkBeforePublish({ text: longer("a governance proposal text"), kind: "proposal" });
  assert.equal(r.allowed, false);
  assert.equal(r.unavailable, true);
  assert.match(r.reason, /Governance proposals require a passing check/, "proposal-specific message");
});

test("proposal: VITE_AI_FAIL_OPEN_KINDS cannot relax the mandatory check", async () => {
  _setModerationMode({ strict: true, failOpen: ["proposal", "forum_reply"] });
  assert.equal(failsClosed("proposal"), true);
  assert.equal(failsClosed("forum_reply"), false);
  mode = "500";
  const r = await checkBeforePublish({ text: longer("a governance proposal text"), kind: "proposal" });
  assert.equal(r.allowed, false);
});

test("proposal: a SHORT title is still checked (length gate does not apply to mandatory kinds)", async () => {
  assert.equal(shouldScan({ kind: "proposal", text: "Ban Bob" }), true);
  assert.equal(shouldScan({ kind: "forum_reply", text: "Ban Bob" }), false);
  _setModerationMode({ strict: false });
  mode = "500";
  const down = await checkBeforePublish({ text: "Ban Bob", kind: "proposal" });
  assert.equal(down.allowed, false, "no verdict → refused, even for a 7-character proposal");
  _resetAIModerationState();
  _setModerationMode({ strict: false });
  mode = "ok";
  calls = [];
  const up = await checkBeforePublish({ text: "SCAM", kind: "proposal" });
  assert.equal(calls.length, 1, "the short proposal really went to the moderation service");
  assert.equal(up.allowed, false);
});

test("proposal: an operator switch-off (server kill switch) lets proposals through — a deliberate decision, not an outage", async () => {
  _setModerationMode({ strict: false });
  mode = "disabled";
  const r = await checkBeforePublish({ text: longer("a governance proposal text"), kind: "proposal" });
  assert.equal(r.allowed, true);
  const n = calls.length;
  const again = await checkBeforePublish({ text: longer("another proposal, no need to ask again"), kind: "proposal" });
  assert.equal(again.allowed, true);
  assert.equal(calls.length, n, "the switch-off is remembered for a minute");
});

test("proposal: with the service really down (not switched off) the refusal is NOT bypassed by an earlier forum outage", async () => {
  _setModerationMode({ strict: false });
  mode = "500";
  const text = longer("identical text used as a reply and then as a proposal");
  const reply = await checkBeforePublish({ text, kind: "forum_reply" });
  assert.equal(reply.allowed, true, "forum reply fails open");
  await assert.rejects(
    () => assertPublishAllowed({ text, kind: "proposal" }),
    (err) => err.code === "MODERATION_BLOCKED" && err.unavailable === true,
    "the reply's 'published without a verdict' outcome must not be reused for the proposal",
  );
});

test("assertPublishAllowed: the gate is keyed by kind — a different kind is judged on its own", async () => {
  await checkBeforePublish({ text: longer("A normal text judged as a reply"), kind: "forum_reply" });
  const n = calls.length;
  await assertPublishAllowed({ text: longer("A normal text judged as a reply"), kind: "forum_thread" });
  assert.equal(calls.length, n + 1, "forum_thread ≠ forum_reply → a fresh check");
});

// ── forum thread TITLE is judged, not just the body ─────────────────────────

test("threadModerationText: title first, then body; empty title → body only", () => {
  assert.equal(threadModerationText("  My title ", " the body "), "My title\n\nthe body");
  assert.equal(threadModerationText("", "only body"), "only body");
  assert.equal(threadModerationText(undefined, "only body"), "only body");
});

test("a scam in the TITLE of an otherwise harmless thread is caught (title+body is what gets classified)", async () => {
  const body = "Just a normal, harmless description of the topic to discuss.";
  const r = await checkBeforePublish({ text: threadModerationText("SCAM claim your airdrop", body), kind: "forum_thread" });
  assert.equal(r.allowed, false);
  assert.match(calls.at(-1).body.items[0].text, /^SCAM claim your airdrop\n\n/);
  // …whereas the body alone would have passed (the old behaviour):
  _resetAIModerationState();
  _setModerationMode({ strict: true });
  const old = await checkBeforePublish({ text: body, kind: "forum_thread" });
  assert.equal(old.allowed, true);
});

globalThis.fetch = realFetch;
