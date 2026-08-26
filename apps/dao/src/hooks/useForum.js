import { useState, useCallback } from "react";
import { useAccount } from "wagmi";
import { pool, RELAYS, publishEvent } from "../lib/nostrLookup";
import { useNostrIdentity } from "./useNostrIdentity";

// ── Tag schema ────────────────────────────────────────────
// Thread:  kind:1, tags: [["t","hrp-forum"], ["t","hrp-forum-<cat>"], ["subject", title], ["address", wallet]]
// Reply:   kind:1, tags: [["e", <rootId>, "", "root"], ["t","hrp-forum-reply"], ["address", wallet]]
// The same kind:1 (a plain note) as posts in the community feed — the
// forum and the social feed share one source of truth, only the tags differ.
//
// FIXED: "Forum shows a Nostr code instead of a name+avatar." The
// pubkey signing these events is derived deterministically from the
// wallet (see useNostrIdentity.jsx) purely so the SAME event can be
// verified — nobody ever publishes a NIP-01 (kind:0) profile for it,
// so looking that pubkey up on relays (ForumAuthor.jsx's old
// approach) was always going to come back empty; the pubkey was
// never "linked to an account" in that sense. The actual name/avatar
// this whole ecosystem already knows how to find is reached by
// WALLET ADDRESS — the same lookup Identity.jsx/CardPreview.jsx use
// everywhere else (Lens → Nostr wallet-link → ENS). This "address"
// tag is what lets ForumAuthor.jsx do that lookup instead. Older
// threads/replies published before this fix won't have the tag —
// ForumAuthor.jsx falls back to the previous pubkey-code display for
// those.
//
// RESET (2026-08-26): tag bumped from "hrp-forum" to "hrpdao-forum"
// to deliberately start the forum clean — old test threads (Тема 5,
// Тема 4, Test forum, Chronicle, Policy test, ...) were published
// under the old tag to the same public relays, and Nostr relays don't
// reliably support deletion, so a fresh tag is the practical way to
// stop querying them. They still physically exist on the relays under
// "hrp-forum" — this only changes what THIS app queries/publishes.
const FORUM_TAG = "hrpdao-forum";

function parseThread(ev) {
  const subjectTag = ev.tags.find((t) => t[0] === "subject");
  const catTag = ev.tags.find((t) => t[0] === "t" && t[1] !== FORUM_TAG && !t[1].endsWith("-reply"));
  const addressTag = ev.tags.find((t) => t[0] === "address");
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    address: addressTag?.[1] || null,
    title: subjectTag?.[1] || ev.content.slice(0, 60),
    body: ev.content,
    category: catTag?.[1]?.replace("hrp-forum-", "") || "general",
    createdAt: ev.created_at,
  };
}

function parseReply(ev) {
  const addressTag = ev.tags.find((t) => t[0] === "address");
  return {
    id: ev.id,
    pubkey: ev.pubkey,
    address: addressTag?.[1] || null,
    body: ev.content,
    createdAt: ev.created_at,
  };
}

export function useForum() {
  const [threads, setThreads] = useState([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [error, setError] = useState(null);
  // Deterministically derived from the connected DAO wallet — same
  // identity as Dossier's, instead of an unrelated random local key.
  // See useNostrIdentity.jsx for why.
  const { getSignerPubkey, signEvent } = useNostrIdentity();
  const { address } = useAccount();

  const loadThreads = useCallback(async () => {
    setLoadingThreads(true);
    setError(null);
    try {
      const events = await pool.querySync(RELAYS, { kinds: [1], "#t": [FORUM_TAG], limit: 100 });
      const parsed = events
        .filter((ev) => !ev.tags.some((t) => t[0] === "e")) // threads, not replies
        .map(parseThread)
        .sort((a, b) => b.createdAt - a.createdAt);
      setThreads(parsed);
    } catch (e) {
      setError("Failed to load the forum from the relay servers.");
    } finally {
      setLoadingThreads(false);
    }
  }, []);

  const loadThread = useCallback(async (id) => {
    const [rootEvents, replyEvents] = await Promise.all([
      pool.querySync(RELAYS, { ids: [id] }),
      pool.querySync(RELAYS, { kinds: [1], "#e": [id] }),
    ]);
    const root = rootEvents[0] ? parseThread(rootEvents[0]) : null;
    const replies = replyEvents.map(parseReply).sort((a, b) => a.createdAt - b.createdAt);
    return { root, replies };
  }, []);

  const createThread = useCallback(async ({ title, category, body }) => {
    try {
      const pubkey = await getSignerPubkey();
      const unsigned = {
        kind: 1,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["t", FORUM_TAG],
          ["t", `${FORUM_TAG}-${category}`],
          ["subject", title],
          ...(address ? [["address", address.toLowerCase()]] : []),
        ],
        content: body,
      };
      const signed = await signEvent(unsigned);
      const res = await publishEvent(signed);
      if (!res.ok) return { success: false, error: "No relay accepted the event." };
      return { success: true, id: signed.id };
    } catch (e) {
      return { success: false, error: e.message || "Failed to publish the thread." };
    }
  }, [getSignerPubkey, signEvent, address]);

  const postReply = useCallback(async (threadId, body) => {
    try {
      const pubkey = await getSignerPubkey();
      const unsigned = {
        kind: 1,
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["e", threadId, "", "root"],
          ["t", `${FORUM_TAG}-reply`],
          ...(address ? [["address", address.toLowerCase()]] : []),
        ],
        content: body,
      };
      const signed = await signEvent(unsigned);
      const res = await publishEvent(signed);
      if (!res.ok) return { success: false, error: "No relay accepted the reply." };
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message || "Failed to publish the reply." };
    }
  }, [getSignerPubkey, signEvent, address]);

  return { threads, loadingThreads, error, loadThreads, loadThread, createThread, postReply };
}
