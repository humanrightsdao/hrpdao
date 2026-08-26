import { SimplePool } from "nostr-tools";

// SINGLETON: mirrors the lensClient pattern in lib/lens.js — one
// SimplePool for the whole app, created once at module load, instead
// of every component/hook that needs Nostr creating its own pool
// (which would open duplicate WebSocket connections to the same
// relays). SimplePool uses the browser's native WebSocket
// automatically — no useWebSocketImplementation() call needed here,
// that's only for non-browser environments (Node scripts, etc.).
export const nostrPool = new SimplePool();

// A small set of well-known, generally reliable public relays to
// start with. Not exhaustive — Nostr is intentionally multi-relay;
// users on other clients may not see posts unless enough overlap
// exists with the relays they/their client actually reads from. This
// list can grow, or become user-configurable, later.
//
// On "does every relay need to work": no. nostr-tools' SimplePool
// (subscribeMany/querySync, used throughout useNostrRelay.js) tries
// each relay independently and treats a failed connection as that
// one relay simply returning nothing — it does NOT wait for or
// require all of them, and a single reachable relay is enough for
// reads/writes to work (this app's own send/receive already proves
// that: messages and attachments still go through even when the
// console shows one relay's WebSocket failing). The failed-connection
// lines in the console are real but non-fatal — more a "this relay
// happened to be unreachable just now" signal than a bug.
//
// REMOVED: relay.snort.social was consistently unreachable and has
// been dropped. relay.damus.io has ALSO been observed failing
// intermittently in some environments (this seems to be about
// general relay/network flakiness rather than one specific relay
// being bad — different relays fail at different times) — so
// relay.nostr.band was added as a 4th, independently-operated relay
// for extra redundancy: the more relays configured, the less any
// single one's downtime matters, per the "only one has to work"
// point above.
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
];

// ADDED (NIP-92): Grove's gatewayUrls are hash-based with no file
// extension (e.g. https://api.grove.storage/a000c42d...), so Nostr
// clients can't tell from the URL alone that it's an image — they
// just render it as a plain clickable link instead of an inline
// preview. imeta tags explicitly declare "this URL is media, here's
// its mime type" regardless of what the URL looks like. Each entry
// after "imeta" is a single space-delimited "key value" string (per
// NIP-92's own variadic-tag format), NOT a nested array.
export function buildImetaTags(files) {
  return (files || [])
    .filter((f) => f?.gatewayUrl && f?.type)
    .map((f) => ["imeta", `url ${f.gatewayUrl}`, `m ${f.type}`]);
}
