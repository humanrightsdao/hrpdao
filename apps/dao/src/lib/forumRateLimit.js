// src/lib/forumRateLimit.js
//
// Two shared safeguards for forum threads AND replies (one counter,
// keyed by the real author's Nostr pubkey, not by content type) —
// PORTED from dossier-app's own src/utils/postRateLimit.js:
//   1. Posting rate limit.
//   2. Protection against the same/near-identical text posted repeatedly.
//
// Unlike dossier's version (which has to manually paginate through Lens
// posts to reconstruct a time-windowed view), Nostr relays natively
// support `since` + `authors` + `#t` filters — so this reads as a single
// direct query instead of a page-by-page scan. Same fail-open philosophy
// though: a relay hiccup should never itself block a legitimate post.
//
// ⚠️ Same limits as dossier's version: this is an app-level safeguard,
// not a protocol-level one. Publishing straight to the relays via the
// Nostr SDK, bypassing this UI, isn't caught by this check.

import { pool, RELAYS } from "./nostrLookup";
import { FORUM_TAG } from "../hooks/useForum";

// Windows are checked in order from shortest — the first violated window
// immediately returns the rejection reason.
export const POST_RATE_LIMITS = [
  { windowMs: 30 * 1000, max: 1, label: "30 seconds" },
  { windowMs: 60 * 60 * 1000, max: 15, label: "1 hour" },
  { windowMs: 24 * 60 * 60 * 1000, max: 30, label: "24 hours" },
];

const DUPLICATE_MIN_LENGTH = 20;
const DUPLICATE_LOOKBACK_COUNT = 10;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

function normalizeContent(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordSetSimilarity(a, b) {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const word of setA) if (setB.has(word)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function findDuplicateContent(recentEntries, newContent) {
  const normalizedNew = normalizeContent(newContent);
  if (normalizedNew.length < DUPLICATE_MIN_LENGTH) return null;

  for (const entry of recentEntries.slice(0, DUPLICATE_LOOKBACK_COUNT)) {
    const normalizedOld = normalizeContent(entry.content);
    if (!normalizedOld || normalizedOld.length < DUPLICATE_MIN_LENGTH) continue;

    if (normalizedOld === normalizedNew) {
      return { matchType: "exact", matchedAt: entry.at, similarity: 1 };
    }
    const similarity = wordSetSimilarity(normalizedOld, normalizedNew);
    if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
      return { matchType: "similar", matchedAt: entry.at, similarity };
    }
  }
  return null;
}

/**
 * Checks both the posting rate limit and (if content is given) repetition
 * of the same text, from a single relay query of the author's own recent
 * forum activity (threads + replies, by their FORUM_TAG/…-reply tags).
 *
 * @param {string} pubkey - the author's Nostr pubkey (useNostrIdentity's
 *   getSignerPubkey() — same deterministic identity used to publish).
 * @param {string|null} content - text of the publication being submitted.
 *   If omitted, only the rate limit is checked.
 */
export async function checkForumRateLimit(pubkey, content = null) {
  if (!pubkey) return { allowed: true };

  const widestWindowMs = Math.max(...POST_RATE_LIMITS.map((l) => l.windowMs));
  const since = Math.floor((Date.now() - widestWindowMs) / 1000);

  let recentEntries;
  try {
    const events = await pool.querySync(RELAYS, {
      kinds: [1],
      authors: [pubkey],
      "#t": [FORUM_TAG, `${FORUM_TAG}-reply`],
      since,
    });
    recentEntries = events.map((ev) => ({ at: ev.created_at * 1000, content: ev.content || "" }));
  } catch (err) {
    // Fail-open: a relay hiccup shouldn't block a legitimate post.
    console.warn("⚠️ checkForumRateLimit: failed to read author history, skipping the check:", err.message);
    return { allowed: true };
  }

  const now = Date.now();
  for (const limit of POST_RATE_LIMITS) {
    const windowCutoff = now - limit.windowMs;
    const inWindow = recentEntries.filter((e) => e.at >= windowCutoff);
    if (inWindow.length >= limit.max) {
      const oldestInWindow = Math.min(...inWindow.map((e) => e.at));
      const retryAfterMs = Math.max(0, oldestInWindow + limit.windowMs - now);
      return {
        allowed: false,
        reason: `Too many posts in ${limit.label} (limit: ${limit.max}). Try again later.`,
        retryAfterMs,
        windowLabel: limit.label,
      };
    }
  }

  if (content) {
    const duplicate = findDuplicateContent(recentEntries, content);
    if (duplicate) {
      return {
        allowed: false,
        isDuplicate: true,
        duplicateMatch: duplicate,
        reason:
          duplicate.matchType === "exact"
            ? "You've already posted this exact message. Try writing something new."
            : "This message is very similar to one of your previous ones. Try rephrasing it.",
      };
    }
  }

  return { allowed: true };
}

/** UI helper: formats retryAfterMs into human-readable text ("42s" / "3 min"). */
export function formatRetryAfter(retryAfterMs) {
  const seconds = Math.ceil(retryAfterMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}
