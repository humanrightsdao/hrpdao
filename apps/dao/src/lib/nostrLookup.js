// A minimal Nostr relay pool — only for looking up a profile by EOA
// address. The same relays as in hrpdaonostr/src/lib/nostr.js.
import { SimplePool, generateSecretKey, getPublicKey, finalizeEvent, nip19 } from "nostr-tools";

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
];

export const RELAYS = (
  import.meta.env.VITE_NOSTR_RELAYS || DEFAULT_RELAYS.join(",")
)
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

export const pool = new SimplePool();

// ── Publishing and signing ────────────────────────────────
// ⚠️ Same approach and same localStorage key as in
// hrpdaonostr/src/lib/nostr.js — BUT since each dev server
// (localhost:5173/5174/5175) is a separate origin, the local key
// ISN'T shared between apps automatically. If someone has a
// NIP-07 extension installed (Alby, nos2x), it works the same
// everywhere — that's the recommended path. The local key is just a
// fallback for people without an extension.
const LOCAL_SK_STORAGE_KEY = "hrpdao_nostr_local_sk_hex";

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hasNip07() {
  return typeof window !== "undefined" && !!window.nostr;
}

function getOrCreateLocalSecretKey() {
  const hex = localStorage.getItem(LOCAL_SK_STORAGE_KEY);
  if (hex) return hexToBytes(hex);
  const sk = generateSecretKey();
  localStorage.setItem(LOCAL_SK_STORAGE_KEY, bytesToHex(sk));
  return sk;
}

export async function getSignerPubkey() {
  if (hasNip07()) {
    try {
      return await window.nostr.getPublicKey();
    } catch {
      // fall back to the local key below
    }
  }
  return getPublicKey(getOrCreateLocalSecretKey());
}

export async function signEvent(unsignedEvent) {
  if (hasNip07()) {
    try {
      return await window.nostr.signEvent(unsignedEvent);
    } catch {
      // fall back to the local key below
    }
  }
  const sk = getOrCreateLocalSecretKey();
  return finalizeEvent(unsignedEvent, sk);
}

export async function publishEvent(event, relays = RELAYS) {
  const settled = await Promise.allSettled(pool.publish(relays, event));
  const accepted = settled.filter((r) => r.status === "fulfilled").length;
  return { ok: accepted > 0 };
}

export function npubFromHex(hex) {
  try {
    return nip19.npubEncode(hex);
  } catch {
    return hex;
  }
}

const profileCache = new Map();

// Profile looked up directly by pubkey (not via wallet-link) — for
// authors of forum posts, where we already know the npub/pubkey from
// the event itself.
export async function getPubkeyProfile(pubkey) {
  if (!pubkey) return null;
  if (profileCache.has(pubkey)) return profileCache.get(pubkey);

  const promise = (async () => {
    try {
      const metaEvents = await pool.querySync(RELAYS, { kinds: [0], authors: [pubkey] });
      if (!metaEvents.length) return { name: null, avatar: null };
      const meta = metaEvents.sort((a, b) => b.created_at - a.created_at)[0];
      let data = {};
      try {
        data = JSON.parse(meta.content) || {};
      } catch {
        data = {};
      }
      return { name: data.display_name || data.name || null, avatar: data.picture || null };
    } catch {
      return { name: null, avatar: null };
    }
  })();

  profileCache.set(pubkey, promise);
  return promise;
}

const WALLET_LINK_KIND = 30100;

// The same wallet-link (kind:30100, tag ["d", address.toLowerCase()])
// that hrpdaonostr publishes via linkWalletToNostr() — the "d" tag
// makes the event replaceable and lets it be found BY ADDRESS,
// regardless of which pubkey signed it.
export async function lookupNostrByAddress(address) {
  if (!address) return null;
  try {
    const dTag = address.toLowerCase();
    const linkEvents = await pool.querySync(RELAYS, {
      kinds: [WALLET_LINK_KIND],
      "#d": [dTag],
    });
    if (!linkEvents.length) return null;

    // The most recent link event (in case of multiple republishes).
    const linkEvent = linkEvents.sort((a, b) => b.created_at - a.created_at)[0];
    const pubkey = linkEvent.pubkey;

    const metaEvents = await pool.querySync(RELAYS, { kinds: [0], authors: [pubkey] });
    if (!metaEvents.length) return { source: "nostr", name: null, avatar: null, url: null };

    const meta = metaEvents.sort((a, b) => b.created_at - a.created_at)[0];
    let data = {};
    try {
      data = JSON.parse(meta.content) || {};
    } catch {
      data = {};
    }

    return {
      source: "nostr",
      name: data.display_name || data.name || null,
      handle: null,
      avatar: data.picture || null,
      url: null,
    };
  } catch {
    return null;
  }
}
