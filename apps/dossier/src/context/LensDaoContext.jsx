// src/context/LensDaoContext.jsx
//
// ⚠️ FIXED (multiple independent useLensDAO() instances): every one of
// HelpRequestPage.jsx, PostPage.jsx, ViolationDetailsPage.jsx,
// GovernancePage.jsx, FollowingPage.jsx, ViolationsListPage.jsx,
// SupportPage.jsx and CountryFeed.jsx used to call `useLensDAO()`
// itself — each one independently reconnecting the wallet, re-checking
// Shield/Council status, and re-registering its OWN
// "accountsChanged"/"chainChanged" listeners (which call
// window.location.reload() — see useLensDAO.js's _reloadOnWalletChange)
// on every single page navigation, from scratch.
//
// Two concrete costs of that, even though react-router's flat routes
// here mean only one of these pages is ever mounted at a time (so this
// was never QUITE as sharp as the DAO app's CardPreview.jsx bug, where
// two instances really were alive on the same page at once):
//   1. Every page visit re-ran the full connect/read-Shield/Council
//      sequence (several RPC calls) that the PREVIOUS page had just
//      finished a moment earlier — pure waste, and a visible extra
//      loading beat on every navigation.
//   2. It's fragile by construction: the "log out needs two clicks"
//      bug (see markIntentionalDisconnect in useLensDAO.js) exists
//      BECAUSE each page's own instance has to independently notice
//      and special-case the wallet's self-fired accountsChanged event
//      — with a single shared instance there is only ever one place
//      that needs to get this right, not up to eight.
//
// The fix mirrors the sibling hrpdao app's own useDao(), which is
// created ONCE in Layout.jsx and shared to every page via
// react-router's useOutletContext(). Dossier's routes aren't nested
// under a shared layout ROUTE the same way (see main.jsx — every
// <Route> here renders a page directly, not through a wrapping
// <Outlet>), so react-router context isn't available the same way.
// A plain React Context achieves the identical result (exactly one
// useLensDAO() call, shared everywhere) without needing to restructure
// the router: LensDaoProvider below wraps the whole app once, in
// main.jsx, right alongside LensAuthProvider/NostrIdentityProvider.
import { createContext, useContext } from "react";
import { useLensDAO } from "../hooks/useLensDAO";

const LensDaoContext = createContext(null);

export function LensDaoProvider({ children }) {
  const dao = useLensDAO();
  return <LensDaoContext.Provider value={dao}>{children}</LensDaoContext.Provider>;
}

/**
 * Replaces every page's own `const dao = useLensDAO();` — same shape,
 * same fields, just backed by the one shared instance instead of a
 * fresh one per page.
 */
export function useLensDaoContext() {
  const ctx = useContext(LensDaoContext);
  if (!ctx) {
    throw new Error(
      "useLensDaoContext() was called outside <LensDaoProvider> — check that main.jsx still wraps the app in it.",
    );
  }
  return ctx;
}
