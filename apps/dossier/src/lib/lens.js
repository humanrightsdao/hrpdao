import { PublicClient, mainnet } from "@lens-protocol/client";

// MIGRATED to Lens Mainnet (api.lens.xyz). This is the primary Lens SDK
// client used across the app for GraphQL reads/writes (posts, comments,
// follows, reactions, etc). Must stay in sync with:
//   - src/lib/grove.js (GROVE_CHAIN_ID)
//   - src/main.jsx (PrivyProvider defaultChain)
//   - the `chains.mainnet` references in useLensPosts.js,
//     useLensViolations.js, useLensHelpRequests.js
// A mismatch between this environment and defaultChain causes
// "403 Forbidden" from the RPC (see main.jsx comment history).
export const lensClient = PublicClient.create({
  environment: mainnet,
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
});
