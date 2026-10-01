// Regression: "Cannot access 'FORUM_TAG' before initialization" (forumModeration.js:30).
//
// useForum.js and forumModeration.js used to import each other. forumModeration
// builds MOD_ACTION_TAG from FORUM_TAG AT MODULE LOAD, so whichever of the two
// the app happened to load first decided the outcome: a ReferenceError in the
// browser (native ES modules) — or, in a bundle, the silently wrong tag
// "undefined-mod-action", i.e. the forum's moderation queue querying nothing.
// The tags now live in lib/forumTags.js, a module with no imports.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
// Importing useForum FIRST is the order that used to break.
import { FORUM_TAG, FORUM_REPORT_TAG } from "../../src/hooks/useForum";
import { MOD_ACTION_TAG } from "../../src/lib/forumModeration";

test("useForum → forumModeration load order works and the tags agree", () => {
  assert.equal(FORUM_TAG, "hrpdao-forum");
  assert.equal(MOD_ACTION_TAG, `${FORUM_TAG}-mod-action`);
  assert.equal(FORUM_REPORT_TAG, `${FORUM_TAG}-report`);
});

test("lib/ modules never import from hooks/useForum (that is what made the cycle)", () => {
  const dir = path.resolve(process.cwd(), "src/lib");
  const offenders = readdirSync(dir)
    .filter((f) => /\.(js|jsx)$/.test(f))
    .filter((f) => /^\s*(import|export)\b[^;]*from\s+["']\.\.\/hooks\/useForum["']/m.test(readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(offenders, [], `import the tags from ./forumTags instead: ${offenders.join(", ")}`);
});

test("forumTags.js is a leaf module (no imports of its own)", () => {
  const src = readFileSync(path.resolve(process.cwd(), "src/lib/forumTags.js"), "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
});
