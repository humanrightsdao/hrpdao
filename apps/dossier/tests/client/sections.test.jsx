// ModerationSections: the tabbed structure of the Управління page.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import ModerationSections from "../../src/components/ModerationSections";

const skip = globalThis.__NO_DOM__ ? "jsdom not installed (npm i -D jsdom)" : false;
const act = React.act;
const mounts = { community: 0, ai: 0 };

function Panel({ name }) {
  useEffect(() => { mounts[name]++; }, [name]);
  const [n, setN] = useState(0);
  return <button data-testid={`counter-${name}`} onClick={() => setN(n + 1)}>{name} clicks {n}</button>;
}
const sections = () => [
  { id: "community", label: "Community moderation", description: "People decide.", content: <Panel name="community" /> },
  { id: "ai", label: "AI moderation", description: "The first line.", content: <Panel name="ai" /> },
];

beforeEach(() => {
  mounts.community = 0;
  mounts.ai = 0;
  window.history.replaceState(null, "", "/governance");
});

const mount = async (props = {}) => {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => { root.render(<ModerationSections sections={sections()} initial="community" {...props} />); });
  return el;
};
const click = (n) => act(async () => { n.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
const tab = (el, id) => el.querySelector(`#modtab-${id}`);
const panel = (el, id) => el.querySelector(`#modpanel-${id}`);

test("two tabs; the initial one is selected and explained", { skip }, async () => {
  const el = await mount();
  assert.equal(el.querySelectorAll('[role="tab"]').length, 2);
  assert.equal(tab(el, "community").getAttribute("aria-selected"), "true");
  assert.equal(tab(el, "ai").getAttribute("aria-selected"), "false");
  assert.match(el.textContent, /People decide\./);
  assert.doesNotMatch(el.textContent, /The first line\./);
  assert.equal(panel(el, "community").hidden, false);
});

test("a section is mounted on first visit only, then kept (state is not lost, nothing reloads)", { skip }, async () => {
  const el = await mount();
  assert.equal(panel(el, "ai"), null, "AI panel is not mounted until it is opened");
  assert.deepEqual([mounts.community, mounts.ai], [1, 0]);

  await click(el.querySelector('[data-testid="counter-community"]'));
  await click(tab(el, "ai"));
  assert.deepEqual([mounts.community, mounts.ai], [1, 1]);
  assert.equal(panel(el, "community").hidden, true);
  assert.equal(panel(el, "ai").hidden, false);
  assert.match(el.textContent, /The first line\./, "description follows the tab");

  await click(tab(el, "community"));
  assert.deepEqual([mounts.community, mounts.ai], [1, 1], "switching back does NOT remount");
  assert.match(el.querySelector('[data-testid="counter-community"]').textContent, /clicks 1/, "state survived the round trip");
});

test("the open tab is mirrored in the URL hash, and a hash opens that tab", { skip }, async () => {
  const el = await mount();
  await click(tab(el, "ai"));
  assert.equal(window.location.hash, "#ai");
  assert.equal(window.location.pathname, "/governance");

  window.history.replaceState(null, "", "/governance?case=42#ai");
  const linked = await mount();
  assert.equal(tab(linked, "ai").getAttribute("aria-selected"), "true");

  await click(tab(linked, "community"));
  assert.equal(window.location.search, "?case=42", "the ?case= deep link is preserved");
  assert.equal(window.location.hash, "#community");
});

test("an unknown hash is ignored; `initial` decides", { skip }, async () => {
  window.history.replaceState(null, "", "/governance#nonsense");
  const el = await mount({ initial: "ai" });
  assert.equal(tab(el, "ai").getAttribute("aria-selected"), "true");
});

test("keyboard: ← → Home End move between tabs and focus follows", { skip }, async () => {
  const el = await mount();
  const key = (k) => act(async () => { tab(el, document.activeElement?.id?.replace("modtab-", "") || "community").dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true })); });
  tab(el, "community").focus();
  await key("ArrowRight");
  assert.equal(tab(el, "ai").getAttribute("aria-selected"), "true");
  assert.equal(document.activeElement, tab(el, "ai"));
  await key("ArrowRight");
  assert.equal(tab(el, "community").getAttribute("aria-selected"), "true", "wraps around");
  await key("End");
  assert.equal(tab(el, "ai").getAttribute("aria-selected"), "true");
  await key("Home");
  assert.equal(tab(el, "community").getAttribute("aria-selected"), "true");
});

test("accessibility wiring: tablist, tab↔panel ids, roving tabindex", { skip }, async () => {
  const el = await mount();
  await click(tab(el, "ai"));
  assert.ok(el.querySelector('[role="tablist"]'));
  assert.equal(tab(el, "ai").getAttribute("aria-controls"), "modpanel-ai");
  assert.equal(panel(el, "ai").getAttribute("aria-labelledby"), "modtab-ai");
  assert.equal(tab(el, "ai").tabIndex, 0);
  assert.equal(tab(el, "community").tabIndex, -1);
});
