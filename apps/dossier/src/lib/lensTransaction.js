// src/lib/lensTransaction.js
//
// ADDED: one shared place for "sign and actually SEND a Lens operation".
//
// Why this exists: Lens SDK actions like follow(), unfollow(),
// blockAccount(), unblockAccount() (and post(), which useLensPosts.js
// already handles correctly) do NOT perform anything by themselves.
// They return an "operation" — SponsoredTransactionRequest /
// SelfFundedTransactionRequest / TransactionWillFail — that still has to
// be signed by the user's wallet and broadcast, which is what
// handleOperationWith(walletClient) does. useLensFollow.js and
// useLensBlock.js used to skip that step (it was left as a TODO), so the
// button flipped in the UI but nothing was ever sent to Lens. This
// helper does the same sequence useLensPosts.createLensPost() does:
//
//   1. resolve a fresh wallet client on Lens Mainnet,
//   2. call the action (returns the operation),
//   3. .andThen(handleOperationWith(walletClient)) -> txHash,
//   4. wait for Lens to index the transaction.

import { handleOperationWith } from "@lens-protocol/client/viem";
import { chains } from "@lens-chain/sdk/viem";
import { eip712WalletActions } from "viem/zksync";

// Same logic as the (unexported) getViemWalletClient() copies in
// useLensPosts.js / useLensViolations.js / useLensHelpRequests.js:
// make sure the wallet is on Lens Mainnet and add the zkSync EIP-712
// actions Lens transactions need. No window.ethereum fallback — the
// caller must supply the wallet client from
// useLensAuth().getWalletClient() (works for the embedded Privy wallet,
// a linked external wallet and WalletConnect alike).
export const getViemWalletClient = async (externalWalletClient) => {
  const lensChain = chains.mainnet;

  if (!externalWalletClient) {
    throw new Error("Wallet not connected");
  }

  if (externalWalletClient.chain?.id !== lensChain.id) {
    try {
      await externalWalletClient.switchChain({ id: lensChain.id });
    } catch {
      throw new Error(
        "Please switch your wallet's network to Lens Mainnet and try again.",
      );
    }
  }

  return externalWalletClient.extend(eip712WalletActions());
};

const messageOf = (err) =>
  err?.message || (typeof err === "string" ? err : "Unknown error");

/**
 * Sign and send a Lens operation, then wait for it to be indexed.
 *
 * @param {object}   opts
 * @param {object}   opts.sessionClient    authenticated Lens SessionClient
 * @param {Function} opts.getWalletClient  useLensAuth().getWalletClient
 * @param {Function} opts.action           () => the SDK action's result,
 *                                         e.g. () => follow(sessionClient, {...})
 * @param {number}   [opts.timeoutMs=30000] how long to wait for indexing
 * @returns {Promise<{ txHash: string, indexed: boolean }>}
 *   indexed=false means the transaction WAS sent but Lens hadn't indexed
 *   it within timeoutMs — not a failure, reads may just lag briefly.
 * @throws  Error with a readable message when any step fails (session
 *          missing, wallet unavailable/rejected, Lens refuses the
 *          operation, TransactionWillFail, on-chain/indexing failure).
 */
export async function sendLensOperation({
  sessionClient,
  getWalletClient,
  action,
  timeoutMs = 30000,
}) {
  if (!sessionClient) {
    throw new Error("Lens session not found. Please login again.");
  }
  if (typeof getWalletClient !== "function") {
    throw new Error("Wallet not connected");
  }

  const resolvedClient = await getWalletClient();
  const walletClient = await getViemWalletClient(resolvedClient);

  const operation = await action();
  if (operation.isErr()) {
    throw new Error(messageOf(operation.error));
  }

  const sent = await operation.andThen(handleOperationWith(walletClient));
  if (sent.isErr()) {
    throw new Error(messageOf(sent.error));
  }
  const txHash = sent.value;

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  let waited;
  try {
    waited = await Promise.race([
      sessionClient.waitForTransaction(txHash),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }

  if (waited === "timeout") {
    return { txHash, indexed: false };
  }
  if (waited?.isErr?.()) {
    throw new Error(messageOf(waited.error));
  }
  return { txHash, indexed: true };
}
