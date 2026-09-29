// Управління → Atticus AI panel (DOM). Needs jsdom (npm i -D jsdom); skipped without it.
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import i18n from "../../src/i18n";
import AIModerationPanel from "../../src/components/AIModerationPanel";
import { _resetAIModerationState, _setModerationMode, checkBeforePublish } from "../../src/utils/aiModeration";

const skip = globalThis.__NO_DOM__ ? "jsdom not installed (npm i -D jsdom)" : false;
const act = React.act;
const realFetch = globalThis.fetch;
let health;
let moderate; // (items) => results | Response

const classify = (text, id) => {
  if (id === "seed" || id === "invest") return { verdict: "block", severity: 2, categories: ["scam_phishing"], confidence: 0.95, source: "rules" };
  if (/ignore all previous/i.test(text)) return { verdict: "flag", severity: 1, categories: ["spam"], confidence: 0.8, source: "ai" };
  if (/SPAMMY|crypto signals|worthless idiot/.test(text)) return { verdict: "flag", severity: 1, categories: ["spam"], confidence: 0.85, source: "ai", reason: "boilerplate" };
  return { verdict: "allow", severity: 0, categories: [], confidence: 0.95, source: "ai" };
};

beforeEach(async () => {
  _resetAIModerationState();
  _setModerationMode({ strict: true });
  localStorage.clear();
  await i18n.changeLanguage("en");
  health = { status: "ok", model: "gemini-x", moderation: { enabled: true, configured: true, promptVersion: "2026-09-1" } };
  moderate = null;
  globalThis.__fetchPosts = undefined;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/api/health")) {
      if (health === "down") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(health), { status: 200 });
    }
    const body = JSON.parse(options.body);
    if (moderate) return moderate(body);
    return new Response(JSON.stringify({ success: true, results: body.items.map((it) => ({ id: it.id, ...classify(it.text, it.id) })) }), { status: 200 });
  };
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const mount = async () => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<MemoryRouter><AIModerationPanel /></MemoryRouter>); });
  await settle();
  return el;
};
const click = async (n) => { await act(async () => { n.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); }); await settle(); };
const btn = (el, txt) => [...el.querySelectorAll("button")].find((b) => b.textContent.includes(txt));

test("status: ready / old deployment / disabled / no key / unreachable", { skip }, async () => {
  let el = await mount();
  assert.match(el.textContent, /Service status: Ready · prompt 2026-09-1/);

  health = { status: "ok", model: "m" };
  el = await mount();
  assert.match(el.textContent, /Old server version — no moderation deployed/);

  health = { status: "ok", moderation: { enabled: false, configured: true } };
  assert.match((await mount()).textContent, /Switched off/);

  health = { status: "ok", moderation: { enabled: true, configured: false } };
  assert.match((await mount()).textContent, /No Gemini API key/);

  health = "down";
  assert.match((await mount()).textContent, /Unreachable/);
});

test("Run a check: everything works", { skip }, async () => {
  const el = await mount();
  await click(btn(el, "Run a check"));
  assert.match(el.textContent, /Working: the rules and Gemini both answered\./);
  assert.match(el.textContent, /wallet-phishing/);
  assert.match(el.textContent, /block · rules · scam_phishing/);
  assert.equal(el.querySelectorAll("li .text-red-700").length, 0);
  assert.match(el.textContent, /Answered in \d+\.\d s/, "shows how long the AI took");
  // …and the run itself is now listed, so "Recent AI checks" is never empty right after a check:
  assert.match(el.textContent, /self-check/);
  assert.doesNotMatch(el.textContent, /No activity yet/);
});

test("Run a check: rules work but Gemini is down → says so plainly", { skip }, async () => {
  moderate = (body) =>
    new Response(JSON.stringify({ success: true, results: body.items.map((it) => ({ id: it.id, ...(classify(it.text, it.id).source === "rules" ? classify(it.text, it.id) : { verdict: "allow", severity: 0, categories: [], source: "error", degraded: true }) })) }), { status: 200 });
  const el = await mount();
  await click(btn(el, "Run a check"));
  assert.match(el.textContent, /only the deterministic rules protect the platform/);
  assert.match(el.textContent, /DEGRADED/);
});

test("Run a check: HTTP errors are shown, not swallowed", { skip }, async () => {
  moderate = () => new Response(JSON.stringify({ success: false, error: "rate_limited" }), { status: 429 });
  const el = await mount();
  await click(btn(el, "Run a check"));
  assert.match(el.querySelector('[role="alert"]').textContent, /HTTP 429 \(rate_limited\)/);
});

