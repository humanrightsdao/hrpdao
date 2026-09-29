// src/utils/aiScan.js
//
// "Scan latest content" for Управління → Atticus AI: takes the newest posts and
// comments published through this app, asks the moderation service about them
// and returns the ones it flagged. This is how a moderator SEES the AI reacting
// to published content (a refused draft never reaches Lens, so it can't be
// listed). Read-only: it changes nothing on Lens.

import { evmAddress } from "@lens-protocol/client";
import { fetchPosts } from "@lens-protocol/client/actions";
import { lensClient } from "../lib/lens";
import { isReportComment } from "./postReports";
import { isModActionComment } from "./moderationActions";
import { fetchVerdicts, isFlagged, SCAN_TIMEOUT_MS } from "./aiModeration";

const APP_ADDRESS = import.meta.env.VITE_LENS_APP_ADDRESS;

/** Best-effort in-app link for a Lens item (posts, violations, help requests, comments → parent). */
export function linkFor(item) {
  const tags = item.commentOn?.metadata?.tags || item.metadata?.tags || [];
  const targetId = item.commentOn?.id || item.id;
  if (tags.includes("violation")) return `/violations/${targetId}`;
  if (tags.includes("help_request")) return `/help/${targetId}`;
  return `/post/${targetId}`;
}

/**
 * @param {{ limit?: number, maxPages?: number }} [opts]
 * @returns {Promise<{ scanned:number, answered:number, flagged:Array<object> }>}
 *   `answered` = how many items the AI actually gave a verdict for (items that
 *   are too short, or when the service is down, are not counted).
 */
export async function scanLatestContent({ limit = 40, maxPages = 3 } = {}) {
  const collected = [];
  let cursor;

  for (let page = 0; page < maxPages && collected.length < limit; page++) {
    const result = await fetchPosts(lensClient, {
      filter: { apps: [evmAddress(APP_ADDRESS)] },
      ...(cursor ? { cursor } : {}),
    });
    if (result.isErr()) {
      throw new Error(result.error?.message || "Failed to load content from Lens");
    }

    for (const item of result.value.items) {
      const text = item.metadata?.content || "";
      // Reports and the moderation action log are service comments, not user content.
      if (!text || isReportComment(text) || isModActionComment(text)) continue;
      collected.push({
        id: item.id,
        kind: item.commentOn ? "comment" : "post",
        text,
        context: item.commentOn?.metadata?.content || "",
        author: item.author?.username?.localName || item.author?.address?.slice(0, 8) || "",
        createdAt: item.timestamp,
        link: linkFor(item),
      });
      if (collected.length >= limit) break;
    }

    cursor = result.value.pageInfo?.next || undefined;
    if (!cursor) break;
  }

  const verdicts = await fetchVerdicts(
    collected.map((i) => ({ id: i.id, kind: i.kind, text: i.text, context: i.context })),
    { timeoutMs: SCAN_TIMEOUT_MS },
  );

  return {
    scanned: collected.length,
    answered: verdicts.size,
    flagged: collected
      .filter((i) => isFlagged(verdicts.get(i.id)))
      .map((i) => ({ ...i, result: verdicts.get(i.id) })),
  };
}
