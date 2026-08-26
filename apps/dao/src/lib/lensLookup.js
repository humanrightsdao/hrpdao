// Minimal Lens client — only for looking up a profile by EOA address.
// The same testnet environment as in hrpdaolens/src/lib/lens.js.
import { PublicClient, testnet } from "@lens-protocol/client";
import { fetchAccountsAvailable } from "@lens-protocol/client/actions";

export const lensClient = PublicClient.create({
  environment: testnet,
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
// manages/owns. We take the first one found as the "primary".
export async function lookupLensByAddress(ownerAddress) {
  if (!ownerAddress) return null;
  try {
    const result = await fetchAccountsAvailable(lensClient, {
      managedBy: ownerAddress,
      includeOwned: true,
    });
    if (result.isErr()) return null;

    const first = (result.value.items || []).map((item) => item.account).filter(Boolean)[0];
    if (!first) return null;

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
