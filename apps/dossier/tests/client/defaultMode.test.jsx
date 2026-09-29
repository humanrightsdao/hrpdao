// A DEDICATED file so the module-level default (derived from
// import.meta.env.VITE_AI_MODERATION_MODE at load time) is observed before
// anything calls _setModerationMode() — each test file gets its own isolated
// bundle (see scripts/run-client-tests.mjs), so this is safe regardless of
// what other test files do.
//
// This guards the actual PRODUCT DECISION: publishing must fail OPEN by
// default (see the header comment in utils/aiModeration.js for the reasoning
// — a human-rights platform's ability to publish, including urgent help
// requests, must not depend on one third-party AI service's uptime). If this
// test ever needs to change, that is a deliberate policy change, not a
// refactor accident.
import test from "node:test";
import assert from "node:assert/strict";
import { failsClosed } from "../../src/utils/aiModeration";

test("DEFAULT mode (no VITE_AI_MODERATION_MODE set) is OPEN: nothing fails closed out of the box", () => {
  for (const kind of ["post", "comment", "violation", "help_request", "profile", "media"]) {
    assert.equal(failsClosed(kind), false, `${kind} must not fail closed by default`);
  }
});
