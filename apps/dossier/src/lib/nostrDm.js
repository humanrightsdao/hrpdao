// src/lib/nostrDm.js

/**
 * Given a decrypted NIP-17 rumor (the unwrapped kind:14 event) and our
 * own pubkey, returns the pubkey of the OTHER party in this 1:1 DM
 * conversation — regardless of whether the rumor is one someone sent
 * TO us (rumor.pubkey is already the peer) or one of our OWN
 * self-copies of a message WE sent (rumor.pubkey is US; the real peer
 * is only recoverable from the rumor's own "p" tag — see
 * useNostrChat.js's sendDirectMessage for why every rumor we create
 * carries that tag, and why we publish a self-copy at all).
 *
 * @param {{pubkey: string, tags: string[][]}} rumor
 * @param {string} myPubkeyHex
 * @returns {string|null}
 */
export function getRumorPeer(rumor, myPubkeyHex) {
  if (!rumor || !myPubkeyHex) return null;
  if (rumor.pubkey !== myPubkeyHex) return rumor.pubkey;
  const peerTag = (rumor.tags || []).find(
    (tag) => tag[0] === "p" && tag[1] && tag[1] !== myPubkeyHex,
  );
  return peerTag ? peerTag[1] : null;
}

/**
 * True when a (already peer-matched) rumor was authored by us — i.e.
 * it's our own message (either the live send or a self-copy read back
 * from the relay), not one from the peer.
 * @param {{pubkey: string}} rumor
 * @param {string} myPubkeyHex
 */
export function isRumorMine(rumor, myPubkeyHex) {
  return !!rumor && rumor.pubkey === myPubkeyHex;
}

// ADDED: every outgoing rumor carries the sender's OWN current Lens
// name/avatar as a couple of extra tags — see useNostrChat.js's
// sendDirectMessage. This is what lets a chat participant's name/
// avatar show up reliably: it rides along with a message they're
// already sending anyway, instead of depending on them (or us) ever
// separately publishing — and successfully having a relay accept — a
// standalone kind:0 event. In testing, kind:0 publish/query proved
// genuinely flaky (a relay being briefly unreachable is enough for a
// profile to just never be found), while an actual DM getting through
// is the one thing already proven to work every time messaging works
// at all.
const SENDER_NAME_TAG = "client_name";
const SENDER_PICTURE_TAG = "client_picture";

/**
 * Builds the optional sender-identity tags to attach to an outgoing
 * rumor (see buildDmContentTags below / sendDirectMessage).
 * @param {{name?: string|null, picture?: string|null}} [senderProfile]
 * @returns {string[][]}
 */
export function buildSenderProfileTags(senderProfile) {
  if (!senderProfile) return [];
  const tags = [];
  if (senderProfile.name) tags.push([SENDER_NAME_TAG, senderProfile.name]);
  if (senderProfile.picture) tags.push([SENDER_PICTURE_TAG, senderProfile.picture]);
  return tags;
}

/**
 * Reads the sender-identity tags back out of a decrypted rumor. Only
 * meaningful for a rumor that isn't our own (i.e. rumor.pubkey is the
 * peer, not us) — see NostrChatPage.jsx/useNostrConversations.js for
 * where this feeds into the Lens-profile cache.
 * @param {{tags: string[][]}} rumor
 * @returns {{name: string|null, picture: string|null}|null}
 */
export function extractSenderProfileTags(rumor) {
  const tags = rumor?.tags || [];
  const name = tags.find((t) => t[0] === SENDER_NAME_TAG)?.[1] || null;
  const picture = tags.find((t) => t[0] === SENDER_PICTURE_TAG)?.[1] || null;
  if (!name && !picture) return null;
  return { name, picture };
}

export default getRumorPeer;
