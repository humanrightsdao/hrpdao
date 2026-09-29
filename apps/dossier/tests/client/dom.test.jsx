// DOM tests: useAIVerdicts, CommentsSection collapsing, PostCard blur notice.
// Needs jsdom (optional dev tool): npm i -D jsdom   — skipped without it.
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import i18n from "../../src/i18n";
import { useAIVerdicts } from "../../src/hooks/useAIVerdicts";
import { _resetAIModerationState } from "../../src/utils/aiModeration";
import CommentsSection from "../../src/components/CommentsSection";
import PostCard from "../../src/components/PostCard";

const skip = globalThis.__NO_DOM__ ? "jsdom not installed (npm i -D jsdom)" : false;
const act = React.act;
const realFetch = globalThis.fetch;
let calls;

const classify = (text) =>
  /SPAMMY/.test(text)
    ? { verdict: "flag", severity: 1, categories: ["spam"], confidence: 0.85, source: "ai", reason: "boilerplate promo" }
    : { verdict: "allow", severity: 0, categories: [], confidence: 0.95, source: "ai" };

beforeEach(async () => {
  _resetAIModerationState();
  await i18n.changeLanguage("en");
  calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return new Response(JSON.stringify({ success: true, results: body.items.map((it) => ({ id: it.id, ...classify(it.text) })) }), { status: 200 });
  };
});

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 25)); });
const mount = async (node) => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(node); });
  await settle();
  return { el, root, rerender: async (n) => { await act(async () => { root.render(n); }); await settle(); } };
};
const click = (n) => act(async () => { n.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
const btn = (el, txt) => [...el.querySelectorAll("button")].find((b) => b.textContent.trim().includes(txt));

// ── hook ───────────────────────────────────────────────────────────────────

let latest;
function Probe({ items }) { latest = useAIVerdicts(items); return null; }
const it = (id, text) => ({ id, kind: "post", text });

test("useAIVerdicts: resolves verdicts, skips short items, re-renders don't refetch", { skip }, async () => {
  const A = "This is a perfectly ordinary long post text";
  const B = "SPAMMY offer, buy now buy now buy now";
  const { rerender } = await mount(<Probe items={[it("a", A), it("b", B), it("c", "ok")]} />);

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].items.map((i) => i.text), [A, B], "the 2-char item is never sent");
  assert.equal(latest.get("a").verdict, "allow");
  assert.equal(latest.get("b").verdict, "flag");
  assert.equal(latest.has("c"), false);

  // Callers build a fresh array on every render: same content ⇒ no new request.
  await rerender(<Probe items={[it("a", A), it("b", B), it("c", "ok")]} />);
  await rerender(<Probe items={[it("a", A), it("b", B), it("c", "ok")]} />);
  assert.equal(calls.length, 1);

  // A new item (e.g. next feed page) ⇒ only the NEW one is requested.
  const C = "A brand new long comment appears here";
  await rerender(<Probe items={[it("a", A), it("b", B), it("c", "ok"), it("d", C)]} />);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].items.map((i) => i.text), [C]);
  assert.equal(latest.get("d").verdict, "allow");
});

test("useAIVerdicts: enabled=false does nothing", { skip }, async () => {
  function Off({ items }) { latest = useAIVerdicts(items, { enabled: false }); return null; }
  await mount(<Off items={[it("a", "This is a perfectly ordinary long post text")]} />);
  assert.equal(calls.length, 0);
  assert.equal(latest.size, 0);
});

// ── CommentsSection ────────────────────────────────────────────────────────

const mkComment = (id, content) => ({
  id, lens_comment_id: id, content, media_urls: [], media_types: [], created_at: "2026-09-19T10:00:00Z", is_external_app: false,
  author: { id: "0xA" + id, name: "Name " + id, unique_name: "u" + id, country: null, wallet_address: "0xA" + id },
  truth_count: 0, false_count: 0, my_reaction: null,
});
const section = (comments, extra = {}) => (
  <MemoryRouter>
    <CommentsSection
      comments={comments} lensProfile={{ address: "0xME", name: "Me" }} postingComment={false}
      onSubmitComment={() => {}} onDeleteComment={() => {}} onReactComment={() => {}} onReportComment={() => {}}
      isCommentOwner={() => false} getCountryDisplayName={() => "Earth"} formatDate={() => "d"} {...extra}
    />
  </MemoryRouter>
);

test("CommentsSection: a flagged comment is collapsed, 'Show anyway' reveals it", { skip }, async () => {
  const good = "The officers detained my brother without a warrant.";
  const bad = "SPAMMY great post visit my profile for crypto tips";
  const { el } = await mount(section([mkComment("c1", good), mkComment("c2", bad)], { moderationContext: "Post about an arbitrary arrest" }));

  assert.match(el.textContent, /officers detained my brother/, "normal comment untouched");
  assert.doesNotMatch(el.textContent, /visit my profile/, "flagged text is NOT rendered");
  assert.match(el.textContent, /Atticus AI flagged this comment automatically \(reason: spam\)/);

  // The parent post's text travelled as context, and identity did not.
  assert.equal(calls[0].items[0].context, "Post about an arbitrary arrest");
  assert.doesNotMatch(JSON.stringify(calls), /0xAc1|0xAc2|Name c1/);

  await click(btn(el, "Show anyway"));
  assert.match(el.textContent, /visit my profile/);
  assert.doesNotMatch(el.textContent, /flagged this comment automatically/);
});

test("CommentsSection: notice is shown in the user's language", { skip }, async () => {
  await i18n.changeLanguage("uk");
  const { el } = await mount(section([mkComment("c2", "SPAMMY great post visit my profile for crypto tips")]));
  assert.match(el.textContent, /Atticus AI автоматично позначив цей коментар \(причина: спам\)/);
  assert.ok(btn(el, "Все одно показати"));
});

test("CommentsSection: no verdict (service down) → everything renders normally", { skip }, async () => {
  globalThis.fetch = async () => new Response("{}", { status: 500 });
  const { el } = await mount(section([mkComment("c2", "SPAMMY great post visit my profile for crypto tips")]));
  assert.match(el.textContent, /visit my profile/);
  assert.doesNotMatch(el.textContent, /Atticus AI/);
});

// ── PostCard ───────────────────────────────────────────────────────────────

const card = (props) => (
  <MemoryRouter>
    <PostCard
      post={{ id: "p1", content: "hello", createdAt: "2026-09-19T10:00:00Z", author: { address: "0xA", name: "N", handle: "@n", avatar: null }, media: [], commentCount: 0, shareCount: 0 }}
      countryBadge={null} reaction={{ truth: 0, false: 0, mine: null }} {...props}
    />
  </MemoryRouter>
);

test("PostCard: AI blur notice replaces the Shield/Senate text; default is unchanged", { skip }, async () => {
  const withAI = await mount(card({ isBlurred: true, blurNotice: "⚠️ Atticus AI flagged this post automatically (reason: spam). It is awaiting human review." }));
  assert.match(withAI.el.textContent, /Atticus AI flagged this post/);
  assert.doesNotMatch(withAI.el.textContent, /Shield\/Senate/);
  assert.ok(btn(withAI.el, "Show it anyway"));

  const plain = await mount(card({ isBlurred: true }));
  assert.match(plain.el.textContent, /flagged by Shield\/Senate as potentially harmful/);

  const notBlurred = await mount(card({ isBlurred: false, blurNotice: "should not show" }));
  assert.doesNotMatch(notBlurred.el.textContent, /should not show/);
});

test.after(() => { globalThis.fetch = realFetch; });
