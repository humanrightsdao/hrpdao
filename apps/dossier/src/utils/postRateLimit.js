// src/utils/postRateLimit.js
//
// Two shared safeguards for ALL content types in this app (regular post,
// violation post, help request, comment - everything is counted by ONE
// counter, keyed by the real author, not by content type):
//
//   1. Posting rate limit (1/min, 10/hr, 20/day).
//   2. Protection against the same/near-identical text being posted
//      repeatedly by the author (the classic "spamming the same message").
//
// Both are computed from the ONE SAME fetch of the author's recent
// publications - one network check instead of two.
//
// ⚠️ Deliberately NOT localStorage. The app is fully Lens-native (no own
// backend - see the discussion about migrating away from Supabase), and
// localStorage:
//   1) is tied to the browser/device, not the author - a different device
//      or even just a different browser on the same device completely
//      bypasses the check;
//   2) doesn't see anything published outside this particular UI
//      (e.g. via a direct Lens SDK/API call).
// So the check here reads the author's REAL publication history directly
// from Lens - our own fetchAllAuthorContent() below (NOT
// fetchPostsByAuthor() from hooks/useLensPosts.js, which excludes comments
// and violation/help_request posts - see explanation below) - reflecting
// the true state regardless of device or client.
//
// Limits: this is an app-level safeguard (like the rest of the moderation
// here), not a protocol-level one - someone publishing directly through
// the Lens SDK, bypassing this UI, is not caught by this check. Full
// protocol-level protection would be a separate Lens Feed Rule (smart
// contract), discussed separately as phase 2.
//
// Why duplicates are caught HERE (on submit) rather than after the fact
// via auto-quarantine (as with reports in moderationActions.js): to detect
// a duplicate after the fact for EVERY post in the feed, we'd have to pull
// the full publication history of THAT post's author separately on every
// render (N posts in the feed = N separate requests, from different
// authors) - doesn't scale. On submit, we're already pulling this author's
// history for the rate limit anyway - so the duplicate check here is
// essentially free.

import { fetchPosts } from "@lens-protocol/client/actions";
import { lensClient } from "../lib/lens";
import { normalizeLensPost } from "../hooks/useLensPosts";
// IMPORTANT: this file (postRateLimit.js) itself lives in src/utils/, so
// sibling files in the same utils/ dir use the relative path "./", NOT
// "../utils/" (what I initially wrote - "../utils/postReports" - would
// point to a nonexistent src/utils/utils/postReports.js).
import { isReportComment } from "./postReports";
import { isModActionComment } from "./moderationActions";

// ── Rate limit - one shared counter for all content types ──────────────
// Windows are checked in order from shortest - the first violated window
// immediately returns the rejection reason, longer windows aren't checked further.
export const POST_RATE_LIMITS = [
  { windowMs: 30 * 1000, max: 1, label: "30 seconds" },
  { windowMs: 60 * 60 * 1000, max: 15, label: "1 hour" },
  { windowMs: 24 * 60 * 60 * 1000, max: 30, label: "24 hours" },
];

// ── Duplicates ───────────────────────────────────────────────────────
// Minimum length of normalized text at which we START checking for a
// duplicate at all. Short replies ("thanks", "+1", "🙏", "yes") are
// normal legitimate usage and should NOT be flagged as spam, even if the
// person posted the same thing twice in a row.
const DUPLICATE_MIN_LENGTH = 20;
// How many of the author's most recent publications (of any type) we
// check for a match - BY COUNT, not by time, so the protection behaves
// the same both for someone who posts every minute and for someone who
// visits once a week.
const DUPLICATE_LOOKBACK_COUNT = 10;
// Similarity threshold (word-based Jaccard) for "nearly the same" text -
// not just a 100% exact match, but also a duplicate reworded by a few words.
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

// ⚠️ IMPORTANT: we do NOT use fetchPostsByAuthor() from
// hooks/useLensPosts.js directly. That function was written for a
// different purpose (ProposalsSection.jsx - finding only the "regular"
// root proof-post for a sanction card) and DELIBERATELY excludes:
//   1) comments (`items.filter(item => !item.commentOn)`)
//   2) posts tagged violation/help_request/rating/mod_action
//      (`NON_FEED_TAGS`)
// I.e. it returns ONLY regular posts - for "one shared counter for ALL
// content types" this isn't enough: comments and violation/help-request
// posts simply wouldn't be counted. So here we have our own minimal
// version of the same query without those two filters, but WITH a filter
// for SERVICE comments (see below).
const RATE_LIMIT_MAX_RESULT_SIZE = 50;

// Maximum number of pages of the author's history to page through below
// in checkPostRateLimit(). Posts come newest-first - as soon as we hit a
// post older than the widest window (24h), we can stop; the page limit
// is just a safeguard in case of a sorting anomaly.
const MAX_PAGES = 5;

/**
 * One page of ALL of the author's publications (posts + comments, of any
 * content type), directly from Lens - without fetchPostsByAuthor()'s filters.
 *
 * Deliberately excludes only SERVICE comments - reports (ReportModal.jsx)
 * and the moderation action log (moderationActions.js), which are
 * published as regular comments with a service marker in the text. This
 * is NOT user content, and counting it toward the posting/duplicate limit
 * doesn't make sense - otherwise an active Shield/Council moderator
 * reviewing many reports in a row would hit their own anti-spam limit and
 * be unable to moderate.
 */
