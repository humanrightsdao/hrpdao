// utils/aiMediaModeration.js — the browser gate for images/video/PDF.
// Real Canvas/<video> decoding is stubbed (stubs/aiMediaPrep.mjs, wired in
// scripts/run-client-tests.mjs) — this tests the GATE logic, not pixel work.
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import i18n from "../../src/i18n";
import {
  checkMediaBeforePublish,
  checkMediaFilesBeforePublish,
  assertMediaPublishAllowed,
  _resetAIMediaModerationState,
} from "../../src/utils/aiMediaModeration";
import { _setModerationMode, getAIActivity, clearAIActivity } from "../../src/utils/aiModeration";

const realFetch = globalThis.fetch;
let calls;
let mode; // "ok" | "500" | "429" | "network" | "disabled"

const classify = (parts) => {
  const marker = parts[0]?.data || "";
  if (marker.includes("BLOCKME")) return { verdict: "block", severity: 2, categories: ["sexual_content"], confidence: 0.9, source: "ai" };
  if (marker.includes("FLAGME")) return { verdict: "flag", severity: 1, categories: ["graphic_violence"], confidence: 0.7, source: "ai" };
  return { verdict: "allow", severity: 0, categories: [], confidence: 0.95, source: "ai" };
};

beforeEach(async () => {
  _resetAIMediaModerationState();
  _setModerationMode({ strict: true });
  clearAIActivity();
  await i18n.changeLanguage("en");
  calls = [];
  mode = "ok";
  delete globalThis.__prepareMedia;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (mode === "network") throw new TypeError("Failed to fetch");
    if (mode === "429") return new Response("{}", { status: 429, headers: { "Retry-After": "20" } });
    if (mode === "500") return new Response("{}", { status: 500 });
    if (mode === "disabled") return new Response(JSON.stringify({ success: true, disabled: true, results: [] }), { status: 200 });
    return new Response(
      JSON.stringify({ success: true, results: body.items.map((it) => ({ id: it.id, ...classify(it.parts) })) }),
      { status: 200 },
    );
  };
});

// The real File constructor doesn't exist in this plain-Node test target;
// jsdom (loaded via setup-dom.mjs) provides window.File instead of a global one.
const file = ({ type = "image/png", marker = "OK" } = {}) => {
  const f = new window.File(["x"], "test.png", { type });
  f.__marker = marker;
  return f;
};

test("checkMediaBeforePublish: allow / flag / block, each recorded in the activity log", async () => {
  const ok = await checkMediaBeforePublish(file({ marker: "OK" }));
  assert.deepEqual([ok.allowed, ok.result.verdict], [true, "allow"]);

  _resetAIMediaModerationState();
  const flagged = await checkMediaBeforePublish(file({ marker: "FLAGME" }));
  assert.deepEqual([flagged.allowed, flagged.result.verdict], [true, "flag"], "flag is published, not blocked");

  _resetAIMediaModerationState();
  const blocked = await checkMediaBeforePublish(file({ marker: "BLOCKME" }));
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /Atticus AI stopped this file/);
  assert.match(blocked.reason, /sexual content/);

  const log = getAIActivity();
  assert.equal(log.length, 3);
  assert.deepEqual(log.map((e) => e.verdict), ["block", "flag", "allow"]);
  assert.ok(log.every((e) => e.kind === "media" && typeof e.fileType === "string"));
});

test("checkMediaBeforePublish: video sends multiple frame parts; PDF sends its own mime", async () => {
  globalThis.__prepareMedia = async (f) => ({
    kind: "video",
    parts: [{ mime: "image/jpeg", data: "F1" }, { mime: "image/jpeg", data: "F2" }, { mime: "image/jpeg", data: "F3" }],
  });
  await checkMediaBeforePublish(file({ type: "video/mp4" }));
  assert.equal(calls[0].items[0].kind, "video");
  assert.equal(calls[0].items[0].parts.length, 3);

  globalThis.__prepareMedia = async () => ({ kind: "pdf", parts: [{ mime: "application/pdf", data: "PDFDATA" }] });
  await checkMediaBeforePublish(file({ type: "application/pdf" }));
  assert.equal(calls[1].items[0].kind, "pdf");
});

