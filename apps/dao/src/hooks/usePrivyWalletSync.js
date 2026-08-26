// src/hooks/usePrivyWalletSync.js
//
// Ported from dossier's src/context/LensAuthContext.jsx (the
// "wallet-sync" effect there) — dao-app has no equivalent auth context
// of its own, so this is the same logic as a small standalone hook.
//
// In theory @privy-io/wagmi's WagmiProvider auto-syncs whichever
// wallet becomes active into wagmi's own state — in practice this
// sync can lag or miss entirely right after a FRESH embedded wallet is
// created (the account exists on Privy's side, its own "Success" modal
// confirms that, but wagmi's useAccount().isConnected never flips
// true). Privy's own official demos handle this by explicitly setting
// the active wallet via useSetActiveWallet() once it appears in
// useWallets() — see the effect below — instead of relying purely on
// the automatic sync.
//
// Usage (in Layout.jsx, mounted once at the root):
//   import { usePrivyWalletSync } from "../hooks/usePrivyWalletSync";
//   ...
//   const loggingOutRef = usePrivyWalletSync();
//   // pass loggingOutRef.current = true right before disconnecting, so
//   // this effect doesn't race a logout and silently reconnect mid-flow
//   // (see handleDisconnect in Layout.jsx).

import { useEffect, useRef } from "react";
import { useAccount } from "wagmi";
import { useWallets } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";

export function usePrivyWalletSync() {
  const { isConnected } = useAccount();
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const loggingOutRef = useRef(false);
  // FIXED: this effect's guard only checked `isConnected` — but
  // isConnected doesn't flip true the instant setActiveWallet() is
  // called, it takes at least one more render cycle for wagmi to
  // actually register the new active connector. In that window, a
  // re-fire of this effect (wallets/setActiveWallet identity change,
  // or just an unrelated re-render) called setActiveWallet() a SECOND
  // time for the exact same wallet before the first call had even
  // resolved — two concurrent connect() calls to the same wallet,
  // which is what produced "wallet_requestPermissions already
  // pending" and an extra permission popup on every reload (see
  // Dossier's LensAuthContext.jsx for the original report — identical
  // effect, identical fix). syncInFlightRef closes that gap: once a
  // setActiveWallet() call is in progress, any re-fire of this effect
  // just skips instead of starting a second one.
  const syncInFlightRef = useRef(false);

  // FIXED (round 2 — confirmed via console trace in dossier's app):
  // syncInFlightRef only protects against OVERLAPPING calls, i.e. a
  // second setActiveWallet() starting before the first one has
  // resolved. It does NOT protect against SEQUENTIAL redundant calls
  // — and that's what was actually happening: setActiveWallet() would
  // resolve OK, syncInFlightRef would reset to false, but wagmi's own
  // isConnected takes a few more renders to actually flip true. In
  // that window this effect re-fires (wallets identity change, or
  // React just re-rendering), sees isConnected still false, and —
  // since nothing was in flight anymore — happily starts a BRAND NEW
  // setActiveWallet() call for the exact same wallet it had literally
  // just finished connecting a moment earlier. Each of those is a
  // real wallet_requestPermissions round-trip to MetaMask; several of
  // them back-to-back is exactly what produced the repeated "already
  // pending" RPC errors (and the connect prompt reappearing) on every
  // page load. syncedAddressRef fixes this at the right level: once a
  // given address has been successfully handed to setActiveWallet(),
  // we don't ask again for THAT address, no matter how many more
  // times this effect re-fires before wagmi's isConnected catches up.
  // It only resets when the wallet list genuinely changes (logout, or
  // the user switches accounts in the extension).
  const syncedAddressRef = useRef(null);

  useEffect(() => {
    if (!wallets?.length) {
      syncedAddressRef.current = null; // nothing linked anymore — allow a fresh sync next time a wallet appears
      return;
    }
    if (isConnected) return; // wagmi already has an active wallet — nothing to do
    if (loggingOutRef.current) return; // logout in progress — don't reconnect mid-flow
    if (syncInFlightRef.current) return; // a setActiveWallet() call is already in flight

    // Prefer the embedded wallet (walletClientType === "privy") if one
    // exists — that's the one users created via email/Google/passkey.
    // Fall back to whichever wallet Privy reports first (e.g. a linked
    // external wallet) if there's no embedded one.
    const target =
      wallets.find((w) => w.walletClientType === "privy") || wallets[0];
    if (!target) return;
    if (syncedAddressRef.current === target.address) return; // already asked this wallet to reconnect — just waiting for wagmi's own state to catch up, not a reason to ask again
    syncInFlightRef.current = true;
    setActiveWallet(target)
      .then(() => {
        syncedAddressRef.current = target.address;
      })
      .catch((err) =>
        console.warn("⚠️ [wallet-sync] setActiveWallet failed:", err),
      )
      .finally(() => {
        syncInFlightRef.current = false;
      });
  }, [wallets, isConnected, setActiveWallet]);

  return loggingOutRef;
}
