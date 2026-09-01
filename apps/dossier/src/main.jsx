// main.jsx
import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { walletConnect } from "wagmi/connectors";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import i18n from "./i18n";
// App (the "/" login screen) stays a static import — it's the first
// thing painted (LCP content), so lazy-loading it would only delay it
// behind an extra network round trip for no benefit.
import App from "./App";
import ThemeProvider from "./components/ThemeProvider";
import "./index.css";
import { LensAuthProvider } from "./context/LensAuthContext";
import { NostrIdentityProvider } from "./hooks/useNostrIdentity";

// Everything below "/" is route-based code-split with React.lazy so the
// initial bundle only contains what's needed to render the login screen.
// Previously all ~25 pages (including Leaflet map + XMTP chat, ~725KB of
// code unused on first load per Lighthouse) were bundled eagerly into a
// single ~1MB chunk loaded before first paint.
const CountryPage = lazy(() => import("./pages/CountryPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ProfilePage = lazy(() => import("./pages/ProfilePage"));
const SupportPage = lazy(() => import("./pages/SupportPage"));
const ViolationsPage = lazy(() => import("./pages/ViolationsPage"));
const GovernancePage = lazy(() => import("./pages/GovernancePage"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));
const PostPage = lazy(() => import("./pages/PostPage"));
const ViolationsListPage = lazy(() => import("./pages/ViolationsListPage"));
const ViolationDetailsPage = lazy(() => import("./pages/ViolationDetailsPage"));
const ViolationsMap = lazy(() => import("./pages/ViolationsMap"));
const HelpRequestPage = lazy(() => import("./pages/HelpRequestPage"));
const UserProfilePage = lazy(() => import("./pages/UserProfilePage"));
const SearchPage = lazy(() => import("./pages/SearchPage"));
const TermsOfService = lazy(() => import("./pages/TermsOfService"));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage"));
// ADDED: page behind RightSidebar's "About" footer link (·About·Terms·
// Privacy), which previously pointed at /about with no matching <Route> —
// that page didn't exist at all yet.
const AboutPage = lazy(() => import("./pages/AboutPage"));
const CreateLensAccount = lazy(() => import("./pages/CreateLensAccount"));
const TipTestPage = lazy(() => import("./pages/TipTestPage"));
const FollowingPage = lazy(() => import("./pages/FollowingPage"));
const NostrChatPage = lazy(() => import("./pages/NostrChatPage"));

// Minimal, dependency-free fallback shown for the brief moment a lazy
// route chunk is fetched. Deliberately not the app's Spinner component
// (that lives inside App.jsx / uses i18n) to keep this file's own
// synchronous import graph small.
function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#000d1f]">
      <div className="inline-block w-12 h-12 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
    </div>
  );
}
// Lens Chain (mainnet L2)
const lensChain = {
  id: 232,
  name: "Lens Network Mainnet",
  nativeCurrency: { name: "Grass", symbol: "GHO", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.lens.xyz"] },
  },
  blockExplorers: {
    default: { name: "Lens Explorer", url: "https://explorer.lens.xyz" },
  },
};

// Lens Testnet (for development)
const lensTestnet = {
  id: 37111,
  name: "Lens Network Sepolia Testnet",
  nativeCurrency: { name: "GRASS", symbol: "GRASS", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.lens.dev"] },
  },
  blockExplorers: {
    default: {
      name: "Lens Testnet Explorer",
      url: "https://block-explorer.testnet.lens.dev",
    },
  },
};

// Arbitrum Sepolia — the DAO's contracts (RightsRegistry/ShieldSBT/
// CouncilSBT/DisciplineModule/etc., see hooks/useLensDAO.js) live
// here now, not on Lens Chain. Added so the wallet can be prompted to
// switch networks when signing a DAO write (e.g. escalating a report
// to a sanction proposal in ModerationQueue.jsx) — Lens posting itself
// still happens on Lens Chain via lensChain/lensTestnet below.
const arbitrumSepolia = {
  id: 421614,
  name: "Arbitrum Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC ||
          "https://sepolia-rollup.arbitrum.io/rpc",
      ],
    },
  },
  blockExplorers: {
    default: { name: "Arbiscan Sepolia", url: "https://sepolia.arbiscan.io" },
  },
};

