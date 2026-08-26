import { PublicClient, testnet } from "@lens-protocol/client";

export const lensClient = PublicClient.create({
  environment: testnet,
  storage: typeof window !== "undefined" ? window.localStorage : undefined,
});
