// A guard against the classic way safety features rot: someone adds a NEW way
// to publish content (a forum post, or an on-chain proposal) and forgets the
// AI check. This test reads the source tree and fails if any file that
// publishes content does so without the right gate running BEFORE it —
// unless the file is listed below WITH a reason it carries no user-written
// text worth screening.
//
// Two different gates are checked, because they have different POLICIES:
//   • assertPublishAllowed()      — forum posts (fail-open by default)
//   • assertPublishAllowed({ kind: "proposal" }) — governance proposals
//     (MANDATORY by kind: proposals have no other moderation once on-chain)
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");

// Files that legitimately publish WITHOUT the text gate, and why.
const EXEMPT = {
  // Reports and the moderation action log are internal signals to
  // moderators, structured/JSON, and — like dossier's equivalents — are
  // deliberately not AI-screened; a flood of reports only ever feeds a
  // human-reviewed queue, it can't by itself take anything down.
  "src/lib/forumModeration.js": "publishModAction() writes a structured moderation-log event, not free user text",
  // The low-level Nostr publishing helper itself (defines publishEvent()) —
  // every CALLER is checked instead, same reasoning as dossier's lib/grove.js.
  "src/lib/nostrLookup.js": "defines publishEvent() itself; every caller is checked instead",
};
const REPORT_EXEMPT_FN = "reportPost"; // inside useForum.js — see below, checked separately

const PUBLISH_PRIMITIVES = [/\bpublishEvent\(/];
const GATE = /\bassertPublishAllowed\(/;

/** Start index of the NEXT `= useCallback(` after the declaration beginning at `idx`. */
function nextCallbackStart(text, idx, declaration) {
  const next = text.indexOf("= useCallback(", idx + declaration.length);
  return next === -1 ? text.length : next;
}

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(js|jsx)$/.test(f) ? [p] : [];
  });
}

/** Drops whole-line comments so prose mentioning `publishEvent(` isn't mistaken for code. */
function code(text) {
  let inBlock = false;
  return text
    .split("\n")
    .map((line) => {
      const t = line.trim();
      if (inBlock) {
        if (t.includes("*/")) inBlock = false;
        return "";
      }
      if (t.startsWith("/*")) {
        if (!t.includes("*/")) inBlock = true;
        return "";
      }
      return t.startsWith("//") || t.startsWith("*") ? "" : line;
    })
    .join("\n");
}

const files = walk(SRC).map((f) => ({ rel: path.relative(process.cwd(), f).split(path.sep).join("/"), text: code(readFileSync(f, "utf8")) }));

test("the scan actually finds the publishing code (guards against a silently empty test)", () => {
  const withPublish = files.filter((f) => PUBLISH_PRIMITIVES.some((re) => re.test(f.text))).map((f) => f.rel);
  for (const expected of ["src/hooks/useForum.js"]) {
    assert.ok(withPublish.includes(expected), `expected to find publishEvent() in ${expected}`);
  }
});

test("every publishEvent() call (forum threads/replies) is preceded by assertPublishAllowed(), except reportPost/publishModAction", () => {
  const problems = [];
  for (const f of files) {
    if (f.rel in EXEMPT) continue;
    const isForumHook = f.rel.endsWith("useForum.js");

    const tokens = [];
    for (const re of PUBLISH_PRIMITIVES) for (const m of f.text.matchAll(new RegExp(re.source, "g"))) tokens.push({ at: m.index, kind: "publish", what: m[0] });
    if (tokens.length === 0) continue;
    for (const m of f.text.matchAll(new RegExp(GATE.source, "g"))) tokens.push({ at: m.index, kind: "gate" });
    tokens.sort((a, b) => a.at - b.at);

    // In useForum.js, reportPost()'s own publishEvent() call is exempt — find
    // its function body's span and skip publish-tokens that fall inside it.
    let reportSpan = null;
    if (isForumHook) {
      const decl = `const ${REPORT_EXEMPT_FN} = useCallback(`;
      const idx = f.text.indexOf(decl);
      if (idx !== -1) reportSpan = [idx, nextCallbackStart(f.text, idx, decl)];
    }

    let armed = false;
    for (const t of tokens) {
      if (t.kind === "gate") {
        armed = true;
        continue;
      }
      const inReportSpan = reportSpan && t.at >= reportSpan[0] && t.at < reportSpan[1];
      if (inReportSpan) continue; // reportPost is exempt regardless of gate state
      if (!armed) problems.push(`${f.rel}: \`${t.what}\` publishes without a preceding assertPublishAllowed()`);
      else armed = false;
    }
  }
  assert.deepEqual(problems, [], `Unguarded publish paths:\n  ${problems.join("\n  ")}`);
});

