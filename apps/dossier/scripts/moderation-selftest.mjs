// scripts/moderation-selftest.mjs
//
// One command that answers "is AI moderation actually working on this
// deployment?" — for production or local:
//
//   npm run moderation:selftest -- https://your-site.example
//   npm run moderation:selftest -- http://localhost:3005
//
// It calls /api/health and /api/moderate with a handful of SAFE probe texts
// (nothing is published anywhere — this talks to the moderation endpoint
// only) and prints a PASS / WARN / FAIL report with the likely cause of any
// failure. Exit code 1 if something that must work does not.
//
// The probes and the pass/fail logic live in src/utils/moderationProbes.js —
// the same module the Управління → "Atticus AI" panel uses, so the terminal and
// the UI always agree on what "working" means.

import { buildProbes, interpretHealth, evaluateProbes } from "../src/utils/moderationProbes.js";

const base = (process.argv[2] || "http://localhost:3005").replace(/\/+$/, "");

const c = {
  ok: (s) => `\x1b[32m✔ ${s}\x1b[0m`,
  warn: (s) => `\x1b[33m⚠ ${s}\x1b[0m`,
  fail: (s) => `\x1b[31m✖ ${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let failures = 0;
const line = (kind, msg) => {
  if (kind === "fail") failures++;
  console.log("  " + c[kind](msg));
};

async function http(path, init) {
  try {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(45_000), ...init });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { res, text, json };
  } catch (err) {
    return { error: err };
  }
}

console.log(c.bold(`\nAtticus Guard self-test → ${base}\n`));

// ── 1. health ──────────────────────────────────────────────────────────────
console.log(c.bold("1. Deployment"));
const health = await http("/api/health");
if (health.error) {
  line("fail", `cannot reach ${base}/api/health (${health.error.cause?.code || health.error.message})`);
  console.log(c.dim("     → wrong URL, the server is not running, or (local) `npm run server` was not started."));
  process.exit(1);
}
const h = interpretHealth(health.json);
if (h.state === "not_atticus") {
  line("fail", `/api/health did not answer like Atticus (HTTP ${health.res.status}) — is this the right site?`);
  process.exit(1);
}
line("ok", `Atticus is up (chat model: ${h.model})`);
if (h.state === "old_deployment") {
  line("fail", "this deployment has NO moderation: /api/health has no `moderation` section.");
  console.log(c.dim("     → an OLD Worker/server is deployed. Deploy the new worker/index.js + worker/moderation.js"));
  console.log(c.dim("       (local: replace server/index.js and add server/moderation.js, restart)."));
  process.exit(1);
}
line("ok", `moderation code is deployed (prompt ${h.promptVersion})`);
line(h.state !== "disabled" ? "ok" : "fail", h.state !== "disabled" ? "moderation is enabled" : "moderation is switched OFF (MODERATION_ENABLED=false)");
line(h.state !== "unconfigured" ? "ok" : "fail", h.state !== "unconfigured" ? "a Gemini API key is configured" : "no Gemini key configured (GEMINI_API_KEY / GEMINI_MODERATION_API_KEY)");
console.log("  " + c.dim(`shared cache (KV): ${h.sharedCache === undefined ? "n/a (local server)" : h.sharedCache ? "yes" : "no — per-isolate memory only"}`));

// ── 2. probes ──────────────────────────────────────────────────────────────
const probes = buildProbes();
console.log(c.bold("\n2. Probes") + c.dim("  (nothing is published — only the moderation endpoint is called)"));
const probeStart = Date.now();
const resp = await http("/api/moderate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ items: probes.map((p) => ({ id: p.id, kind: p.kind, text: p.text, context: p.context || "" })) }),
});

if (resp.error) {
  line("fail", `request to /api/moderate failed: ${resp.error.message}`);
  process.exit(1);
}
const status = resp.res.status;
if (status !== 200 || !resp.json?.success) {
  const hints = {
    404: "the deployed server has no /api/moderate route (old code).",
    403: "forbidden_origin — the Origin is not allowed (MODERATION_ALLOWED_ORIGINS).",
    429: "rate limited (240 items/min per IP) — wait and retry.",
    500: "server error — see the server log / `wrangler tail`; on the Vite dev proxy 500 with an empty body means the backend is not running.",
  };
  line("fail", `/api/moderate answered HTTP ${status}${resp.json?.error ? ` (${resp.json.error})` : ""} — ${hints[status] || "unexpected."}`);
  process.exit(1);
}
if (resp.json.disabled) {
  line("fail", "the server answered but moderation is DISABLED (MODERATION_ENABLED=false).");
  process.exit(1);
}

const probeMs = Date.now() - probeStart;
const report = evaluateProbes(probes, resp.json.results);
for (const row of report.rows) {
  if (row.level === "ok") line("ok", `${row.probe.label}\n      ${c.dim(row.detail)}`);
  else if (row.level === "warn") line("warn", `${row.probe.label}\n      ${c.dim(row.detail)}\n      ${c.dim("→ " + row.probe.why)}`);
  else line("fail", `${row.probe.label}\n      ${c.dim(row.detail)}\n      ${c.dim("→ " + row.probe.why)}`);
}
// evaluateProbes() also counts the "rules work but AI does not" case as one failure;
// row-level failures were already counted by line(), so only add that one.
const rowFailures = report.rows.filter((r) => r.level === "fail").length;
failures += report.failures - rowFailures;

// ── 3. verdict ─────────────────────────────────────────────────────────────
console.log(c.bold("\n3. Summary"));
// Latency matters: publishing waits for this answer (up to 25 s in the browser, and the
// server gives Gemini 15 s). A slow model is the usual cause of "AI moderation unavailable (timeout)".
line(probeMs > 12_000 ? "warn" : "ok", `the moderation endpoint answered in ${(probeMs / 1000).toFixed(1)} s${probeMs > 12_000 ? " — SLOW: users will wait this long before every post; try a faster MODERATION_MODEL (a *flash-lite* class model)" : ""}`);
if (report.summary === "rules_only") {
  console.log("  " + c.fail("the RULES work, but the AI (Gemini) part does NOT: every AI probe came back `degraded`."));
  console.log(c.dim("     Likely: missing/invalid API key, the model name does not exist or does not accept JSON"));
  console.log(c.dim("     output, quota exhausted (429), or the network. Check the server log for `Gemini …` errors."));
  console.log(c.dim("     Until fixed, only the deterministic rules protect the platform; everything else is allowed."));
} else if (report.aiAnswered > 0) {
  line("ok", "AI moderation is working end to end (route, rules, and real Gemini answers).");
}
if (failures === 0) console.log(c.bold("\nResult: PASS\n"));
else console.log(c.bold(`\nResult: FAIL (${failures} problem${failures > 1 ? "s" : ""})\n`));
process.exit(failures ? 1 : 0);
