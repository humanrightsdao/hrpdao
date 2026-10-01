// A DEDICATED file so the module-level default (derived from
// import.meta.env.VITE_AI_MODERATION_MODE at load time) is observed before
// anything calls _setModerationMode() — each test file gets its own isolated
// bundle (see scripts/run-client-tests.mjs), so this is safe regardless of
// what other test files do.
//
// This guards the actual PRODUCT DECISION: publishing must fail OPEN by
// default (see the header comment in lib/aiModeration.js for the reasoning
// — this ecosystem's ability to publish must not depend on one third-party
// AI service's uptime). If this test ever needs to change, that is a
// deliberate policy change, not a refactor accident.
//
// The one deliberate EXCEPTION is governance proposals: kind "proposal" is in
// MANDATORY_KINDS (lib/aiModeration.js), so it fails closed regardless of
// this default — see the proposal tests in aiModeration.test.jsx.
import test from "node:test";
import assert from "node:assert/strict";
import { failsClosed } from "../../src/lib/aiModeration";

test("DEFAULT mode (no VITE_AI_MODERATION_MODE set) is OPEN for forum content: nothing fails closed out of the box", () => {
  for (const kind of ["forum_thread", "forum_reply", "post", "comment"]) {
    assert.equal(failsClosed(kind), false, `${kind} must not fail closed by default`);
  }
});

test("…except governance proposals, which are MANDATORY by kind even in the default open mode", () => {
  assert.equal(failsClosed("proposal"), true);
});