test("submitProposal() runs the MANDATORY check (kind: \"proposal\") after validation and before the on-chain call", () => {
  const f = files.find((x) => x.rel === "src/hooks/useDao.js");
  assert.ok(f, "src/hooks/useDao.js not found");
  const decl = "const submitProposal = useCallback(";
  const idx = f.text.indexOf(decl);
  assert.ok(idx !== -1, "submitProposal not found");
  const body = f.text.slice(idx, nextCallbackStart(f.text, idx, decl));

  assert.match(body, /assertPublishAllowed\(/, "submitProposal must call assertPublishAllowed()");
  assert.match(body, /kind:\s*"proposal"/, "submitProposal's check must use kind: \"proposal\" — that kind is what makes it mandatory");
  assert.doesNotMatch(body, /forceStrict:\s*false/, "never switch the proposal check off");

  const gateAt = body.indexOf("assertPublishAllowed(");
  // Order 1: BEFORE the chain call.
  const chainCallAt = body.indexOf(".proposeScoped(");
  assert.ok(chainCallAt === -1 || gateAt < chainCallAt, "the AI check must run BEFORE proposeScoped(), not after");
  // Order 2: AFTER the parameter validation (an invalid proposal must not cost a Gemini call).
  for (const marker of ['"missing_target"', "A link to the policy text is required", "invalid target address"]) {
    const at = body.indexOf(marker);
    assert.ok(at !== -1, `validation marker ${marker} not found — update this test`);
    assert.ok(at < gateAt, `the AI check must come AFTER the validation "${marker}"`);
  }
});

test("MANDATORY_KINDS still contains \"proposal\" (removing it would silently make proposals fail open)", async () => {
  const { MANDATORY_KINDS } = await import("../../src/lib/aiModeration");
  assert.ok(MANDATORY_KINDS.has("proposal"));
});

test("createThread judges title+body (threadModerationText) and postReply passes the parent context", () => {
  const f = files.find((x) => x.rel === "src/hooks/useForum.js");
  assert.ok(f, "src/hooks/useForum.js not found");
  const thread = f.text.slice(f.text.indexOf("const createThread = useCallback("), f.text.indexOf("const postReply = "));
  assert.match(thread, /threadModerationText\(title,\s*body\)/, "createThread must moderate the TITLE together with the body");
  assert.match(thread, /assertPublishAllowed\(\{\s*text:\s*moderationText/, "the last-line guard must judge the same title+body text");
  const reply = f.text.slice(f.text.indexOf("const postReply = "), f.text.indexOf("const reportPost = "));
  assert.match(reply, /postReply = useCallback\(async \(threadId, body, context/, "postReply must accept the parent-thread context");
  assert.match(reply, /checkForumRateLimit\([^)]*context/, "postReply must forward the context to the gate");
});

test("the exemption list stays honest: every exempt file exists and still publishes", () => {
  for (const rel of Object.keys(EXEMPT)) {
    const f = files.find((x) => x.rel === rel);
    assert.ok(f, `${rel} no longer exists — remove it from EXEMPT`);
  }
});
