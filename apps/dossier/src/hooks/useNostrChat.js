import { useCallback, useRef } from "react";
import { nip17, nip59 } from "nostr-tools";
import { useNostrIdentity } from "./useNostrIdentity";
import { useNostrRelay } from "./useNostrRelay";
import { buildSenderProfileTags } from "../lib/nostrDm";

/**
 * NIP-17 private direct messages ("gift-wrapped" DMs — the current
 * Nostr standard, replacing the older/weaker NIP-04). nostr-tools'
 * nip17.wrapEvent/unwrapEvent already handle the full seal → gift-wrap
 * layering (NIP-59) and the metadata-privacy randomization (wrap
 * timestamps are deliberately jittered so relays can't tell exactly
 * when a conversation happened) — this hook is a thin layer on top
 * that plugs in our derived Nostr identity (useNostrIdentity) and the
 * shared relay pool (useNostrRelay).
 */
export function useNostrChat() {
  const { nostrIdentity, deriveNostrIdentity } = useNostrIdentity();
  const { publishToNostr, subscribeToNostr } = useNostrRelay();
  const unsubscribeRef = useRef(null);

  /**
   * Sends a private DM. recipientPubkeyHex must be the recipient's
   * raw hex pubkey (not their bech32 npub — see nip19.decode if you
   * only have an npub string).
   * @param {string} recipientPubkeyHex
   * @param {string} text
   * @param {{conversationTitle?: string, extraTags?: string[][]}} [options]
   *   conversationTitle - optional, for group-style threads.
   *   extraTags - additional NIP-17 rumor tags, e.g. NIP-92 "imeta"
   *   tags for media attachments (see lib/nostrRelay.js's
   *   buildImetaTags — the same helper post-creation already uses).
   *   senderProfile - our own current Lens name/avatar, piggybacked
   *   onto the rumor so the recipient can show OUR identity without
   *   depending on a separate kind:0 publish/query round-trip ever
   *   succeeding (see lib/nostrDm.js's buildSenderProfileTags).
   * @returns {Promise<{success: boolean, relays: object[], eventId: string, rumor: object}>}
   */
  // FIXED: this used to publish a SINGLE gift wrap — addressed only to
  // the recipient — which meant WE could never decrypt our own sent
  // messages back (a gift wrap's content is only readable by whoever
  // it's addressed to, and that was never us). The visible symptom:
  // the other person's messages showed up fine, but the moment this
  // thread reloaded its history from the relay (page refresh, reopening
  // the conversation, another tab/device), everything WE had sent
  // vanished — nothing on the relay let us read it back.
  //
  // The fix is the standard NIP-17 "self-copy" pattern: build the
  // rumor (the actual plaintext kind:14 event) ONCE, then wrap that
  // SAME rumor twice — once encrypted for the recipient (the message
  // that actually reaches them), and once encrypted for ourselves (so
  // OUR OWN relay history query can decrypt it later). Reusing one
  // rumor object for both wraps guarantees they share the exact same
  // id/content/timestamp, so a live-subscription echo of our own
  // self-copy can be deduplicated by id instead of appearing as a
  // second, near-identical bubble. The rumor's "p" tag (recipient) is
  // what lets us later recover which peer a self-copy belongs to —
  // see getRumorPeer in lib/nostrDm.js.
  const sendDirectMessage = useCallback(
    async (recipientPubkeyHex, text, options = {}) => {
      const { conversationTitle, extraTags = [], senderProfile } = options;
      const identity = nostrIdentity || (await deriveNostrIdentity());
      if (!identity) throw new Error("No Nostr identity available.");

      const tags = [
        ["p", recipientPubkeyHex],
        ...extraTags,
        ...buildSenderProfileTags(senderProfile),
      ];
      if (conversationTitle) tags.push(["subject", conversationTitle]);

      const rumor = nip59.createRumor(
        { kind: 14, content: text, tags },
        identity.secretKey,
      );
      const wrapToRecipient = nip59.createWrap(
        nip59.createSeal(rumor, identity.secretKey, recipientPubkeyHex),
        recipientPubkeyHex,
      );
      const wrapToSelf = nip59.createWrap(
        nip59.createSeal(rumor, identity.secretKey, identity.pubkey),
        identity.pubkey,
      );

      const [recipientResults] = await Promise.all([
        publishToNostr(wrapToRecipient),
        publishToNostr(wrapToSelf),
      ]);

      return {
        success: recipientResults.some((r) => r.ok),
        relays: recipientResults,
        eventId: wrapToRecipient.id,
        // The plaintext rumor — safe to use for local/optimistic UI
        // (it never leaves this function unencrypted).
        rumor,
      };
    },
    [nostrIdentity, deriveNostrIdentity, publishToNostr],
  );

  /**
   * Starts listening for incoming DMs addressed to us (gift-wrapped
   * events, kind 1059, tagged #p with our own pubkey). Calls
   * onMessage(rumor) for each event we can successfully unwrap —
   * rumor.pubkey is the SENDER's pubkey, rumor.content is the
   * plaintext, rumor.created_at is when it was actually written
   * (NOT the outer wrap's timestamp, which NIP-17 randomizes on
   * purpose so relays can't pin down real send times).
   *
   * Only one inbox subscription is tracked per hook instance —
   * calling this again replaces the previous one (closing it first).
   * @param {(rumor: {pubkey: string, content: string, created_at: number, id: string}) => void} onMessage
   * @returns {Promise<() => void>} unsubscribe
   */
  const startInboxSubscription = useCallback(
    async (onMessage) => {
      const identity = nostrIdentity || (await deriveNostrIdentity());
      if (!identity) throw new Error("No Nostr identity available.");

      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }

      const unsubscribe = subscribeToNostr(
        { kinds: [1059], "#p": [identity.pubkey] },
        (wrapEvent) => {
          try {
            const rumor = nip17.unwrapEvent(wrapEvent, identity.secretKey);
            onMessage(rumor);
          } catch (err) {
            // Not every kind:1059 a relay hands us is necessarily one
            // we can decrypt (relay quirks, events using a different
            // wrap scheme, etc.) — skip quietly instead of surfacing
            // noise for every one that doesn't unwrap cleanly.
            console.warn(
              "⚠️ Failed to unwrap an incoming Nostr DM:",
              err.message,
            );
          }
        },
      );
      unsubscribeRef.current = unsubscribe;
      return unsubscribe;
    },
    [nostrIdentity, deriveNostrIdentity, subscribeToNostr],
  );

  const stopInboxSubscription = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }, []);

  return {
    sendDirectMessage,
    startInboxSubscription,
    stopInboxSubscription,
  };
}

export default useNostrChat;
