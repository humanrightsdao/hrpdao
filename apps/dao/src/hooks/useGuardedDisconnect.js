import { usePrivy } from "@privy-io/react-auth";
import { useDisconnect } from "wagmi";

// Extracted verbatim from Layout.jsx's handleDisconnect — sibling to
// useGuardedConnect.js (see that file for the full rationale on why
// this pattern exists). Pulled out so CardPreview's "Змінити гаманець"
// link, on the public /card/:address page, reuses the SAME
// already-debugged sequence instead of growing its own, slightly
// different copy.
//
// Takes two things callers must supply rather than deriving
// internally:
//   - `dao`: each caller has its own useDao() instance to pass down
//     (same reasoning as useGuardedConnect.js).
//   - `loggingOutRef`: comes from usePrivyWalletSync(), which must only
//     be MOUNTED ONCE per page — it drives the reactive effect that
//     syncs a Privy wallet into wagmi. If this hook called
//     usePrivyWalletSync() itself too, that would be a second,
//     independent instance with its own ref, not the one the page's
//     actual sync effect is checking — the guard would silently do
//     nothing. So the ref is threaded in from whichever component on
//     the page already called usePrivyWalletSync() (Layout.jsx,
//     CardPublicPage.jsx).
export function useGuardedDisconnect(dao, loggingOutRef) {
  const { logout: privyLogout } = usePrivy();
  const { disconnect: wagmiDisconnect } = useDisconnect();

  return async function disconnectWallet() {
    // Set BEFORE anything else, for the same reason as in dossier's
    // LensAuthContext.logout(): otherwise the wallet-sync effect can
    // slip in a reconnect before wagmi's disconnect() below has fully
    // taken effect.
    if (loggingOutRef) loggingOutRef.current = true;
    try {
      dao.disconnect();
    } catch (err) {
      console.warn("⚠️ dao.disconnect() error:", err);
    }
    try {
      wagmiDisconnect();
    } catch (err) {
      console.warn("⚠️ wagmi disconnect error:", err);
    }
    try {
      await privyLogout();
    } catch (err) {
      console.warn("⚠️ Privy logout error:", err);
    } finally {
      if (loggingOutRef) loggingOutRef.current = false;
    }
  };
}
