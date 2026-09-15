import { ethers } from "ethers";
import { fetchUsername } from "@lens-protocol/client/actions";
import { lookupLensByAddress, lensClient } from "./lensLookup";
import { lookupNostrByAddress } from "./nostrLookup";
import { truncAddr } from "./format";
import { encodeAddressCode, decodeAddressCode } from "./publicId";

// ENS lives on Ethereum mainnet (L1) — independent of whichever network
// the DAO itself uses (Lens Chain / Arbitrum / Anvil). A public
// read-only RPC used only for reverse name resolution.
const ensProvider = new ethers.JsonRpcProvider("https://eth.llamarpc.com");

const cache = new Map(); // address -> resolved identity object
const inflight = new Map(); // address -> Promise, to avoid duplicating parallel requests

async function lookupENS(address) {
  try {
    const name = await ensProvider.lookupAddress(address);
    if (!name) return null;
    return { source: "ens", name, handle: null, avatar: null, url: `https://app.ens.domains/${name}` };
  } catch {
    return null;
  }
}

// Priority: Lens → Nostr → ENS → shortened address. The first source that
// finds something "wins" — the DAO app doesn't store anything of its own,
// it only reads profiles that already exist in the user's ecosystem.
export async function resolveIdentity(address) {
  if (!address) return { source: null, name: null, avatar: null, display: "" };
  const key = address.toLowerCase();

  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const promise = (async () => {
    const lens = await lookupLensByAddress(address).catch(() => null);
    if (lens?.name || lens?.handle) {
      const result = { ...lens, display: lens.name || lens.handle };
      cache.set(key, result);
      return result;
    }

    const nostr = await lookupNostrByAddress(address).catch(() => null);
    if (nostr?.name) {
      const result = { ...nostr, display: nostr.name };
      cache.set(key, result);
      return result;
    }

    const ens = await lookupENS(address).catch(() => null);
    if (ens?.name) {
      const result = { ...ens, display: ens.name };
      cache.set(key, result);
      return result;
    }

    const fallback = { source: null, name: null, avatar: null, url: null, display: truncAddr(address) };
    cache.set(key, fallback);
    return fallback;
  })();

  inflight.set(key, promise);
  const result = await promise;
  inflight.delete(key);
  return result;
}

// ── Public card link/QR: pick what goes in the URL ──────────────────────
// Used by VisitCardPage.jsx when building the /card/:id link + QR for the
// OWNER's own address (a plain reverse lookup — no network round-trip
// beyond what resolveIdentity() already does). Prefers an ENS name or
// Lens handle (reads as a normal, non-wallet-looking name/link); falls
// back to the base58 "public code" from publicId.js for everyone else —
// never the raw "0x..." address, which is the whole point of this
// feature (see the card-link discussion: a raw address in the link
// tempts visitors into sending funds directly to it, bypassing TipJar's
// split entirely). Nostr display names are skipped here on purpose —
// they can contain spaces/emoji/arbitrary Unicode, which makes for a
// messy, unreliable URL segment; Nostr identities still show normally
// on the card itself, just not in the link.
export async function buildPublicCardId(address) {
  if (!address || !ethers.isAddress(address)) return null;
  const identity = await resolveIdentity(address);
  if (identity.source === "ens" && identity.name) return identity.name;
  if (identity.source === "lens" && identity.handle) {
    return identity.handle.replace(/^@/, "");
  }
  return encodeAddressCode(address);
}

// ── Public card link/QR: reverse it back to an address ──────────────────
// Used by CardPublicPage.jsx for whatever ends up in the :id route param.
// Tries, in order: a raw address (old links/QR codes printed before this
// feature existed keep working unchanged) → one of our own base58 codes
// → an ENS name → a Lens handle. Returns null if none of these resolve,
// which the caller shows as "invalid address" — same as today.
export async function resolveAddressFromPublicId(idOrCode) {
  if (!idOrCode) return null;

  if (ethers.isAddress(idOrCode)) return ethers.getAddress(idOrCode);

  const decoded = decodeAddressCode(idOrCode);
  if (decoded) return decoded;

  if (idOrCode.endsWith(".eth")) {
    try {
      const addr = await ensProvider.resolveName(idOrCode);
      if (addr) return ethers.getAddress(addr);
    } catch {
      // fall through to "not found"
    }
    return null;
  }

  try {
    const localName = idOrCode.replace(/^@/, "");
    const result = await fetchUsername(lensClient, { username: { localName } });
    // `linkedTo` is the Account this username is actually attached to
    // (the address whose RIGHTS/Shield/Council status the DAO tracks);
    // `owner` (the EOA holding the username NFT) is a fallback for the
    // rare case a username exists but hasn't been linked to an Account.
    const resolvedAddr = result.isErr() ? null : result.value?.linkedTo || result.value?.owner;
    if (resolvedAddr) return ethers.getAddress(resolvedAddr);
  } catch {
    // fall through to "not found"
  }

  return null;
}
