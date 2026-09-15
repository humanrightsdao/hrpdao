// Minimal Lens client — only for looking up a profile by EOA address.
// MIGRATED to Lens Mainnet, to stay in sync with dossier-app's own
// src/lib/lens.js (see dossier's CHANGES_MAINNET.md). This client is
// also used by dossierFeed.js and moderationCheck.js to fetch posts
// filtered by VITE_LENS_APP_ADDRESS — that address now points at the
// mainnet App, so querying it against the testnet indexer returns no
// results, which is why the social feed disappeared after the mainnet
// cutover.
import { PublicClient, mainnet } from "@lens-protocol/client";
import { fetchAccountsAvailable } from "@lens-protocol/client/actions";

export const lensClient = PublicClient.create({
  environment: mainnet,
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
});

const resolvePicture = (picture) => {
  if (!picture) return null;
  if (typeof picture === "object") {
    picture = picture?.optimized?.uri || picture?.raw?.uri || picture?.uri || null;
    if (!picture) return null;
  }
  if (picture.startsWith("lens://")) {
    return `https://api.grove.storage/${picture.replace("lens://", "")}`;
  }
  if (picture.startsWith("ar://")) return `https://arweave.net/${picture.replace("ar://", "")}`;
  if (picture.startsWith("ipfs://")) return `https://ipfs.io/ipfs/${picture.replace("ipfs://", "")}`;
  return picture;
};

// Same approach as fetchAllLensAccountsForOwner in hrpdaolens
// (useLensProfile.js) — finds all Lens Accounts an EOA address
// manages/owns.
export async function lookupLensByAddress(ownerAddress) {
  if (!ownerAddress) return null;
  try {
    const result = await fetchAccountsAvailable(lensClient, {
      managedBy: ownerAddress,
      includeOwned: true,
    });
    if (result.isErr()) return null;

    const items = (result.value.items || []).map((item) => item.account).filter(Boolean);
    if (items.length === 0) return null;

    // ⚠️ FIXED: one wallet can manage/own MORE THAN ONE Lens Account —
    // dossier's own useLensProfile.js hit this exact issue and already
    // documents it (see its comment there): naively taking items[0] can
    // land on an empty, un-named "default" account while the person's
    // actual, named account sits later in the list. dossier works
    // around this with a per-browser localStorage preference
    // (`lens_account_address`) recording which account the person
    // picked — but that's dossier's OWN origin's storage, invisible
    // here (this app is a different domain), and there's no
    // cross-app "default account" field the Lens API exposes either.
    // The safe, universal fix that needs no shared state at all: never
    // prefer a nameless account over a named one. A visitor who already
    // set up a name/username in dossier will now show it here too,
    // instead of this picking whichever empty account happened to
    // come first in the API's response order.
    const first = items.find((a) => a.metadata?.name || a.username?.localName) || items[0];

    return {
      source: "lens",
      name: first.metadata?.name || first.username?.localName || null,
      handle: first.username?.localName ? `@${first.username.localName}` : null,
      avatar: resolvePicture(first.metadata?.picture),
      url: first.username?.localName ? `/u/${first.username.localName}` : null,
    };
  } catch {
    return null;
  }
}
