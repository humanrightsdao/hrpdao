import { useEffect, useState } from "react";
import { useNostrRelay } from "./useNostrRelay";

// Module-level cache (shared across all callers/components, mirrors the
// pattern used by useLensProfile.js) — pubkeyHex -> { name, picture } | null.
//
// FIXED: negative results (pubkey queried, nothing found) used to be
// cached as `null` FOREVER (for the rest of the browser session). That
// collided with a real race: NostrChatPage's own-profile publish effect
// (kind:0 publish, see that file) runs independently and in parallel
// with this hook's lookup — nothing coordinates the two. If the lookup
// query happened to resolve before the publish had actually propagated
// to any relay (very plausible: publish is itself async, and on a slow/
// flaky relay set — see lib/nostrRelay.js's comments on relay flakiness
// — it can take a moment), the lookup got 0 events, cached `null`
// permanently, and the name/avatar would then NEVER appear for that
// pubkey again this session — even seconds later once the publish
// actually succeeded. This is exactly what produced a sent message
// with no visible name/avatar for a peer whose profile genuinely does
// exist (including the common self-chat-testing case, where "the peer"
// is your own just-published profile).
//
// Fix: negative results are now cached with a short TTL instead of
// forever, so a natural remount/re-render (opening the conversation
// again, switching tabs, etc.) retries the lookup instead of being
// stuck. Positive results are still cached indefinitely — no reason to
// ever re-fetch something we already successfully found.
const cache = new Map(); // pubkeyHex -> {name, picture} | null
const NEGATIVE_CACHE_TTL_MS = 8000;
const negativeCacheTimestamps = new Map(); // pubkeyHex -> Date.now() of last negative result

function isCacheFresh(pk) {
  if (!cache.has(pk)) return false;
  if (cache.get(pk) !== null) return true; // positive results never expire
  const checkedAt = negativeCacheTimestamps.get(pk) || 0;
  return Date.now() - checkedAt < NEGATIVE_CACHE_TTL_MS;
}

/**
 * Fetches Nostr kind:0 ("set_metadata") profile events for a list of
 * hex pubkeys and returns a { [pubkeyHex]: {name, picture} | null } map.
 *
 * This is what lets the chat show a real display name/avatar instead
 * of just the raw npub — see NostrChatPage.jsx's profile-publish
 * effect for where these kind:0 events actually get written (whenever
 * a user has a derived Nostr identity + a Lens name/avatar to publish).
 * If a peer has never had this app publish a profile for them (e.g.
 * they've never opened the chat page themselves), there's simply
 * nothing to find and the UI falls back to the shortened npub — that
 * fallback already existed, this hook only adds the "found something
 * better" path on top of it.
 *
 * @param {string[]} pubkeyHexList
 * @returns {Record<string, {name: string|null, picture: string|null}|null>}
 */
