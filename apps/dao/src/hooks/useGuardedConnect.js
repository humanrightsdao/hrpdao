import { useRef } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";

// Extracted verbatim from Layout.jsx's connectWallet — see the
// "⚠️ FIXED" comments there for the full history of why this exact
// guard sequence exists (double-login collisions, the wrong
// wallet-linking modal appearing instead of the full login modal,
// etc.). Pulled out into its own hook so CardPreview's own "Connect
// Wallet" button (on the public /card/:address page, which needed its
// own copy of this for the tip-sending flow) reuses the SAME,
// already-debugged implementation instead of accumulating a second,
// slightly different one that could silently regress into the same
// bugs. Both Layout.jsx and CardPreview.jsx now call this.
//
// Takes `dao` (the object returned by useDao()) as a parameter rather
// than calling useDao() itself, since Layout.jsx already has its own
// `dao` instance to pass down via <Outlet context={dao} /> — this
// avoids creating a second, redundant useDao() instance there while
// still letting standalone callers (CardPreview) supply their own.
//
// ⚠️ FIXED (double-click on the Card page): the "not yet authenticated"
// branch used to call login() and just return — it never waited for
// dao.isConnected. On Layout.jsx that was masked by a SEPARATE effect
// there (watching dao.silentConnect's identity, which changes once
// wagmi's connector picks up the freshly-linked wallet) that re-ran
// silentConnect() on its own after login() resolved. CardPreview.jsx
// sits OUTSIDE Layout's tree (see the comment on CardPreview itself)
// and has no such effect, so dao.isConnected never got a chance to
// flip after a first, fresh login() — only a SECOND click, landing in
// the "already authenticated" branch below (which DOES retry
// silentConnect()), actually synced it. Now both branches converge on
// the same wait-for-sync step, so either path — already authenticated
// or freshly logged in — nudges dao.isConnected the same way, and one
// click is enough everywhere this hook is used, not just in Layout.
//
// ⚠️ FIXED (Privy modal reopening right after a successful connect):
// the wait-for-sync loop below used to re-check `dao.isConnected`
// itself as the exit condition. `dao` is a plain object returned by a
// SPECIFIC render of useDao() — this async function closed over that
// one snapshot at the moment the click handler fired, so `dao.isConnected`
// keeps reading whatever it was AT THAT INSTANT (false) for the entire
// lifetime of this closure, no matter how many times silentConnect()
// succeeds afterwards on later renders. The on-screen UI still updated
// correctly (that happens via a normal React re-render reading a FRESH
// `dao` object, unrelated to this closure), which is exactly why it
// looked like the connection had worked — right before this same
// function, still trusting its own stale copy, decided the retries had
// "failed", forced a privyLogout(), and called login() again, popping
// the modal right back up. Fix: trust silentConnect()'s own return
// value ({ success, account, signer } | { success: false }) for THIS
// call, not a field read off a snapshot that can't change underneath
// an already-running closure.
//
// ⚠️ FIXED (identical "no provider" on every single retry, confirmed via
// console: [silentConnect] no provider (no active wagmi connector yet) —
// 8/8 times, every retry, never once different): the wait-for-sync loop
// called `dao.silentConnect()` — but `dao` itself, and therefore
// `dao.silentConnect`, is a snapshot from whichever render was current
// when connectWallet() started running. `silentConnect` is a
// useCallback keyed on [connector] (see useDao.js) specifically so its
// identity changes the MOMENT wagmi's connector becomes available via
// usePrivyWalletSync's setActiveWallet() — which is exactly the event
// this loop exists to wait for. But since this async function's `dao`
// variable was fixed at the moment it was invoked, it kept calling the
// SAME OLD closure — the one still bound to connector=null — for all 8
// tries, no matter how many renders happened in the background with a
// fresh connector. That's why literally nothing ever changed between
// attempt 1 and attempt 8: it wasn't retrying against reality, it was
// retrying against a photograph of the moment before the wallet synced.
// Fix: read dao through a ref that's reassigned on every render, so
// each loop iteration calls whatever dao.silentConnect currently is,
// not whatever it was when the click happened.
//
// ⚠️ FIXED (problem STILL persisted after the ref fix above — confirmed
// via the widened logging in usePrivyWalletSync.js): the ref fix was
// correct and working (every retry genuinely re-checked fresh state,
// no more frozen snapshot), but the real console output showed
// "[wallet-sync] no wallets from useWallets() yet" repeating for the
// ENTIRE retry window, across TWO full click-cycles back to back —
// Privy's own useWallets() simply took longer than our old ~4s budget
// to report a freshly-linked external (MetaMask) wallet. Three changes:
// (1) a cheap first phase that only polls wallets.length (a plain state
// read, no extension round trip) before ever touching the expensive
// silentConnect()/_getProvider() path — hammering
// connector.getProvider() every few hundred ms while wallets is still
// empty accomplishes nothing and likely contributes to the
// MaxListenersExceededWarning / "ObjectMultiplex - orphaned data"
// noise from the wallet extension's own content script seen in the
// same console dump; (2) a substantially wider overall budget, sized
// to the real timing we just measured, not a guess; (3) the "force a
// clean privyLogout()+login()" fallback is GONE — the same console
// dump showed it actively backfiring: privyLogout() itself returned a
// 400 from Privy's /sessions/logout endpoint (so no clean session was
// ever produced), and the login() called right after just warned
// "Attempted to log in, but user is already logged in" — net effect
// was two failed network calls and zero progress, on top of possibly
// confusing an in-progress wallet approval. Now it just gives up
// quietly and lets a subsequent click re-enter the same wait — which
// works, since dao.connecting (see below) blocks re-entrant clicks
// while a wait is already running, and Privy's own wallet state only
// improves over time, it doesn't need to be reset to make progress.
//
// ⚠️ FIXED (button looked unresponsive / re-clickable mid-connect):
// dao.connecting existed in useDao.js and was already wired into both
// Layout's and CardPreview's connect button (spinner, "Підключення…"
// label, disabled state) — but nothing ever called its setter, so it
// was permanently false. With the wait budget now measured in seconds
// rather than instant, that stopped being a cosmetic nit and became a
// real problem: the button stayed clickable throughout, so an impatient
// second click could spawn a second, fully overlapping connectWallet()
// call. Now setConnecting(true) brackets the whole flow (login + both
// wait phases) in a try/finally, so the existing UI correctly reflects
// it and re-entrant clicks are blocked by disabled={dao.connecting}.
export function useGuardedConnect(dao) {
  const daoRef = useRef(dao);
  daoRef.current = dao;

  const {
    login,
    ready: privyReady,
    authenticated,
  } = usePrivy();

  const { wallets } = useWallets();
  const walletsRef = useRef(wallets);
  walletsRef.current = wallets;

  return async function connectWallet() {
    if (!privyReady || dao.connecting) return;

    daoRef.current.setConnecting(true);
    try {
      if (!authenticated) {
        try {
          await login();
        } catch (err) {
          // Closing the modal without completing login throws — that's
          // a normal cancellation, not a real error, so it only logs.
          console.warn("⚠️ Wallet login cancelled or failed:", err);
          return;
        }
      }

      if (daoRef.current.isConnected) return;

      // Phase 1 (cheap): wait for Privy to report ANY linked wallet at
      // all before touching the expensive path. Real testing showed
      // this alone can take ~8-10s+ for an external wallet — up to
      // ~15s here on purpose, comfortably above what we measured.
      for (let i = 0; i < 30 && walletsRef.current.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 500));
      }

      // Phase 2: wallets is (hopefully) non-empty now, which lets
      // usePrivyWalletSync's own effect call setActiveWallet() — give
      // that, and dao.silentConnect() picking up the resulting
      // connector, a few tries to land.
      let result = { success: false };
      for (let i = 0; i < 8 && !result.success; i++) {
        await new Promise((r) => setTimeout(r, 600));
        result = await daoRef.current.silentConnect();
        console.warn(`[connectWallet] silentConnect attempt ${i + 1}/8:`, result.success ? "success" : "failed");
      }
      if (!result.success) {
        // ⚠️ TEMPORARILY DISABLED the auto-reload that used to run here.
        // It was a reasonable idea (see the long history in this file's
        // other comments) but in practice it turned a diagnosable
        // problem into an UNDIAGNOSABLE one: every failure triggered an
        // immediate reload, which wipes the console before anyone can
        // read or copy the full sequence — so we could never actually
        // confirm whether isConnected/connector EVER catches up, or
        // gets stuck forever. Stopping cleanly here instead (just
        // resetting dao.connecting via the outer finally, no reload) so
        // the console can be inspected/copied with DevTools' "Preserve
        // log" enabled. Re-introduce a recovery step once we know what
        // it actually needs to recover FROM.
        console.warn(
          "[connectWallet] wallet never synced after extended retries. " +
            "Not reloading automatically — check the console above for whether " +
            "usePrivyWalletSync ever logged 'setActiveWallet(...) resolved OK', " +
            "and if so, whether wagmi's isConnected ever followed.",
        );
      }
    } finally {
      daoRef.current.setConnecting(false);
    }
  };
}
