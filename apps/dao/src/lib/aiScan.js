// src/lib/aiScan.js
//
// Ported from dossier/src/utils/aiScan.js. "Scan latest content" for the AI
// moderation panel: pulls the newest forum threads/replies published through
// this app's relays and asks the moderation service about them — this is how
// a moderator SEES the AI reacting to published content (a refused draft
// never reaches Nostr, so it can't be listed here). Read-only: it changes
// nothing on the relays.
//
// Governance proposals are NOT scanned here: they are checked MANDATORILY
// before submission (submitProposal() in useDao.js, kind "proposal" ∈
// MANDATORY_KINDS in aiModeration.js) and, once on-chain, are immutable and
// fully public anyway — a proposal that got through the pre-submit check has
// been judged "allow", or moderation was deliberately switched off.

import { pool, RELAYS } from "./nostrLookup";
// Reports (NIP-56, kind 1984) and moderation-log events (kind 1, tagged
// MOD_ACTION_TAG, a DIFFERENT tag string than FORUM_TAG) never match the
// `kinds: [1], "#t": [FORUM_TAG]` filter below — no extra filtering needed.
// (FORUM_TAG lives in lib/forumTags.js, the same leaf module forumModeration.js
// imports it from.)
import { FORUM_TAG } from "./forumTags";
import { fetchVerdicts, isFlagged, threadModerationText } from "./aiModeration";

/** In-app link for a forum event: a thread (kind root) or a reply (its parent thread). */
export function linkFor(event) {
  const replyTo = event.tags?.find((t) => t[0] === "e" && t[3] === "reply")?.[1];
  const rootId = event.tags?.find((t) => t[0] === "e" && (t[3] === "root" || !t[3]))?.[1];
  const threadId = replyTo || rootId || event.id;
  return `/forum/${threadId}`;
}

/**
 * @param {{ limit?: number, sinceHours?: number }} [opts]
 * @returns {Promise<{ scanned:number, answered:number, flagged:Array<object> }>}
 *   `answered` = how many items the AI actually gave a verdict for (items too
 *   short, or when the service is down, are not counted).
 */
export async function scanLatestContent({ limit = 40, sinceHours = 72 } = {}) {
  const since = Math.floor(Date.now() / 1000) - sinceHours * 3600;
  const events = await pool.querySync(RELAYS, { kinds: [1], "#t": [FORUM_TAG], since, limit: limit * 2 });

  const collected = [];
  for (const event of events.sort((a, b) => b.created_at - a.created_at)) {
    const text = (event.content || "").trim();
    if (!text) continue;
    const isReply = event.tags?.some((t) => t[0] === "e");
    const title = event.tags?.find((t) => t[0] === "subject")?.[1] || "";
    collected.push({
      id: event.id,
      kind: isReply ? "forum_reply" : "forum_thread",
      // A thread is judged as title + body, exactly like at publish time.
      text: isReply ? text : threadModerationText(title, text),
      context: "", // the parent thread's text isn't fetched here (best-effort scan, not the publish-time gate)
      author: event.pubkey?.slice(0, 8) || "",
      createdAt: event.created_at,
      link: linkFor(event),
    });
    if (collected.length >= limit) break;
  }

  const verdicts = await fetchVerdicts(
    collected.map((i) => ({ id: i.id, kind: i.kind, text: i.text, context: i.context })),
    { timeoutMs: 30_000 },
  );

  return {
    scanned: collected.length,
    answered: verdicts.size,
    flagged: collected
      .filter((i) => isFlagged(verdicts.get(i.id)))
      .map((i) => ({ ...i, result: verdicts.get(i.id) })),
  };
}