test("Scan latest content: shows what was flagged, with link and toggleable text", { skip }, async () => {
  globalThis.__fetchPosts = async () => ({
    items: [
      { id: "p1", timestamp: "t", metadata: { content: "A normal testimony about an arrest, long enough", tags: [] }, author: { username: { localName: "ann" } }, commentOn: null },
      { id: "p2", timestamp: "t", metadata: { content: "SPAMMY visit my profile for crypto signals now", tags: [] }, author: { username: { localName: "bot9" } }, commentOn: null },
    ],
  });
  const el = await mount();
  await click(btn(el, "Scan latest content"));
  assert.match(el.textContent, /Scanned 2 items · AI answered for 2 · flagged 1/);
  assert.match(el.textContent, /spam/);
  assert.match(el.textContent, /@bot9/);
  assert.equal(el.querySelector('a[href="/post/p2"]')?.textContent, "Open");
  assert.match(el.querySelector("details").textContent, /visit my profile/);
  assert.doesNotMatch(el.textContent, /normal testimony/, "unflagged content is not listed");
  assert.match(el.textContent, /content scan/, "the scan is recorded in the activity list");
  assert.equal((el.textContent.match(/Scanned 2 items/g) || []).length, 2, "result + activity entry");
});

test("Scan latest content: outage is not reported as 'nothing flagged'", { skip }, async () => {
  moderate = () => new Response("{}", { status: 500 });
  globalThis.__fetchPosts = async () => ({ items: [{ id: "p1", timestamp: "t", metadata: { content: "Some post that is long enough to scan", tags: [] }, author: {}, commentOn: null }] });
  const el = await mount();
  await click(btn(el, "Scan latest content"));
  assert.match(el.textContent, /did not answer for any item/);
  assert.doesNotMatch(el.textContent, /Nothing flagged/);
});

test("Scan latest content: Lens error is shown", { skip }, async () => {
  globalThis.__fetchPosts = async () => ({ error: "Lens is down" });
  const el = await mount();
  await click(btn(el, "Scan latest content"));
  assert.match(el.querySelector('[role="alert"]').textContent, /Scan failed: Lens is down/);
});

test("Recent checks: a refused draft is visible, has no text, and can be cleared", { skip }, async () => {
  await checkBeforePublish({ text: "Please send your seed phrase to claim the prize", kind: "comment" });
  moderate = (body) => new Response(JSON.stringify({ success: true, results: body.items.map((it) => ({ id: it.id, ...classify(it.text, it.id), verdict: "block", source: "rules", categories: ["scam_phishing"] })) }), { status: 200 });
  _resetAIModerationState();
  await checkBeforePublish({ text: "Please send your seed phrase to claim the prize", kind: "comment" });

  const el = await mount();
  assert.match(el.textContent, /Recent AI checks in this browser/);
  assert.match(el.textContent, /before publishing/);
  assert.match(el.textContent, /block/);
  assert.match(el.textContent, /scam or phishing/);
  assert.match(el.textContent, /draft refused/);
  assert.doesNotMatch(el.textContent, /seed phrase to claim/, "the draft text is never shown or stored");

  await click(btn(el, "Clear"));
  assert.match(el.textContent, /No activity yet/);
  assert.equal(JSON.parse(localStorage.getItem("aiModerationActivity") || "[]").length, 0);
});

test("Recent checks: an outage is visible — REFUSED in strict mode, 'published without a check' in open mode", { skip }, async () => {
  moderate = () => new Response("{}", { status: 500 });
  await checkBeforePublish({ text: "A comment while the service was down" });
  let el = await mount();
  assert.match(el.textContent, /refused — the AI was unavailable/);
  assert.doesNotMatch(el.textContent, /published without an AI check/);

  localStorage.clear();
  _setModerationMode({ strict: false });
  await checkBeforePublish({ text: "Another comment while the service was down" });
  el = await mount();
  assert.match(el.textContent, /no verdict — published without an AI check/);
});

test("Recent checks: shows how long each pre-publish check took", { skip }, async () => {
  await checkBeforePublish({ text: "An ordinary comment that is long enough to check" });
  const el = await mount();
  assert.match(el.textContent, /\d+\.\ds/);
});

test("the panel speaks Ukrainian", { skip }, async () => {
  await i18n.changeLanguage("uk");
  const el = await mount();
  assert.match(el.textContent, /Стан сервісу: Готовий/);
  assert.ok(btn(el, "Виконати перевірку"));
  assert.ok(btn(el, "Сканувати останній контент"));
});

test.after(() => { globalThis.fetch = realFetch; });
