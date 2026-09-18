import { useState, useCallback } from "react";
import { pool, RELAYS, publishEvent } from "../lib/nostrLookup";
import { useNostrIdentity } from "./useNostrIdentity";
import { checkForumRateLimit } from "../lib/forumRateLimit";
import { fetchAllForumModActions, computeBanState } from "../lib/forumModeration";

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
export const FORUM_TAG = "hrpdao-forum";

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

// ── Report events (NIP-56) ───────────────────────────────────────
// A standard Nostr "reporting" event (kind:1984) rather than a made-up
// tag scheme — any NIP-56-aware Nostr client/relay tooling can already
// read these, not just this app. The small, fixed NIP-56 `report-type`
// vocabulary (nudity/malware/profanity/illegal/spam/impersonation/
// other) doesn't have a slot for every category we want to offer in
// the UI, so each of OUR categories maps to the closest NIP-56 type
// for the tag (interoperability), while the exact category the person
// actually picked is kept, verbatim, in the event's own `content` as
// JSON (for our own moderation queue to read precisely).
export const FORUM_REPORT_TAG = `${FORUM_TAG}-report`;

export const FORUM_REPORT_CATEGORIES = [
  { value: "hate_speech", nip56: "other" },
  { value: "violence_incitement", nip56: "illegal" },
  { value: "harassment", nip56: "profanity" },
  { value: "csam_or_minors", nip56: "illegal" },
  { value: "misinformation", nip56: "other" },
  { value: "spam", nip56: "spam" },
  { value: "other", nip56: "other" },
];

function nip56TypeFor(category) {
  return FORUM_REPORT_CATEGORIES.find((c) => c.value === category)?.nip56 || "other";
}

export function useForum(dao) {
  const [threads, setThreads] = useState([]);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [error, setError] = useState(null);
  // Deterministically derived from the connected DAO wallet — same
  // identity as Dossier's, instead of an unrelated random local key.
  // See useNostrIdentity.jsx for why.
  const { getSignerPubkey, signEvent } = useNostrIdentity();
  // `dao.account` rather than wagmi's own useAccount(): this hook now
  // needs dao.canPostToForum() too (the membership gate below), and
  // useDao() must never be called a SECOND time on a page that already
  // has one (see CardPreview.jsx's top comment for exactly the bug
  // that caused) — so the caller passes its ALREADY-EXISTING dao
  // instance in, the same instance `address` now comes from too.
  const address = dao?.account;

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

  // ⚠️ FIX: the forum had NO membership check at all — any wallet,
  // including one that never held a Shield/Council token, could
  // publish straight to the public Nostr relays this forum reads from.
  // Those relays don't reliably support deletion (see the FORUM_TAG
  // comment above), so keeping unvetted wallets out in the first place
  // matters far more here than being able to take a bad post down
  // afterwards. Same eligibility rule as canProposeSanction() in
  // useDao.js (an active Shield/Council token, not currently
  // restricted by a sanction, current on the Human Rights Policy) —
  // this app already treats that as "who's a real, current member".
  function checkForumEligibility() {
    if (dao?.canPostToForum) return dao.canPostToForum();
    return { eligible: false, reason: "Connect your wallet to post" };
  }

  // ⚠️ Cross-app note: this checks ONLY this app's own Nostr ban-vote
  // log (see forumModeration.js's computeBanState) — Dossier's Lens-based
  // reports/mod-actions live on a completely different network and
  // aren't visible here. A quorum reached HERE stops posting HERE
  // immediately, which is real and useful, but it is NOT automatically
  // enforced on Dossier. The one thing BOTH apps already read
  // natively is the on-chain DisciplineModule (dao.isRestricted, part
  // of canPostToForum() above) — so once Shield/Council actually
  // believe a ban-vote quorum reflects a real problem, the "Оформити
  // ончейн-бан" button in ModerationPage.jsx's forum tab turns it into
  // an on-chain FullSlash sanction, which IS enforced identically on
  // both apps because it's the same shared ledger. This local check is
  // the fast, app-level first line of defense while that goes through
  // Shield voting.
  async function checkNotBanned() {
    if (!dao?.account) return { banned: false };
    try {
      const actions = await fetchAllForumModActions();
      const totalEligibleVoters = Number(dao.shieldInfo?.totalSupply || 0);
      return computeBanState(actions, dao.account, totalEligibleVoters);
    } catch {
      return { banned: false }; // fail-open — a relay hiccup shouldn't block a legitimate post
    }
  }

  const createThread = useCallback(async ({ title, category, body }) => {
    const elig = checkForumEligibility();
    if (!elig.eligible) return { success: false, error: elig.reason };
    const ban = await checkNotBanned();
    if (ban.banned) return { success: false, error: "Forum posting is suspended — the community voted to ban this account." };
    try {
      const pubkey = await getSignerPubkey();
      // Rate limit + duplicate-content check — see forumRateLimit.js.
      // Checked AFTER the membership/ban gates (cheap, no network) but
      // BEFORE actually building/signing the event (a wasted signature
      // prompt for a post that's about to be rejected is bad UX).
      const rl = await checkForumRateLimit(pubkey, body);
      if (!rl.allowed) return { success: false, error: rl.reason };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao, getSignerPubkey, signEvent, address]);

  const postReply = useCallback(async (threadId, body) => {
    const elig = checkForumEligibility();
    if (!elig.eligible) return { success: false, error: elig.reason };
    const ban = await checkNotBanned();
    if (ban.banned) return { success: false, error: "Forum posting is suspended — the community voted to ban this account." };
    try {
      const pubkey = await getSignerPubkey();
      const rl = await checkForumRateLimit(pubkey, body);
      if (!rl.allowed) return { success: false, error: rl.reason };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao, getSignerPubkey, signEvent, address]);

  // Reporting is intentionally NOT gated behind full Shield/Council
  // membership like posting is — anyone with a connected wallet can
  // flag something, which is the lower-risk direction (a flood of
  // reports still only ever feeds a queue that member-moderators must
  // act on; it can't by itself take anything down). Only an actual
  // connected wallet is required, so reports aren't fully anonymous.
  const reportPost = useCallback(
    async (targetEventId, targetPubkey, { category, description }) => {
      if (!address) return { success: false, error: "Connect your wallet to post" };
      try {
        const pubkey = await getSignerPubkey();
        const nip56Type = nip56TypeFor(category);
        const unsigned = {
          kind: 1984,
          pubkey,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["e", targetEventId, "", nip56Type],
            ...(targetPubkey ? [["p", targetPubkey, nip56Type]] : []),
            ["t", FORUM_REPORT_TAG],
          ],
          content: JSON.stringify({
            app: "hrpdao-forum-report",
            v: 1,
            category,
            description: description || "",
            reporterAddress: address.toLowerCase(),
          }),
        };
        const signed = await signEvent(unsigned);
        const res = await publishEvent(signed);
        if (!res.ok) return { success: false, error: "No relay accepted the report." };
        return { success: true, id: signed.id };
      } catch (e) {
        return { success: false, error: e.message || "Failed to publish the report." };
      }
    },
    [getSignerPubkey, signEvent, address],
  );

  return {
    threads,
    loadingThreads,
    error,
    loadThreads,
    loadThread,
    createThread,
    postReply,
    reportPost,
    canPost: checkForumEligibility,
  };
}
