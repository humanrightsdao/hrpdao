import { useCallback, useEffect, useRef, useState } from "react";
import { useNostrIdentity } from "./useNostrIdentity";
import { useNostrRelay } from "./useNostrRelay";
import { useNostrChat } from "./useNostrChat";
import { getRumorPeer, isRumorMine, extractSenderProfileTags } from "../lib/nostrDm";
import { cacheLensProfile } from "./useNostrProfile";

// localStorage key is scoped per-our-own-pubkey (see storageKeyFor
// below) so switching Nostr identities (shouldn't normally happen —
// see useNostrIdentity's derivation notes — but could after a Privy
// wallet recovery) doesn't mix conversation lists from two different
// identities together.
const storageKeyFor = (pubkey) => `nostr_conversations:${pubkey}`;

const loadKnownPeers = (myPubkey) => {
  try {
    const raw = localStorage.getItem(storageKeyFor(myPubkey));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};

const saveKnownPeers = (myPubkey, peers) => {
  try {
    localStorage.setItem(storageKeyFor(myPubkey), JSON.stringify(peers));
  } catch (err) {
    console.warn("⚠️ Failed to persist Nostr conversation list:", err.message);
  }
};

/**
 * Aggregates individual NIP-17 DMs into a conversation list — one
 * entry per peer we've exchanged messages with, sorted by most recent
 * activity, with an unread flag.
 *
 * IMPORTANT SCOPE NOTE: "unread" here is purely LOCAL to this browser
 * — there is no cross-device or cross-client read-receipt protocol in
 * widespread use on Nostr (unlike, say, WhatsApp's read receipts,
 * which are a feature of one single app everyone uses). Opening a
 * conversation in this app marks it read here; it says nothing about
 * whether the message was seen in another Nostr client.
 *
 * Likewise, this hook does NOT expose any "online" status — Nostr is
 * not connection-based (peers aren't holding open sessions with a
 * server the way, say, XMPP presence works), so there's no reliable
 * source of truth for "is this person online right now." Showing a
 * fabricated indicator would be actively misleading.
 */
export function useNostrConversations() {
  const { nostrIdentity, deriveNostrIdentity } = useNostrIdentity();
  const { queryNostr } = useNostrRelay();
  const { startInboxSubscription, stopInboxSubscription } = useNostrChat();

  // peersRef mirrors `conversations` state but lets the subscription
  // callback read/update the latest list without needing to be
  // re-created (and re-subscribed) every time conversations changes.
  const peersRef = useRef({}); // { [pubkey]: { pubkey, lastMessage, lastTimestamp, unread } }
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);

  const commitConversations = useCallback(() => {
    const list = Object.values(peersRef.current).sort(
      (a, b) => b.lastTimestamp - a.lastTimestamp,
    );
    setConversations(list);
  }, []);

  const upsertPeer = useCallback(
    (pubkey, { lastMessage, lastTimestamp, unread }) => {
      const existing = peersRef.current[pubkey];
      // Never let an older event overwrite a newer one we already have
      // (relays can redeliver, and the past-messages query + the live
      // subscription can both report the same or overlapping events).
      if (existing && existing.lastTimestamp > lastTimestamp) return;
      peersRef.current[pubkey] = {
        pubkey,
        lastMessage,
        lastTimestamp,
        unread: existing ? existing.unread || unread : unread,
      };
    },
    [],
  );

  // Call this right after sending a message to a NEW peer (one not
  // already in the list), so they show up in the conversation list
  // immediately rather than only appearing once/if they reply.
  const registerOutgoingPeer = useCallback(
    (pubkey, lastMessage) => {
      upsertPeer(pubkey, {
        lastMessage,
        lastTimestamp: Math.floor(Date.now() / 1000),
        unread: false,
      });
      commitConversations();
      if (nostrIdentity) {
        saveKnownPeers(nostrIdentity.pubkey, Object.keys(peersRef.current));
      }
    },
    [upsertPeer, commitConversations, nostrIdentity],
  );

  const markConversationRead = useCallback(
    (pubkey) => {
      if (peersRef.current[pubkey]) {
        peersRef.current[pubkey] = {
          ...peersRef.current[pubkey],
          unread: false,
        };
        commitConversations();
      }
    },
    [commitConversations],
  );

  useEffect(() => {
    if (!nostrIdentity) {
      deriveNostrIdentity();
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      // 1. Load past messages TO us, group by sender.
      const pastWraps = await queryNostr({
        kinds: [1059],
        "#p": [nostrIdentity.pubkey],
      });
      if (cancelled) return;

      const { nip17 } = await import("nostr-tools");
      for (const wrap of pastWraps) {
        try {
          const rumor = nip17.unwrapEvent(wrap, nostrIdentity.secretKey);
          // FIXED: this used to always group by rumor.pubkey, which
          // only works for messages the PEER sent us. Since sending
          // now also publishes a self-copy of our own outgoing
          // messages (see useNostrChat.js), rumor.pubkey for one of
          // OUR OWN messages is actually OUR pubkey, not the peer's —
          // getRumorPeer resolves the real peer either way (via the
          // rumor's own "p" tag for self-copies). Our own messages
          // also must never mark the conversation unread.
          const peer = getRumorPeer(rumor, nostrIdentity.pubkey);
          if (!peer) continue;
          upsertPeer(peer, {
            lastMessage: rumor.content,
            lastTimestamp: rumor.created_at,
            unread: !isRumorMine(rumor, nostrIdentity.pubkey),
          });
          // ADDED: pick up the peer's piggybacked name/avatar from
          // their own messages (see lib/nostrDm.js's
          // extractSenderProfileTags) — this is how the conversation
          // list gets a real name/avatar instead of a bare npub,
          // without depending on their kind:0 ever reaching a relay
          // we're connected to.
          if (!isRumorMine(rumor, nostrIdentity.pubkey)) {
            const senderProfile = extractSenderProfileTags(rumor);
            if (senderProfile) cacheLensProfile(peer, senderProfile);
          }
        } catch {
          // skip undecryptable/irrelevant wraps
        }
      }

      // 2. Also include peers we've previously sent to but who may
      // never have replied (so outgoing-only conversations don't
      // disappear on reload — the inbox subscription above only ever
      // sees messages addressed TO us).
      const knownPeers = loadKnownPeers(nostrIdentity.pubkey);
      for (const pk of knownPeers) {
        if (!peersRef.current[pk]) {
          peersRef.current[pk] = {
            pubkey: pk,
            lastMessage: null,
            lastTimestamp: 0,
            unread: false,
          };
        }
      }

      if (!cancelled) {
        commitConversations();
        setLoading(false);
      }
    })();

    // 3. Live updates for anything new (including live echoes of our
    // own self-copies — see the FIXED note above for why those must
    // be grouped under the real peer and never marked unread).
    startInboxSubscription((rumor) => {
      const peer = getRumorPeer(rumor, nostrIdentity.pubkey);
      if (!peer) return;
      upsertPeer(peer, {
        lastMessage: rumor.content,
        lastTimestamp: rumor.created_at,
        unread: !isRumorMine(rumor, nostrIdentity.pubkey),
      });
      if (!isRumorMine(rumor, nostrIdentity.pubkey)) {
        const senderProfile = extractSenderProfileTags(rumor);
        if (senderProfile) cacheLensProfile(peer, senderProfile);
      }
      commitConversations();
      saveKnownPeers(nostrIdentity.pubkey, Object.keys(peersRef.current));
    });

    return () => {
      cancelled = true;
      stopInboxSubscription();
    };
  }, [
    nostrIdentity,
    deriveNostrIdentity,
    queryNostr,
    startInboxSubscription,
    stopInboxSubscription,
    upsertPeer,
    commitConversations,
  ]);

  return {
    conversations, // [{ pubkey, lastMessage, lastTimestamp, unread }], newest first
    loading,
    registerOutgoingPeer,
    markConversationRead,
  };
}

export default useNostrConversations;