async function fetchAllAuthorContent(accountAddress, cursor = null) {
  const result = await fetchPosts(lensClient, {
    filter: {
      authors: [accountAddress],
      apps: [import.meta.env.VITE_LENS_APP_ADDRESS],
    },
    ...(cursor ? { cursor } : {}),
  });

  if (result.isErr()) {
    throw new Error(result.error.message);
  }

  const { items, pageInfo } = result.value;

  const realContent = items.filter((item) => {
    const content = item.metadata?.content || "";
    return !isReportComment(content) && !isModActionComment(content);
  });

  return {
    success: true,
    posts: realContent.slice(0, RATE_LIMIT_MAX_RESULT_SIZE).map(normalizeLensPost),
    nextCursor: pageInfo?.next || null,
  };
}

/**
 * Normalizes text for comparison: lowercase, strips punctuation and
 * emoji (keeps letters of ANY language thanks to \p{L} - Cyrillic too),
 * collapses whitespace. "Hello!!! 😊😊😊" and "hello" become identical
 * after normalization - intentionally, since that's exactly what a
 * typical duplicate spam message looks like with emoji/punctuation added
 * to "disguise" it.
 */
function normalizeContent(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Jaccard similarity of two normalized texts by word sets. */
function wordSetSimilarity(a, b) {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Looks among the author's most recent publications for an exact or
 * near-exact (Jaccard ≥ DUPLICATE_SIMILARITY_THRESHOLD) match with the
 * new text. Returns null if there's no match, or if the new text is too
 * short for checking to make sense at all.
 */
function findDuplicateContent(recentEntries, newContent) {
  const normalizedNew = normalizeContent(newContent);
  if (normalizedNew.length < DUPLICATE_MIN_LENGTH) return null;

  const candidates = recentEntries.slice(0, DUPLICATE_LOOKBACK_COUNT);

  for (const entry of candidates) {
    const normalizedOld = normalizeContent(entry.content);
    if (!normalizedOld || normalizedOld.length < DUPLICATE_MIN_LENGTH) {
      continue;
    }

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
 * Checks both the posting rate limit and (if text is provided) repetition
 * of the same content - from a SINGLE fetch of the author's history.
 *
 * Call BEFORE submitting any publication (regular post, violation, help
 * request, comment) - the same for all types, a single shared check.
 *
 * @param {string} walletAddress - the author's address (Lens Account
 *   address, preferred - see the localStorage.lens_account_address
 *   convention elsewhere in the codebase; EOA as a fallback).
 * @param {string|null} content - the text of the publication currently
 *   being submitted. If not provided - only the rate limit is checked,
 *   without a duplicate check (e.g. if the caller doesn't have the text yet).
 * @returns {Promise<
 *   {allowed: true} |
 *   {allowed: false, reason: string, retryAfterMs?: number, windowLabel?: string, isDuplicate?: boolean, duplicateMatch?: object}
 * >}
 */
export async function checkPostRateLimit(walletAddress, content = null) {
  if (!walletAddress) return { allowed: true };

  const widestWindowMs = Math.max(...POST_RATE_LIMITS.map((l) => l.windowMs));
  const now = Date.now();
  const cutoff = now - widestWindowMs;

  // { at: number, content: string }[] - stores both the time and the text
  // itself, since both checks (rate and duplicate) read the same fetch.
  const recentEntries = [];
  let cursor = null;
  let page = 0;

  try {
    do {
      const res = await fetchAllAuthorContent(walletAddress, cursor);
      if (!res?.success) break;

      let hitOlderThanCutoff = false;
      for (const p of res.posts || []) {
        // normalizeLensPost() (hooks/useLensPosts.js) guarantees created_at
        // (= lensPost.timestamp) and content (= metadata.content || "") for
        // ALL content types - posts, violations, requests, comments -
        // so no guessing across several possible field names.
        const at = new Date(p.created_at).getTime();
        if (!Number.isFinite(at)) continue;

        if (at < cutoff) {
          // Posts come newest-first - once we hit one older than the
          // widest window, there's no point scanning further.
          hitOlderThanCutoff = true;
          break;
        }
        recentEntries.push({ at, content: p.content || "" });
      }

      if (hitOlderThanCutoff) break;

      cursor = res.nextCursor || null;
      page += 1;
    } while (cursor && page < MAX_PAGES);
  } catch (err) {
    // Fail-open: a temporary RPC/indexer failure shouldn't block a
    // legitimate publication - better to skip the check this one time
    // than break the UX because of a network error unrelated to spam.
    console.warn(
      "⚠️ checkPostRateLimit: failed to read author history, skipping the check:",
      err.message,
    );
    return { allowed: true };
  }

  // 1) Rate limit.
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

  // 2) Duplicate content (only if text was provided and the rate check above passed).
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

/**
 * UI helper: formats retryAfterMs into human-readable text
 * ("wait 42s" / "wait 3 min"). Not required to be used -
 * checkPostRateLimit().reason already contains a ready-made message
 * without a specific countdown.
 */
export function formatRetryAfter(retryAfterMs) {
  const seconds = Math.ceil(retryAfterMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
}