// EMBEDDED WALLET (Privy): PrivyProvider handles the actual signer —
// email/Google/passkey login creates and custodies an embedded EOA
// for the user with no browser extension required, and works
// identically on desktop and mobile (no more injected-vs-mobile
// branching, see LensAuthContext.connectWallet). @privy-io/wagmi's
// WagmiProvider (imported above, NOT the plain one from "wagmi")
// automatically registers/syncs a wagmi connector for whichever
// wallet Privy has active (embedded or externally linked) — we do
// NOT add an injected() connector to the list below anymore.
//
// walletConnect() is kept, deliberately, as a SECONDARY option: some
// users may still prefer to link an existing external wallet instead
// of the embedded one. Privy supports this natively (the login modal
// offers "connect an existing wallet" alongside email/social login),
// so removing MetaMask doesn't have to mean removing wallet choice —
// it just stops being the ONLY path. The projectId comes from
// https://cloud.reown.com (free) and is stored in .env as
// VITE_WALLETCONNECT_PROJECT_ID — a public identifier, not a secret.
const wagmiConfig = createConfig({
  chains: [lensChain, lensTestnet, arbitrumSepolia],
  connectors: [
    walletConnect({
      projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
      showQrModal: true,
      metadata: {
        name: "Dossier from HRP DAO",
        description: "Dossier — a Human Rights Policy Decentralized Autonomous Org.",
        url: typeof window !== "undefined" ? window.location.origin : "",
        icons: [
          typeof window !== "undefined"
            ? `${window.location.origin}/logo.png`
            : "",
        ],
      },
    }),
  ],
  transports: {
    [lensChain.id]: http("https://rpc.lens.xyz"),
    [lensTestnet.id]: http("https://rpc.testnet.lens.dev"),
    [arbitrumSepolia.id]: http(
      import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC ||
        "https://sepolia-rollup.arbitrum.io/rpc",
    ),
  },
});

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")).render(
  // DIAGNOSTIC: React.StrictMode removed (was wrapping everything
  // below). In dev mode, StrictMode intentionally double-invokes
  // effects (mount → cleanup → mount again) specifically to catch
  // impure side effects — and third-party SDKs holding their own
  // imperative state for things like iframe handshakes or wallet
  // sync (exactly what Privy's embedded-wallet flow does) are a
  // common category of libraries that break under this, because the
  // premature "cleanup" from the first mount can tear down state a
  // second mount then depends on. This matches our exact symptom:
  // Privy's OWN side fully succeeds (token, embedded wallet created —
  // confirmed via Network tab and localStorage privy:token/pat), but
  // the sync into wagmi's connection state silently never happens.
  // If removing StrictMode fixes login, this is confirmed as the
  // cause, and we can look at re-enabling it more narrowly later
  // (e.g. wrapping only parts of the tree that don't touch Privy).
  <PrivyProvider
      appId={import.meta.env.VITE_PRIVY_APP_ID}
      config={{
        // Create an embedded wallet automatically for anyone who logs
        // in without already linking an external wallet — this is
        // what replaces "Connect MetaMask" as the default path.
        // FIXED: this was the actual root cause of the whole "Privy
        // authenticates successfully but no embedded wallet ever
        // appears in useWallets()/wagmi" saga. createOnLogin does NOT
        // live directly under embeddedWallets — it must be nested
        // under embeddedWallets.ethereum (confirmed against this
        // exact installed @privy-io/react-auth version's own type
        // definitions). The old shape below wasn't a typo Privy
        // rejected — it's simply an unrecognized key that got
        // silently ignored, so the REAL embeddedWallets.ethereum.
        // createOnLogin quietly defaulted to "off": Google/email/
        // passkey login always succeeded (hence privy:token existing
        // in localStorage every time), but Privy never actually
        // provisioned a wallet to go with that login — so
        // useWallets() stayed permanently empty and nothing ever had
        // anything to sync into wagmi, no matter how the sync side
        // was implemented.
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets",
          },
        },
        loginMethods: ["email", "google", "wallet", "passkey"],
        // MIGRATED to Lens Mainnet: this app's Lens SDK client
        // (lib/lens.js) now runs on `environment: mainnet`, so
        // defaultChain here must point at lensChain (MAINNET, id 232)
        // to match. A mismatch between defaultChain and the SDK
        // environment previously caused "403 Forbidden" from the RPC
        // (the public endpoint for one network rejects unauthenticated
        // browser traffic meant for the other) — defaultChain must
        // always match whichever network the rest of the app (Lens
        // SDK, on-chain writes via handleOperationWith, etc.)
        // actually operates on.
        defaultChain: lensChain,
        // arbitrumSepolia deliberately NOT included here. It's tempting
        // (DAO writes on the Moderation page need Arbitrum Sepolia), but
        // adding a 3rd chain to Privy's OWN supportedChains list made
        // Privy probe/validate the connected wallet against every listed
        // chain on connect — for an external wallet like MetaMask this
        // fired multiple near-simultaneous permission requests, and
        // MetaMask's own "already pending" guard silently dropped some of
        // them. Net effect: getWalletClient() in LensAuthContext.jsx
        // would occasionally return a client stuck on the wrong chain
        // (or briefly none at all), and any Lens write picked at exactly
        // that moment (ReportModal, posting, etc.) failed with "Wallet
        // not connected" — not because Arbitrum Sepolia contracts were
        // broken, but because THIS list caused Lens Chain wallet
        // resolution itself to misfire. Arbitrum Sepolia is still fully
        // usable for DAO writes via wagmi's plain `chains` array below
        // (useLensDAO.js's own ensureChain()/switchChain calls talk to
        // the connector's raw provider directly — they never needed it
        // listed here). If DAO writes ever need Privy to know about this
        // chain specifically, re-add it here, but watch for this same
        // regression on the Lens side.
        supportedChains: [lensTestnet, lensChain],
        appearance: {
          theme: "dark",
          accentColor: "#b41e3c",
          logo: typeof window !== "undefined" ? "/logo.png" : undefined,
        },
      }}
    >
      {/* FIXED: @privy-io/wagmi's WagmiProvider uses react-query
          internally (useMutation/useQueryClient, for wallet reconnect
          — see useReconnect in its source), so it needs
          QueryClientProvider as an ANCESTOR, not a descendant. Having
          it the other way around ("No QueryClient set, use
          QueryClientProvider to set one") throws immediately on
          mount. QueryClientProvider must wrap WagmiProvider. */}
      <QueryClientProvider client={queryClient}>
        {/* FIXED: wagmi's own WagmiProvider defaults reconnectOnMount
            to true — on every page load it tries to silently
            reconnect whatever connector was last active, PERSISTED IN
            localStorage from any previous session (including old
            direct-MetaMask testing from before this embedded-wallet
            migration). This raced against Privy's own wallet sync: a
            fresh Google login would correctly resolve the embedded
            wallet (and fetch its Lens account) for a moment, then
            wagmi's silent MetaMask reconnect would fire and overwrite
            wagmi's active account back to the old MetaMask address —
            "registration looked like it worked, then MetaMask popped
            up and the app opened on the old MetaMask account".
            Privy has its own independent session-restore mechanism
            (its SDK/iframe, unrelated to wagmi's localStorage), so
            wagmi's own reconnect-on-mount is redundant here and
            reconnectOnMount={false} removes the race entirely — the
            only source of truth for "which wallet is active" is now
            Privy. */}
        <WagmiProvider
          config={wagmiConfig}
          reconnectOnMount={false}
          // FIXED: this used to be left unset, which meant
          // @privy-io/wagmi's own internal sync (useSyncPrivyWallets)
          // only *registered* a wagmi connector for each Privy wallet
          // but never activated one for a brand-new login — the app
          // then had to do that itself via a separate effect
          // (previously in LensAuthContext.jsx), racing the library's
          // own async connector setup and intermittently failing with
          // "No wagmi connector found for wallet ...". Passing this
          // selector makes @privy-io/wagmi do BOTH the setup and the
          // activation itself, in one place, for whichever wallet we
          // return here — no second effect needed anywhere else.
          // Preference mirrors what LensAuthContext used to encode:
          // the embedded wallet (created via email/Google/passkey)
          // wins if one exists, otherwise fall back to whichever
          // wallet Privy reports first (e.g. a linked external one).
          setActiveWalletForWagmi={({ wallets }) =>
            wallets.find((w) => w.walletClientType === "privy") ||
            wallets[0]
          }
        >
        <I18nextProvider i18n={i18n}>
          <ThemeProvider>
            <LensAuthProvider>
              <NostrIdentityProvider>
                <BrowserRouter>
                  <Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/" element={<App />} />
                    <Route path="/violations-map" element={<ViolationsMap />} />
                    <Route path="/country" element={<CountryPage />} />
                    <Route path="/support" element={<SupportPage />} />
                    <Route path="/help/:id" element={<HelpRequestPage />} />
                    <Route path="/violations" element={<ViolationsPage />} />
                    <Route path="/governance" element={<GovernancePage />} />
                    <Route path="/profile" element={<ProfilePage />} />
                    <Route
                      path="/notifications"
                      element={<NotificationsPage />}
                    />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/post/:postId" element={<PostPage />} />
                    <Route
                      path="/violations-list"
                      element={<ViolationsListPage />}
                    />
                    <Route
                      path="/violations/:id"
                      element={<ViolationDetailsPage />}
                    />
                    <Route path="/violations-map" element={<ViolationsMap />} />
                    <Route path="/user/:userId" element={<UserProfilePage />} />
                    <Route
                      path="/terms-of-service"
                      element={<TermsOfService />}
                    />
                    <Route path="/privacy-page" element={<PrivacyPage />} />
                    {/* ADDED: RightSidebar's footer (·About·Terms·Privacy)
                        links to /about, /terms, /privacy — none of these
                        matched an existing <Route> (the terms/privacy pages
                        were only reachable at /terms-of-service and
                        /privacy-page above), so all three footer links
                        previously 404'd. Kept as separate routes to the
                        same elements rather than renaming the routes above,
                        so any existing links to /terms-of-service and
                        /privacy-page keep working too. */}
                    <Route path="/about" element={<AboutPage />} />
                    <Route path="/terms" element={<TermsOfService />} />
                    <Route path="/privacy" element={<PrivacyPage />} />
                    <Route path="/search" element={<SearchPage />} />
                    <Route
                      path="/create-lens-account"
                      element={<CreateLensAccount />}
                    />
                    <Route path="/tip-test" element={<TipTestPage />} />
                    <Route
                      path="/following/:userId?"
                      element={<FollowingPage />}
                    />
                    <Route path="/nostr-chat" element={<NostrChatPage />} />
                  </Routes>
                  </Suspense>
                </BrowserRouter>
              </NostrIdentityProvider>
            </LensAuthProvider>
          </ThemeProvider>
        </I18nextProvider>
        </WagmiProvider>
      </QueryClientProvider>
  </PrivyProvider>,
);
