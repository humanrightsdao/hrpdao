// src/utils/aiModeration.js
//
// Client for "Atticus Guard" — AI content moderation (see AI_MODERATION.md).
//
// The engine runs server-side (Cloudflare Worker /api/moderate, mirrored by
// server/index.js for local dev). This file is the thin browser side:
//
//   checkBeforePublish()  – gate used right before something is published.
//                           Refuses ONLY clear violations (verdict "block").
//   fetchVerdicts()       – batch lookup used when content is DISPLAYED
//                           (feed posts, comments). Verdict "flag"/"block"
//                           makes the UI blur/collapse the item — it never
//                           deletes or hides anything for good.
//
// Principles (mirrored from the engine):
//   • BOTH display and publishing are FAIL OPEN by default: with no verdict
//     (Gemini down, timed out, rate-limited, unreadable file) content is
//     published/shown normally. Reasoning: "no verdict" is an absence of
//     information, not evidence of harm, and the deterministic rules in
//     moderation.js (seed-phrase phishing, scam patterns, ...) keep working
//     even when the AI itself is unavailable — they need no Gemini call at
//     all. Making a whole human-rights platform's ability to publish (incl.
//     urgent help requests) depend on one third-party AI service's uptime
//     was judged a worse failure mode than occasionally missing an AI-only
//     nuance (spam, tone, borderline cases) during an outage.
//   • Set VITE_AI_MODERATION_MODE=strict to require a verdict before
//     publishing instead (refuses with "the safety check is unavailable, try
//     again" when the AI can't answer) — a legitimate choice for an operator
//     confident in their Gemini uptime/quota who wants that as insurance.
//     VITE_AI_FAIL_OPEN_KINDS then still relaxes individual kinds even in
//     strict mode (e.g. so help_request is never blocked by an outage while
//     post/comment are).
//   • An operator's deliberate switch-off (MODERATION_ENABLED=false) is NOT an
//     outage: it always lets content through, in either mode.
//   • The AI never acts alone. It can refuse an obvious scam before
//     publishing and blur an item with a "Show anyway" button. Hiding,
//     sanctions and bans stay with Shield/Council (moderationActions.js),
//     and an explicit moderator UNBLUR overrides the AI (see
//     computeModerationState()).
//   • Only text (+ the parent post's text for comments) is sent. No wallet
//     address, no author identity. Encrypted Nostr DMs are NEVER scanned.
//   • A circuit breaker stops hammering the endpoint after failures, so an
//     outage or a rate limit costs the user nothing.

import i18n from "../i18n";

const DISABLED = import.meta.env.VITE_AI_MODERATION === "off";
const ENDPOINT = "/api/moderate";

/** Items per HTTP request (the server accepts up to 20). */
const REQUEST_BATCH = 10;
/** Concurrent HTTP requests from one fetchVerdicts() call. */
const REQUEST_CONCURRENCY = 2;
/** Replies shorter than this ("thanks", "+1", "🙏") aren't worth a scan… */
const MIN_SCAN_CHARS = 12;
/** …unless they contain a link. */
const LINK_RE = /https?:\/\/|www\./i;

const CACHE_MAX = 1500;
// Timeouts are chosen to OUTLAST the server's own 15 s Gemini timeout
// (moderation.js → LIMITS.geminiTimeoutMs), otherwise the browser gives up
// while the server is still waiting and a healthy answer is thrown away.
const DEFAULT_TIMEOUT_MS = 28_000; // display-time lookups (non-blocking)
const PUBLISH_TIMEOUT_MS = 32_000; // pre-publish: the user is waiting, and it decides
export const SCAN_TIMEOUT_MS = 45_000;
const CIRCUIT_DEFAULT_MS = 45_000;

const verdictCache = new Map(); // key -> result (never degraded)
const inflight = new Map(); // key -> Promise<result | null>
let circuitOpenUntil = 0;
let serverDisabledUntil = 0; // the OPERATOR switched moderation off (MODERATION_ENABLED=false)