test("unsupported file type: refused in strict mode (no network call)", async () => {
  const r = await checkMediaBeforePublish(file({ type: "application/x-msdownload" }));
  assert.equal(r.allowed, false);
  assert.equal(r.unavailable, true);
  assert.match(r.reason, /can't be safety-checked/);
  assert.equal(calls.length, 0);
  const [log] = getAIActivity();
  assert.deepEqual([log.unavailable, log.refused, log.mediaKind], [true, true, null]);
});

test("unsupported file type: published in open mode", async () => {
  _setModerationMode({ strict: false });
  const r = await checkMediaBeforePublish(file({ type: "application/x-msdownload" }));
  assert.equal(r.allowed, true);
});

test("preparation failure (decode error) is treated the same as 'no verdict'", async () => {
  globalThis.__prepareMedia = async () => { throw new Error("Could not decode the image"); };
  const r = await checkMediaBeforePublish(file());
  assert.equal(r.allowed, false);
  assert.equal(r.unavailable, true);
  assert.equal(calls.length, 0, "never reaches the network without a prepared payload");
});

for (const [label, arrange] of [
  ["HTTP 500", () => { mode = "500"; }],
  ["network error", () => { mode = "network"; }],
]) {
  test(`outage (${label}): STRICT mode refuses, OPEN mode publishes`, async () => {
    arrange();
    const strict = await checkMediaBeforePublish(file());
    assert.equal(strict.allowed, false);
    assert.equal(strict.unavailable, true);
    assert.match(strict.reason, /couldn't be completed/);

    _resetAIMediaModerationState();
    _setModerationMode({ strict: false });
    const open = await checkMediaBeforePublish(file());
    assert.equal(open.allowed, true);
  });
}

test("429 opens a circuit breaker honouring Retry-After", async () => {
  mode = "429";
  await checkMediaBeforePublish(file({ marker: "a" }));
  mode = "ok";
  const t0 = Date.now();
  const during = await checkMediaBeforePublish(file({ marker: "b" }));
  assert.equal(during.allowed, false, "breaker still open, no new call");
  assert.equal(calls.length, 1);
});

test("a deliberate operator switch-off is remembered and does not hold anything back", async () => {
  mode = "disabled";
  const first = await checkMediaBeforePublish(file({ marker: "a" }));
  assert.equal(first.allowed, true);
  const n = calls.length;
  const second = await checkMediaBeforePublish(file({ marker: "b" }));
  assert.equal(second.allowed, true);
  assert.equal(calls.length, n, "switch-off remembered for a while, no repeat request");
});

test("checkMediaFilesBeforePublish: stops at the FIRST refusal, later files are not checked", async () => {
  const files = [file({ marker: "OK" }), file({ marker: "BLOCKME" }), file({ marker: "OK" })];
  const r = await checkMediaFilesBeforePublish(files);
  assert.equal(r.allowed, false);
  assert.equal(r.file, files[1]);
  assert.equal(calls.length, 2, "the third file was never sent");
});

test("checkMediaFilesBeforePublish: all clear when every file passes", async () => {
  const r = await checkMediaFilesBeforePublish([file({ marker: "OK" }), file({ marker: "FLAGME" })]);
  assert.equal(r.allowed, true);
});

test("assertMediaPublishAllowed: throws a ready-to-show error with the offending file attached", async () => {
  const files = [file({ marker: "OK" }), file({ marker: "BLOCKME" })];
  await assert.rejects(
    () => assertMediaPublishAllowed(files, { kind: "comment" }),
    (err) => err.code === "MODERATION_BLOCKED" && err.file === files[1] && /Atticus AI stopped this file/.test(err.message),
  );
  await assert.doesNotReject(() => assertMediaPublishAllowed([file({ marker: "OK" })]));
});

test("assertMediaPublishAllowed: strict + outage throws 'unavailable'", async () => {
  mode = "500";
  await assert.rejects(
    () => assertMediaPublishAllowed([file()], { kind: "post" }),
    (err) => err.code === "MODERATION_BLOCKED" && err.unavailable === true,
  );
});

test("localisation: the blocked reason is shown in Ukrainian", async () => {
  await i18n.changeLanguage("uk");
  const r = await checkMediaBeforePublish(file({ marker: "BLOCKME" }));
  assert.match(r.reason, /Atticus AI зупинив публікацію цього файлу/);
  assert.match(r.reason, /сексуальний контент/);
});

test.after(() => { globalThis.fetch = realFetch; delete globalThis.__prepareMedia; });
