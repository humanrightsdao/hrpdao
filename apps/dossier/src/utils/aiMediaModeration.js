// src/utils/aiMediaModeration.js
//
// The media counterpart of utils/aiModeration.js: checks images, videos and
// PDFs a user is about to publish. Same principles:
//   • STRICT by default: no verdict (outage, unsupported/unreadable file,
//     provider refusal) → NOT published. Same VITE_AI_MODERATION_MODE /
//     VITE_AI_FAIL_OPEN_KINDS switches as the text gate (utils/aiModeration.js).
//   • A "block" verdict refuses publishing with a reason.
//   • A "flag" verdict (e.g. graphic real-world violence, kept at severity ≤1
//     for media — see worker/moderation.js) is allowed through; there is no
//     display-time blur for media yet (see AI_MODERATION.md → Обмеження).
//   • Every check is recorded in the same local activity log the text gate
//     uses (utils/aiModeration.js → getAIActivity), so Управління → Atticus AI
//     shows media checks too — never the file itself, only file name/type/size.
//
// checkMediaBeforePublish() is the ONE function upload screens call; it does
// the client-side prep (utils/aiMediaPrep.js) and the network round trip.

import i18n from "../i18n";
import { failsClosed, recordAIActivity, primaryCategoryLabel } from "./aiModeration";
import { prepareMediaForModeration, isModerationSupported } from "./aiMediaPrep";

const DISABLED = import.meta.env.VITE_AI_MODERATION === "off";
const ENDPOINT = "/api/moderate/media";
const TIMEOUT_MS = 45_000; // media analysis is slower than text; must exceed the server's own 40s budget

let circuitOpenUntil = 0;
let serverDisabledUntil = 0;

export const isAIMediaModerationEnabled = () => !DISABLED;

function unavailableReason() {
  return i18n.t("ai_media_unavailable", {
    defaultValue:
      "The safety check for images/video couldn't be completed, so this file can't be published right now. Please try again in a moment.",
  });
}
function unsupportedReason() {
  return i18n.t("ai_media_unsupported", {
    defaultValue:
      "This file type can't be safety-checked, so it can't be published for now. Try a JPEG, PNG, WebP or MP4 file.",
  });
}
function blockedReason(result) {
  return i18n.t("ai_media_blocked", {
    category: primaryCategoryLabel(result),
    defaultValue:
      "Atticus AI stopped this file from being published (reason: {{category}}). If you think this is a mistake, contact the moderators.",
  });
}

/**
 * Checks ONE file. Never throws — every outcome is a return value, since a
 * refused/failed upload is an ordinary, expected result here, not a bug.
 *
 * @param {File} file
 * @param {{kind?: string}} [opts] the surrounding publication's kind, for the
 *   strict/fail-open policy (same kinds as the text gate: post, comment, …).
 * @returns {Promise<{allowed:true, result:object|null} |
 *                   {allowed:false, reason:string, result:object|null, unavailable?:true}>}
 */
export async function checkMediaBeforePublish(file, { kind = "post" } = {}) {
  if (DISABLED) return { allowed: true, result: null };

  if (!isModerationSupported(file)) {
    const closed = failsClosed(kind);
    recordAIActivity({
      stage: "publish", kind: "media", mediaKind: null, fileType: file.type, fileSize: file.size,
      verdict: null, source: null, categories: [], unavailable: true, refused: closed,
    });
    return closed
      ? { allowed: false, unavailable: true, result: null, reason: unsupportedReason() }
      : { allowed: true, result: null };
  }

  if (Date.now() < serverDisabledUntil) return { allowed: true, result: null };

  const startedAt = Date.now();
  let prepared = null;
  let result = null;
  let networkFailed = false;
  try {
    prepared = await prepareMediaForModeration(file);
  } catch (err) {
    console.warn("⚠️ Could not prepare media for the safety check:", err?.message);
  }

  if (prepared && Date.now() >= circuitOpenUntil) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let res;
      try {
        res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: [{ id: "draft", ...prepared }] }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.status === 429) {
        const retry = Number(res.headers.get("Retry-After"));
        circuitOpenUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : 45_000);
      } else if (res.ok) {
        const data = await res.json();
        if (data?.success && data.disabled) {
          serverDisabledUntil = Date.now() + 60_000;
        } else if (data?.success && Array.isArray(data.results)) {
          const r = data.results[0];
          if (r && !r.degraded) result = r;
        }
      } else {
        circuitOpenUntil = Date.now() + 45_000;
      }
    } catch (err) {
      networkFailed = true;
      circuitOpenUntil = Date.now() + (err?.name === "AbortError" ? 15_000 : 45_000);
      console.warn(`⚠️ AI media moderation unavailable (${err?.name === "AbortError" ? "timeout" : "network error"}).`);
    }
  }

  const ms = Date.now() - startedAt;

  if (Date.now() < serverDisabledUntil) return { allowed: true, result: null };

  if (!result) {
    const closed = failsClosed(kind);
    recordAIActivity({
      stage: "publish", kind: "media", mediaKind: prepared?.kind || null,
      fileType: file.type, fileSize: file.size,
      verdict: null, source: null, categories: [], unavailable: true, refused: closed, ms,
    });
    console.info(
      "🛡️ AI media moderation (pre-publish): no verdict →",
      closed ? "REFUSED (strict mode)" : "published without an AI check",
    );
    if (closed) {
      return {
        allowed: false, unavailable: true, result: null,
        reason: !prepared && !networkFailed ? unsupportedReason() : unavailableReason(),
      };
    }
    return { allowed: true, result: null };
  }

  const blocked = result.verdict === "block";
  recordAIActivity({
    stage: "publish", kind: "media", mediaKind: prepared.kind,
    fileType: file.type, fileSize: file.size,
    verdict: result.verdict, source: result.source, categories: result.categories || [], blocked, ms,
  });
  console.info(
    "🛡️ AI media moderation (pre-publish):",
    `${result.verdict} · ${prepared.kind} · source: ${result.source}${result.categories?.length ? ` · ${result.categories.join(", ")}` : ""} · ${ms}ms`,
  );

  if (blocked) {
    return { allowed: false, result, reason: blockedReason(result) };
  }
  return { allowed: true, result };
}

/**
 * Checks several files, stopping at the first refusal (so the user sees ONE
 * clear reason, not a pile of them). Files after a refusal are NOT checked.
 * @param {File[]} files
 * @returns {Promise<{allowed:true} | {allowed:false, file:File, reason:string, unavailable?:true}>}
 */
export async function checkMediaFilesBeforePublish(files, opts = {}) {
  for (const file of files || []) {
    const outcome = await checkMediaBeforePublish(file, opts);
    if (!outcome.allowed) return { ...outcome, file };
  }
  return { allowed: true };
}

/**
 * Last line of defence, called from inside the functions that actually
 * upload media (mirrors assertPublishAllowed() in utils/aiModeration.js).
 * Checks files in order and throws on the FIRST refusal.
 *
 * @throws {Error & {code:"MODERATION_BLOCKED", file, result, unavailable}}
 */
export async function assertMediaPublishAllowed(files, { kind = "post" } = {}) {
  const outcome = await checkMediaFilesBeforePublish(files, { kind });
  if (!outcome.allowed) {
    throw Object.assign(new Error(outcome.reason), {
      code: "MODERATION_BLOCKED",
      file: outcome.file,
      result: outcome.result,
      unavailable: Boolean(outcome.unavailable),
    });
  }
}

/** Test helper. */
export function _resetAIMediaModerationState() {
  circuitOpenUntil = 0;
  serverDisabledUntil = 0;
}
