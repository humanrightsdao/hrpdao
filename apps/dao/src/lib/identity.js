import { ethers } from "ethers";
import { lookupLensByAddress } from "./lensLookup";
import { lookupNostrByAddress } from "./nostrLookup";
import { truncAddr } from "./format";

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
