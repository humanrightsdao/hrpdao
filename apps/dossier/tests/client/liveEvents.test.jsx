// Picked up by: node scripts/run-client-tests.mjs (npm run test:moderation)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  isSafeSourceUrl,
  isMinorEvent,
  isConflictEvent,
  getEventType,
  getEventLevel,
  EVENT_TYPES,
} from "../../src/utils/liveEvents.js";

test("escapeHtml neutralises markup coming from a feed", () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">&\''),
    "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;",
  );
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(42), "42");
});

test("only links to known sources are allowed in an href", () => {
  assert.ok(isSafeSourceUrl("https://www.gdacs.org/report.aspx?eventid=1"));
  assert.ok(!isSafeSourceUrl("javascript:alert(1)"));
  assert.ok(!isSafeSourceUrl("https://www.gdacs.org.evil.com/x"));
  assert.ok(!isSafeSourceUrl("http://www.gdacs.org/x"));
  assert.ok(!isSafeSourceUrl(null));
});

test("green events count as minor; conflict events are told apart from natural ones", () => {
  assert.ok(isMinorEvent({ level: "green" }));
  assert.ok(isMinorEvent({ level: "weird" }));
  assert.ok(!isMinorEvent({ level: "orange" }));
  assert.ok(!isMinorEvent({ level: "red" }));
  assert.ok(isConflictEvent({ category: "conflict" }));
  assert.ok(!isConflictEvent({ category: "natural" }));
  assert.ok(!isConflictEvent(null));
});

test("unknown hazard codes and levels fall back safely", () => {
  assert.equal(getEventType("XX").key, "event");
  assert.equal(getEventLevel("nope").key, "green");
  // every code the Worker emits (GDACS + ACLED) has a marker
  for (const code of ["EQ", "TC", "FL", "VO", "WF", "TS", "BAT", "VAC", "EXP"]) assert.ok(EVENT_TYPES[code]);
});