export function useNostrProfiles(pubkeyHexList) {
  const { queryNostr } = useNostrRelay();
  const [profiles, setProfiles] = useState({});
  const list = pubkeyHexList || [];
  const keyString = list.slice().sort().join(",");

  useEffect(() => {
    if (list.length === 0) return;

    const missing = list.filter((pk) => !isCacheFresh(pk));

    const applyFromCache = () => {
      const result = {};
      list.forEach((pk) => {
        result[pk] = cache.get(pk) || null;
      });
      setProfiles(result);
    };

    if (missing.length === 0) {
      applyFromCache();
      return;
    }

    let cancelled = false;
    (async () => {
      console.log("📡 Querying Nostr kind:0 profiles for", missing.length, "pubkey(s)…");
      try {
        const events = await queryNostr({ kinds: [0], authors: missing });
        if (cancelled) return;
        console.log(`📥 kind:0 query returned ${events.length} event(s) for ${missing.length} requested pubkey(s).`);

        // Keep only the newest kind:0 per author (relays can return
        // several historical revisions).
        const latestByAuthor = {};
        for (const ev of events) {
          const existing = latestByAuthor[ev.pubkey];
          if (!existing || ev.created_at > existing.created_at) {
            latestByAuthor[ev.pubkey] = ev;
          }
        }

        for (const pk of missing) {
          const ev = latestByAuthor[pk];
          if (!ev) {
            cache.set(pk, null);
            negativeCacheTimestamps.set(pk, Date.now());
            continue;
          }
          try {
            const meta = JSON.parse(ev.content);
            cache.set(pk, {
              name: meta.display_name || meta.name || null,
              picture: meta.picture || null,
            });
            negativeCacheTimestamps.delete(pk);
          } catch {
            cache.set(pk, null);
            negativeCacheTimestamps.set(pk, Date.now());
          }
        }
      } catch (err) {
        // Relay query failed — leave `missing` uncached so a later
        // remount can retry, and just fall through to whatever's
        // already cached for the rest of the list.
        console.warn("⚠️ Nostr kind:0 profile query failed:", err);
      } finally {
        if (!cancelled) applyFromCache();
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyString, queryNostr]);

  return profiles;
}

/**
 * Single-pubkey convenience wrapper around useNostrProfiles.
 * @param {string} pubkeyHex
 */
export function useNostrProfile(pubkeyHex) {
  const profiles = useNostrProfiles(pubkeyHex ? [pubkeyHex] : []);
  return pubkeyHex ? profiles[pubkeyHex] || null : null;
}

// ─── Lens-backed cache ───────────────────────────────────────────────────────
// ADDED: relying on Nostr kind:0 alone means a peer's name/avatar only
// ever shows up if (a) they've published a kind:0 at some point AND
// (b) at least one relay we're actually connected to right now has it
// — a real, sometimes-flaky dependency, since relay connectivity in
// this app is best-effort by design (see lib/nostrRelay.js).
//
// But there's a moment we already have perfectly reliable name/avatar
// data for a peer with zero relay involvement: when the chat is
// opened from their Lens profile page (UserProfilePage.jsx already
// has userData.name/avatar loaded from the blockchain right there).
// This cache is how that data reaches the chat UI and survives after
// — write once at that moment (see NostrChatPage.jsx's ThreadView),
// read instantly on every later visit, no network required. Nostr
// kind:0 remains a fallback for peers reached only by pasting a raw
// npub, where the Lens link was never actually shown to us.
const LENS_CACHE_PREFIX = "nostr_lens_profile:";

function readLensProfileCache(pubkeyHex) {
  if (typeof window === "undefined" || !pubkeyHex) return null;
  try {
    const raw = localStorage.getItem(LENS_CACHE_PREFIX + pubkeyHex);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Persists a peer's Lens-sourced name/avatar, keyed by their Nostr hex
 * pubkey, so it can be shown instantly (no relay round-trip) on every
 * future visit to that conversation.
 * @param {string} pubkeyHex
 * @param {{name?: string|null, picture?: string|null}} data
 */
export function cacheLensProfile(pubkeyHex, { name, picture } = {}) {
  if (typeof window === "undefined" || !pubkeyHex) return;
  if (!name && !picture) return;
  try {
    localStorage.setItem(
      LENS_CACHE_PREFIX + pubkeyHex,
      JSON.stringify({ name: name || null, picture: picture || null }),
    );
    console.log("💾 Cached Lens profile for peer", pubkeyHex.slice(0, 8) + "…", { name, hasPicture: !!picture });
  } catch {
    // best-effort only — a full localStorage or disabled storage just
    // means we fall back to the kind:0 lookup below, nothing breaks.
  }
}

/**
 * Resolves display info for a list of peers: Lens-cached data first
 * (instant, reliable), Nostr kind:0 filling in whatever the cache
 * doesn't have. Same { [pubkeyHex]: {name, picture} | null } shape as
 * useNostrProfiles.
 * @param {string[]} pubkeyHexList
 */
export function usePeerProfiles(pubkeyHexList) {
  const list = pubkeyHexList || [];
  const keyString = list.slice().sort().join(",");
  const nostrProfiles = useNostrProfiles(list);
  const [lensProfiles, setLensProfiles] = useState({});

  useEffect(() => {
    const result = {};
    for (const pk of list) {
      result[pk] = readLensProfileCache(pk);
    }
    setLensProfiles(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyString]);

  const merged = {};
  for (const pk of list) {
    const lens = lensProfiles[pk];
    const nostr = nostrProfiles[pk];
    if (!lens && !nostr) {
      merged[pk] = null;
      continue;
    }
    merged[pk] = {
      name: lens?.name || nostr?.name || null,
      picture: lens?.picture || nostr?.picture || null,
    };
  }
  return merged;
}

/** Single-peer convenience wrapper around usePeerProfiles. */
export function usePeerProfile(pubkeyHex) {
  const profiles = usePeerProfiles(pubkeyHex ? [pubkeyHex] : []);
  return pubkeyHex ? profiles[pubkeyHex] || null : null;
}

export default useNostrProfile;
