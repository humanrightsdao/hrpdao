// A guard against the classic way safety features rot: someone adds a NEW way
// to publish to Lens and forgets the AI check. This test reads the source tree
// and fails if any file that sends content to Lens (post / postToLens / editPost /
// setAccountMetadata) does so without assertPublishAllowed() running BEFORE it —
// unless the file is listed below WITH a reason it carries no user-written text.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "src");

// Files that legitimately publish WITHOUT the text gate, and why.
const EXEMPT = {
  "src/lib/countryRatings.js": "stores numeric country ratings only — no free text",
  "src/hooks/useNostrIdentity.jsx": "writes a Nostr public-key attribute into account metadata — no user-written text",
  "src/context/LensAuthContext.jsx": "creates an account with FIXED minimal metadata (name/bio are placeholders, not user text)",
};

const PRIMITIVES = [
  /\bpost\(\s*(sessionClient|activeSessionClient|session|client)\b/,
  /\bpostToLens\(/,
  /\beditPost\(/,
  /\bsetAccountMetadata\(/,
];
// Only the PUBLIC entry points a screen calls to actually publish media —
// not the low-level storageClient.uploadFile()/uploadFileToGrove() calls
// INSIDE those helpers' own implementation (defined once near the top of
// each file, so they'd textually precede any gate and produce a false
// positive; they are only ever reached through an already-gated call site).
const UPLOAD_PRIMITIVES = [/\buploadAllFilesToGrove\(/, /\buploadFilesToGrove\(/];
const GATE = /\bassertPublishAllowed\(/;
const MEDIA_GATE = /\bassertMediaPublishAllowed\(/;
// Files that upload media to Grove/Lens but never need the MEDIA gate.
const MEDIA_EXEMPT = {
  "src/lib/grove.js": "the low-level upload helper itself — every CALLER is checked instead",
  "src/pages/NostrChatPage.jsx": "uploads an image for an E2E-ENCRYPTED Nostr direct message — private communication is deliberately not screened (see AI_MODERATION.md)",
};

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(js|jsx)$/.test(f) ? [p] : [];
  });
}

/** Drops whole-line comments so that prose mentioning `post(sessionClient` isn't mistaken for code. */
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
  const withPrimitives = files.filter((f) => PRIMITIVES.some((re) => re.test(f.text))).map((f) => f.rel);
  for (const expected of ["src/hooks/useLensPosts.js", "src/hooks/useLensHelpRequests.js", "src/pages/ViolationsPage.jsx", "src/components/ProfileEditModal.jsx"]) {
    assert.ok(withPrimitives.includes(expected), `expected to find publishing code in ${expected}`);
  }
});

test("every media upload is preceded by assertMediaPublishAllowed() (or the file is explicitly exempt)", () => {
  const problems = [];
  for (const f of files) {
    if (f.rel in MEDIA_EXEMPT) continue;
    const tokens = [];
    for (const re of UPLOAD_PRIMITIVES) for (const m of f.text.matchAll(new RegExp(re.source, "g"))) tokens.push({ at: m.index, kind: "upload", what: m[0] });
    if (tokens.length === 0) continue;
    for (const m of f.text.matchAll(new RegExp(MEDIA_GATE.source, "g"))) tokens.push({ at: m.index, kind: "gate" });
    tokens.sort((a, b) => a.at - b.at);

    let armed = false;
    for (const t of tokens) {
      if (t.kind === "gate") armed = true;
      else if (!armed) problems.push(`${f.rel}: \`${t.what}\` uploads without a preceding assertMediaPublishAllowed()`);
      else armed = false;
    }
  }
  assert.deepEqual(problems, [], `Unguarded media upload paths:\n  ${problems.join("\n  ")}`);
});

test("the media scan finds the upload code (guards against a silently empty test)", () => {
  const withBatch = files.filter((f) => UPLOAD_PRIMITIVES.some((re) => re.test(f.text))).map((f) => f.rel);
  for (const expected of ["src/hooks/useLensPosts.js", "src/pages/ViolationsPage.jsx"]) {
    assert.ok(withBatch.includes(expected), `expected to find media upload code in ${expected}`);
  }
  // ProfileEditModal and useLensHelpRequests call uploadFileToGrove() directly
  // (not the batch helper) — checked by the single-file scan below instead.
  const withSingle = files.filter((f) => /\buploadFileToGrove\(/.test(f.text)).map((f) => f.rel);
  for (const expected of ["src/components/ProfileEditModal.jsx", "src/hooks/useLensHelpRequests.js"]) {
    assert.ok(withSingle.includes(expected), `expected to find media upload code in ${expected}`);
  }
});

test("every direct uploadFileToGrove() call (outside the batch helper's own file) is gated", () => {
  // useLensPosts.js/useLensHelpRequests.js each DEFINE their own local
  // uploadFileToGrove() helper; a call to it from WITHIN that same file can be
  // the helper's own internal loop (implementation detail, gated indirectly
  // through uploadAllFilesToGrove/its own public entry) rather than a second,
  // independent publish path — so only cross-file / component call sites are
  // checked here.
  const problems = [];
  for (const f of files) {
    if (f.rel in MEDIA_EXEMPT || f.rel.endsWith("useLensPosts.js") || f.rel.endsWith("useLensHelpRequests.js")) continue;
    const tokens = [];
    for (const m of f.text.matchAll(/\buploadFileToGrove\(/g)) tokens.push({ at: m.index, kind: "upload", what: m[0] });
    if (tokens.length === 0) continue;
    for (const m of f.text.matchAll(new RegExp(MEDIA_GATE.source, "g"))) tokens.push({ at: m.index, kind: "gate" });
    tokens.sort((a, b) => a.at - b.at);
    let armed = false;
    for (const t of tokens) {
      if (t.kind === "gate") armed = true;
      else if (!armed) problems.push(`${f.rel}: \`${t.what}\` uploads without a preceding assertMediaPublishAllowed()`);
      else armed = false;
    }
  }
  assert.deepEqual(problems, []);
});

test("every publish to Lens is preceded by assertPublishAllowed() (or the file is explicitly exempt)", () => {
  const problems = [];
  for (const f of files) {
    if (f.rel in EXEMPT) continue;
    // Walk the file in order: a gate "arms" the next publish call, a publish call "spends" it.
    const tokens = [];
    for (const re of PRIMITIVES) for (const m of f.text.matchAll(new RegExp(re.source, "g"))) tokens.push({ at: m.index, kind: "publish", what: m[0] });
    if (tokens.length === 0) continue;
    for (const m of f.text.matchAll(new RegExp(GATE.source, "g"))) tokens.push({ at: m.index, kind: "gate" });
    tokens.sort((a, b) => a.at - b.at);

    let armed = false;
    for (const t of tokens) {
      if (t.kind === "gate") armed = true;
      else if (!armed) problems.push(`${f.rel}: \`${t.what}\` publishes without a preceding assertPublishAllowed()`);
      else armed = false; // each publish needs its own gate
    }
  }
  assert.deepEqual(problems, [], `Unguarded publish paths:\n  ${problems.join("\n  ")}`);
});

test("the exemption list stays honest: every exempt file exists and still publishes", () => {
  for (const rel of Object.keys(EXEMPT)) {
    const f = files.find((x) => x.rel === rel);
    assert.ok(f, `${rel} no longer exists — remove it from EXEMPT`);
    assert.ok(PRIMITIVES.some((re) => re.test(f.text)), `${rel} no longer publishes — remove it from EXEMPT`);
    assert.ok(!GATE.test(f.text), `${rel} now has a gate — it no longer needs an exemption`);
  }
});

test("reports and the moderation log are not screened (they are app-written service comments)", () => {
  const src = files.find((f) => f.rel === "src/hooks/useLensPosts.js").text;
  assert.match(src, /!isReportComment\(content\) && !isModActionComment\(content\)/);
});
