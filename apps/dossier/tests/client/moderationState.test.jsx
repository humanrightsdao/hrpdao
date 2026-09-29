// computeModerationState() with the new `aiVerdict` input.
import test from "node:test";
import assert from "node:assert/strict";
import { computeModerationState, MOD_ACTIONS } from "../../src/utils/moderationActions";

const POST = "post-1";
const act = (action, at, moderator = "0xMOD1") => ({ targetPostId: POST, action, createdAt: new Date(at).toISOString(), moderator });
const flag = { verdict: "flag", severity: 1, categories: ["spam"], confidence: 0.8 };
const block = { verdict: "block", severity: 2, categories: ["hate_speech"], confidence: 0.95 };

test("no AI input → behaviour identical to before (backward compatible)", () => {
  const s = computeModerationState([], POST);
  assert.equal(s.blurred, false);
  assert.equal(s.aiQuarantined, false);
  assert.equal(s.aiVerdict, null);
  assert.equal(computeModerationState([], POST, { reports: [] }).blurred, false);
});

test("'flag' and 'block' verdicts blur the post", () => {
  for (const v of [flag, block]) {
    const s = computeModerationState([], POST, { aiVerdict: v });
    assert.equal(s.blurred, true);
    assert.equal(s.aiQuarantined, true);
    assert.equal(s.aiVerdict, v);
    assert.equal(s.hidden, false, "AI never hides");
  }
});

test("'allow', missing and degraded verdicts do nothing (fail open)", () => {
  assert.equal(computeModerationState([], POST, { aiVerdict: { verdict: "allow" } }).blurred, false);
  assert.equal(computeModerationState([], POST, { aiVerdict: null }).blurred, false);
  assert.equal(computeModerationState([], POST, { aiVerdict: { ...block, degraded: true } }).blurred, false);
});

test("an explicit moderator UNBLUR overrides the AI", () => {
  const s = computeModerationState([act(MOD_ACTIONS.BLUR, 1000), act(MOD_ACTIONS.UNBLUR, 2000)], POST, { aiVerdict: block });
  assert.equal(s.blurred, false);
  assert.equal(s.aiQuarantined, false);
  // even a moderator who unblurred BEFORE the AI ever looked wins
  const early = computeModerationState([act(MOD_ACTIONS.UNBLUR, 1)], POST, { aiVerdict: flag });
  assert.equal(early.blurred, false);
});

test("a manual BLUR is not reported as an AI quarantine", () => {
  const s = computeModerationState([act(MOD_ACTIONS.BLUR, 1000)], POST, { aiVerdict: flag });
  assert.equal(s.blurred, true);
  assert.equal(s.aiQuarantined, false);
  assert.equal(s.aiVerdict, null);
});

test("a hidden post stays hidden; AI adds nothing", () => {
  const s = computeModerationState([act(MOD_ACTIONS.HIDE, 1000)], POST, { aiVerdict: block });
  assert.equal(s.hidden, true);
  assert.equal(s.aiQuarantined, false);
});

test("actions for other posts are ignored", () => {
  const other = { ...act(MOD_ACTIONS.UNBLUR, 1000), targetPostId: "post-2" };
  const s = computeModerationState([other], POST, { aiVerdict: flag });
  assert.equal(s.aiQuarantined, true);
});