// ── fail mode ──────────────────────────────────────────────────────────────
// Default: OPEN (publish when the AI has no verdict). See the header note above.
let strictMode = import.meta.env.VITE_AI_MODERATION_MODE === "strict";
let failOpenKinds = new Set(
  String(import.meta.env.VITE_AI_FAIL_OPEN_KINDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** True when a draft of this kind must NOT be published without an AI verdict. */
export const failsClosed = (kind) => strictMode && !failOpenKinds.has(kind);

/** Test helper. */
export function _setModerationMode({ strict = true, failOpen = [] } = {}) {
  strictMode = strict;
  failOpenKinds = new Set(failOpen);
}

export const isAIModerationEnabled = () => !DISABLED;

// ── helpers ────────────────────────────────────────────────────────────────

/** cyrb53: small, fast, good-enough 53-bit string hash for cache keys. */
function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function itemKey(item) {
  return hash53(
    `${item.kind || "post"}\u0001${String(item.text || "").trim()}\u0001${String(item.context || "").trim()}`,
  );
}

export function shouldScan(item) {
  const text = String(item?.text || "").trim();
  if (!text) return false;
  return text.length >= MIN_SCAN_CHARS || LINK_RE.test(text);
}

export function getCachedVerdict(item) {
  return verdictCache.get(itemKey(item));
}

/** True when the AI thinks the item should be blurred/collapsed for readers. */
export function isFlagged(result) {
  return Boolean(
    result && !result.degraded && (result.verdict === "flag" || result.verdict === "block"),
  );
}

export function categoryLabel(category) {
  const id = category || "other";
  return i18n.t(`ai_category_${id}`, { defaultValue: id.replace(/_/g, " ") });
}

/** The label of the most relevant category of a result. */
export function primaryCategoryLabel(result) {
  return categoryLabel(result?.categories?.[0]);
}

function remember(key, result) {
  if (verdictCache.size >= CACHE_MAX) {
    verdictCache.delete(verdictCache.keys().next().value);
  }
  verdictCache.set(key, result);
}

function openCircuit(ms, reason) {
  const wasClosed = Date.now() >= circuitOpenUntil;
  circuitOpenUntil = Date.now() + ms;
  // The service failing is SILENT for users by design (fail open), so make it
  // visible to whoever operates the app: once per outage, and it survives the
  // production build (console.warn is kept, unlike console.log/info).
  if (wasClosed) {
    console.warn(
      `⚠️ AI moderation unavailable (${reason}) — content is shown/published WITHOUT an AI check. Retrying in ${Math.round(ms / 1000)}s.`,
    );
  }
}

// ── activity log (this browser only) ───────────────────────────────────────
//
// The AI's reactions are otherwise invisible: a draft that was refused never
// reaches Lens, and "service down" is silent by design. So every check that
// mattered is recorded LOCALLY (localStorage, last 50, newest first) and shown
// in Управління → "Atticus AI". It stores NO text — only what happened:
// kind, verdict, source, categories, and a content hash used to de-duplicate.
// It does not leave the browser and only ever describes this browser's own
// actions and what it displayed.

const ACTIVITY_KEY = "aiModerationActivity";
const ACTIVITY_MAX = 50;

function readActivity() {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(ACTIVITY_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function logActivity(entry) {
  try {
    const list = readActivity();
    // The same flagged item is re-displayed on every visit: keep one entry.
    if (entry.key && list.some((e) => e.key === entry.key && e.stage === entry.stage)) return;
    list.unshift({ at: Date.now(), ...entry });
    globalThis.localStorage?.setItem(ACTIVITY_KEY, JSON.stringify(list.slice(0, ACTIVITY_MAX)));
  } catch {
    /* storage unavailable / full: the log is a convenience, never a dependency */
  }
}

/** Used by the Управління panel to record its own self-checks and scans. */
export function recordAIActivity(entry) {
  logActivity(entry);
}

/** @returns {Array<{at:number, stage:"publish"|"display"|"selfcheck"|"scan", kind:string, verdict:string|null, source:string|null, categories:string[], unavailable?:boolean, blocked?:boolean}>} */
export function getAIActivity() {
  return readActivity();
}

export function clearAIActivity() {
  try {
    globalThis.localStorage?.removeItem(ACTIVITY_KEY);
  } catch {
    /* ignore */
  }
}

// ── network ────────────────────────────────────────────────────────────────

/**
 * One HTTP request for up to REQUEST_BATCH items.
 * @returns {Promise<object[] | null>} results aligned with `items`, or null
 *   when there is no usable answer (→ callers fail open).
 */
async function requestBatch(items, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: items.map((it, i) => ({
          id: String(i),
          kind: it.kind || "post",
          text: it.text,
          context: it.context || "",
        })),
      }),
      signal: controller.signal,
    });

    if (res.status === 429) {
      const retry = Number(res.headers.get("Retry-After"));
      openCircuit(Number.isFinite(retry) && retry > 0 ? retry * 1000 : CIRCUIT_DEFAULT_MS, "HTTP 429, rate limited");
      return null;
    }
    if (!res.ok) {
      // 404 = an old backend without /api/moderate; 500 from the Vite dev
      // proxy = the backend is not running (see AI_MODERATION.md → Troubleshooting).
      openCircuit(CIRCUIT_DEFAULT_MS, `HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    if (data?.success && data.disabled) {
      // A deliberate switch-off, not a failure: remember it so publishing is
      // never held back by it (see checkBeforePublish), and stay quiet.
      serverDisabledUntil = Date.now() + 60_000;
      return null;
    }
    if (!data?.success || !Array.isArray(data.results)) return null;

    const byId = new Map(data.results.map((r) => [String(r.id), r]));
    return items.map((_, i) => byId.get(String(i)) || null);
  } catch (err) {
    // Offline / aborted / bad JSON. Back off briefly so we don't retry on
    // every render while the service is unreachable.
    if (err?.name !== "AbortError") openCircuit(CIRCUIT_DEFAULT_MS, "network error");
    else openCircuit(15_000, "timeout");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Looks up verdicts for a list of items. Cached items are answered
 * instantly, identical items are de-duplicated (also across concurrent
 * callers), the rest are sent in small batches.
 *
 * @param {Array<{id:string, kind?:string, text:string, context?:string}>} items
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] ignore the circuit breaker (pre-publish:
 *   a user who just failed a check must be able to retry immediately).
 * @param {boolean} [opts.record=true] log flagged results to the local activity
 *   log as "when displayed" (checkBeforePublish() passes false: it logs its own
 *   "before publishing" entry).
 * @returns {Promise<Map<string, object>>} id → result (only usable, non-degraded
 *   results; missing ids mean "no opinion").
 */
export async function fetchVerdicts(
  items,
  { timeoutMs = DEFAULT_TIMEOUT_MS, record = true, force = false } = {},
) {
  const out = new Map();
  if (DISABLED || !Array.isArray(items) || items.length === 0) return out;

  const waitFor = new Map(); // key -> Promise<result|null>
  const toRequest = []; // { key, item, resolve }

  for (const item of items) {
    if (!shouldScan(item)) continue;
    const key = itemKey(item);

    const cached = verdictCache.get(key);
    if (cached) continue; // answered below from the cache
    if (waitFor.has(key)) continue;

    if (inflight.has(key)) {
      waitFor.set(key, inflight.get(key));
      continue;
    }
    if (!force && Date.now() < circuitOpenUntil) continue; // breaker open → no opinion

    let resolve;
    const promise = new Promise((r) => (resolve = r));
    inflight.set(key, promise);
    waitFor.set(key, promise);
    toRequest.push({ key, item, resolve });
  }

  // Run the batches with a small concurrency.
  const batches = [];
  for (let i = 0; i < toRequest.length; i += REQUEST_BATCH) {
    batches.push(toRequest.slice(i, i + REQUEST_BATCH));
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(REQUEST_CONCURRENCY, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        let results = null;
        if (force || Date.now() >= circuitOpenUntil) {
          results = await requestBatch(
            batch.map((b) => b.item),
            timeoutMs,
          );
        }
        batch.forEach((b, i) => {
          const r = results?.[i] || null;
          if (r && !r.degraded) {
            remember(b.key, r);
            if (record && isFlagged(r)) {
              logActivity({
                stage: "display",
                kind: b.item.kind || "post",
                key: b.key,
                verdict: r.verdict,
                source: r.source,
                categories: r.categories || [],
              });
            }
          }
          inflight.delete(b.key);
          b.resolve(r && !r.degraded ? r : null);
        });
      }
    }),
  );

  await Promise.all(waitFor.values());

  for (const item of items) {
    const r = verdictCache.get(itemKey(item));
    if (r) out.set(item.id, r);
  }
  return out;
}

// ── pre-publish gate ───────────────────────────────────────────────────────

const GATE_TTL_MS = 10 * 60 * 1000;
const gateResults = new Map(); // text hash -> { allowed, at, result, reason }

/**
 * Remembers the outcome for a text, so that a SECOND gate further down the
 * call chain (assertPublishAllowed() inside the publishing hooks) does not
 * ask the AI again — and, above all, cannot answer differently — for the very
 * same text the UI gate has just judged, even though it knows a different
 * `kind`/`context` (which would otherwise be a different cache key).
 */
function rememberGate(text, entry) {
  if (gateResults.size > 500) gateResults.delete(gateResults.keys().next().value);
  gateResults.set(hash53(String(text || "").trim()), { ...entry, at: Date.now() });
}

function unavailableReason() {
  return i18n.t("ai_moderation_unavailable", {
    defaultValue:
      "The safety check (Atticus AI) is temporarily unavailable, so this can't be published right now. Please try again in a moment.",
  });
}

/**
 * Asked right before publishing.
 *   • verdict "block"  → refused (with the reason).
 *   • verdict "flag"   → published; readers see it blurred/collapsed and
 *                        moderators can review it (people decide).
 *   • NO verdict (AI unavailable / timeout / degraded):
 *        open mode (default) → published, same as if nothing was flagged;
 *        strict mode / a kind NOT in VITE_AI_FAIL_OPEN_KINDS → refused,
 *        "try again".
 *   • too short to matter ("thanks") or moderation deliberately switched off
 *     by the operator → published.
 *
 * @returns {Promise<{allowed:true, result:object|null} |
 *                   {allowed:false, result:object|null, reason:string, unavailable?:true}>}
 */
export async function checkBeforePublish({
  text,
  kind = "post",
  context = "",
  timeoutMs = PUBLISH_TIMEOUT_MS,
}) {
  if (DISABLED || !String(text || "").trim()) return { allowed: true, result: null };
  if (!shouldScan({ text })) return { allowed: true, result: null };
  if (Date.now() < serverDisabledUntil) return { allowed: true, result: null };

  const startedAt = Date.now();
  let result = null;
  try {
    const map = await fetchVerdicts([{ id: "draft", kind, text, context }], {
      timeoutMs,
      record: false,
      force: true,
    });
    result = map.get("draft") || null;
  } catch (err) {
    console.warn("⚠️ AI moderation check failed:", err?.message);
  }
  const ms = Date.now() - startedAt;

  // The operator switched moderation off (learned from this very answer).
  if (!result && Date.now() < serverDisabledUntil) return { allowed: true, result: null };

  if (!result) {
    // No verdict: the service failed, timed out, or answered "degraded".
    const closed = failsClosed(kind);
    logActivity({
      stage: "publish", kind, verdict: null, source: null, categories: [],
      unavailable: true, refused: closed, ms,
    });
    console.info("🛡️ AI moderation (pre-publish): no verdict →", closed ? "REFUSED (strict mode)" : "published without an AI check");
    if (closed) {
      return { allowed: false, unavailable: true, result: null, reason: unavailableReason() };
    }
    rememberGate(text, { allowed: true, result: null });
    return { allowed: true, result: null };
  }

  const blocked = result.verdict === "block";
  logActivity({
    stage: "publish", kind, verdict: result.verdict, source: result.source,
    categories: result.categories || [], blocked, ms,
  });
  console.info(
    "🛡️ AI moderation (pre-publish):",
    `${result.verdict} · source: ${result.source}${result.categories?.length ? ` · ${result.categories.join(", ")}` : ""} · ${ms}ms`,
  );

  if (blocked) {
    const reason = i18n.t("ai_moderation_blocked", {
      category: primaryCategoryLabel(result),
      defaultValue:
        "Atticus AI stopped this from being published (reason: {{category}}). If you think this is a mistake, rephrase the text or contact the moderators.",
    });
    rememberGate(text, { allowed: false, result, reason });
    return { allowed: false, result, reason };
  }
  rememberGate(text, { allowed: true, result });
  return { allowed: true, result };
}

/**
 * The LAST line of defence, called from inside the functions that actually
 * publish (createLensPost, createLensComment, the violation / help-request /
 * profile saves). The UI buttons already call checkPostRateLimit() — this
 * makes sure that a future screen, a refactor or a forgotten call site
 * cannot publish unchecked. If the same text was judged in the last 10
 * minutes (by the UI gate) that outcome is reused: no second wait, no
 * second opinion.
 *
 * @throws {Error & {code:"MODERATION_BLOCKED", moderation, unavailable}} with
 *   a ready-to-show message.
 */
export async function assertPublishAllowed({ text, kind = "post", context = "" }) {
  const recent = gateResults.get(hash53(String(text || "").trim()));
  if (recent && Date.now() - recent.at < GATE_TTL_MS) {
    if (recent.allowed) return recent.result || null;
    throw Object.assign(new Error(recent.reason), { code: "MODERATION_BLOCKED", moderation: recent.result });
  }
  const guard = await checkBeforePublish({ text, kind, context });
  if (!guard.allowed) {
    throw Object.assign(new Error(guard.reason), {
      code: "MODERATION_BLOCKED",
      moderation: guard.result,
      unavailable: Boolean(guard.unavailable),
    });
  }
  return guard.result;
}

/** Test/support helper: forget everything (also used on logout if ever needed). */
export function _resetAIModerationState() {
  verdictCache.clear();
  inflight.clear();
  gateResults.clear();
  circuitOpenUntil = 0;
  serverDisabledUntil = 0;
}
