// src/hooks/useFiatOnramp.js
//
// Fiat-onramp funding for the TipJar flow — lets a visitor without any
// crypto buy ETH (for gas) and/or the tip token with a card, straight
// into their Privy embedded wallet, then the existing useTipJar.js
// flow (approve → tip) runs completely unchanged.
//
// ── WHY THIS IS SEPARATE FROM useTipJar.js ──────────────────────────
// useTipJar.js talks to the TipJar contract. This hook talks to
// Privy's funding UI (which itself routes to MoonPay/Coinbase/Meld
// depending on the visitor's region) — there is no on-chain
// interaction here at all, and no dependency between the two beyond
// "run this one first if the wallet is empty".
//
// ── STATUS: implemented now, INACTIVE until mainnet ─────────────────
// Per Privy's own docs, card/fiat-onramp purchases only work on
// mainnets — on testnets (incl. our current Arbitrum Sepolia) the
// underlying providers cannot sell testnet tokens, so the funding
// flow would just fail. Rather than ship a button that's guaranteed
// to error out on every environment we can currently test on, this
// hook self-disables (`enabled: false`) unless:
//   1. VITE_ENABLE_FIAT_ONRAMP="true" is set, AND
//   2. ACTIVE_CHAIN.chainIdDec is in ONRAMP_SUPPORTED_CHAIN_IDS below.
// ⚠️ ONRAMP_SUPPORTED_CHAIN_IDS currently lists Arbitrum One (42161)
// as the anticipated production chain — confirm/update this the day
// the real mainnet deployment's chain is finalized (see
// MIGRATION_NOTES.md). Nothing else in this file needs to change when
// that happens — just flip the env var and, if the chain id differs
// from 42161, update the array below.
//
// ── GAS TOP-UP AMOUNT ────────────────────────────────────────────────
// VITE_ONRAMP_GAS_TOPUP_ETH is intentionally left as a placeholder
// (0.0015 ETH default below) — this needs a real estimate from actual
// approve()+tip() gas costs on the target mainnet before launch (see
// the GAS_OPTS / estimateGas comments in useTipJar.js for the same
// exercise done for the static tip() gas limit). Do not ship to
// production with the default unexamined.

import { useCallback, useMemo } from "react";
import { useFundWallet } from "@privy-io/react-auth";
import { arbitrum } from "viem/chains";
import { ACTIVE_CHAIN } from "./useDao";

// ── Feature flag + chain gate ───────────────────────────────────────

const FLAG_ENABLED = import.meta.env.VITE_ENABLE_FIAT_ONRAMP === "true";

// Chains where card/fiat onramp purchases are actually possible today
// (mainnets only — see the file-level comment above). Update this list
// alongside ACTIVE_CHAIN in useDao.js when the real production chain
// is decided at deploy time.
const ONRAMP_SUPPORTED_CHAIN_IDS = [42161]; // Arbitrum One

const CHAIN_BY_ID = {
  42161: arbitrum,
};

// Default suggested ETH top-up if the caller doesn't pass one — see
// the "GAS TOP-UP AMOUNT" note above. Deliberately conservative/
// placeholder, must be tuned with a real estimate before launch.
const DEFAULT_GAS_TOPUP_ETH =
  import.meta.env.VITE_ONRAMP_GAS_TOPUP_ETH || "0.0015";

export function useFiatOnramp() {
  const { fundWallet } = useFundWallet();

  const isOnrampSupportedHere = ONRAMP_SUPPORTED_CHAIN_IDS.includes(
    ACTIVE_CHAIN.chainIdDec,
  );
  const enabled = FLAG_ENABLED && isOnrampSupportedHere;

  const fundingChain = useMemo(
    () => CHAIN_BY_ID[ACTIVE_CHAIN.chainIdDec],
    [],
  );

  // ── Step 1: top up native ETH for gas ───────────────────────────
  const fundGas = useCallback(
    async (address, amountEth = DEFAULT_GAS_TOPUP_ETH) => {
      if (!enabled) return { success: false, error: "onramp_disabled" };
      if (!address) return { success: false, error: "no_address" };
      try {
        await fundWallet(address, {
          chain: fundingChain,
          asset: "native-currency",
          amount: String(amountEth),
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: err?.message || "fund_gas_failed" };
      }
    },
    [enabled, fundWallet, fundingChain],
  );

  // ── Step 2: buy the tip token itself ────────────────────────────
  // tokenAddress is whichever token the visitor picked in the tip
  // form (CardPreview.jsx's `selectedToken`) — this hook doesn't
  // assume a single default token, since the mainnet deployment may
  // register several accepted tokens in TipJar (see TipJar.sol's
  // setStablecoin/setOraclePricedToken, both DAO-governed).
  const fundToken = useCallback(
    async (address, tokenAddress, amountHuman) => {
      if (!enabled) return { success: false, error: "onramp_disabled" };
      if (!address) return { success: false, error: "no_address" };
      if (!tokenAddress) return { success: false, error: "no_token" };
      try {
        await fundWallet(address, {
          chain: fundingChain,
          asset: { erc20: tokenAddress },
          amount: amountHuman != null ? String(amountHuman) : undefined,
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: err?.message || "fund_token_failed" };
      }
    },
    [enabled, fundWallet, fundingChain],
  );

  return { enabled, fundGas, fundToken };
}
