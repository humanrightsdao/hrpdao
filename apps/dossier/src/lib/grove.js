// src/lib/grove.js
import { StorageClient, immutable } from "@lens-chain/storage-client";
import { chains } from "@lens-chain/sdk/viem";

export const storageClient = StorageClient.create();

// The Lens network the app works with.
// IMPORTANT: must match the network used by lensClient in src/lib/lens.js.
// In the code (useLensProfile.js, useUserInfo.js) testnet
// (api.testnet.lens.xyz) is used everywhere — so it's testnet here too.
// If the app has already moved to mainnet, replace with chains.mainnet.id.
export const GROVE_CHAIN_ID = chains.testnet.id;

/**
 * Uploads a file (avatar) to Grove and returns a lens:// URI,
 * which can be put directly into the `picture` field of the Lens Account Metadata.
 *
 * ACL: immutable — the file is immediately public and unchangeable. This
 * is deliberately a simpler option than lensAccountOnly + editFile: on
 * every avatar change, a new file is simply uploaded and a new lens://
 * URI results — and that's fine, since the Account Metadata is fully
 * rewritten with a new JSON document on every setAccountMetadata anyway,
 * so there's no point "editing" the previous file in place.
 *
 * @param {File} file
 * @returns {Promise<{uri: string, gatewayUrl: string}>}
 */
export async function uploadFileToGrove(file) {
  if (!file) throw new Error("uploadFileToGrove: file is required");

  const { uri, gatewayUrl } = await storageClient.uploadFile(file, {
    acl: immutable(GROVE_CHAIN_ID),
  });

  return { uri, gatewayUrl };
}
