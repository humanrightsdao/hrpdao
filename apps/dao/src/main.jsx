import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { http } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { walletConnect } from "wagmi/connectors";
import { PrivyProvider } from "@privy-io/react-auth";
import { WagmiProvider, createConfig } from "@privy-io/wagmi";
import "./index.css";
import "./i18n";

import Layout from "./components/Layout";
import { NostrIdentityProvider } from "./hooks/useNostrIdentity";
import HomePage from "./pages/HomePage";
import ProposalsPage from "./pages/ProposalsPage";
import ProposalDetailPage from "./pages/ProposalDetailPage";
import NewProposalPage from "./pages/NewProposalPage";
import TreasuryPage from "./pages/TreasuryPage";
import ParamsPage from "./pages/ParamsPage";
import ModerationPage from "./pages/ModerationPage";
import VisitCardPage from "./pages/VisitCardPage";
import CardPublicPage from "./pages/CardPublicPage";
import VerificationPage from "./pages/VerificationPage";
import TokenPage from "./pages/TokenPage";
import LocationPage from "./pages/LocationPage";
import RankingPage from "./pages/RankingPage";
import DocsPage from "./pages/DocsPage";
import ForumPage from "./pages/ForumPage";
import ForumThreadPage from "./pages/ForumThreadPage";

// ── Networks ────────────────────────────────────────────────
// Same set as in hrpdaolens/hrpdaonostr — the DAO site needs to look
// at the same contracts, so the network config must match 1:1. Anvil
// is added separately for local testing (chainId 31337), enabled via
// VITE_USE_LOCAL_CHAIN=true.

const lensTestnet = {
  id: 37111,
  name: "Lens Network Sepolia Testnet",
  nativeCurrency: { name: "GRASS", symbol: "GRASS", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.lens.dev"] } },
  blockExplorers: {
    default: {
      name: "Lens Testnet Explorer",
      url: "https://block-explorer.testnet.lens.dev",
    },
  },
};

const anvilLocal = {
  id: 31337,
  name: "Anvil Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
};

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

// EMBEDDED WALLET (Privy): same setup as dossier/hrpdaonostr — see
// their main.jsx for the full history of why each option here is set
// the way it is (createOnLogin nesting, reconnectOnMount={false},
// QueryClientProvider ordering, etc.). The important part for THIS
// app specifically: VITE_PRIVY_APP_ID must be the SAME value as the
// other two apps' .env.local. Privy derives a user's embedded wallet
// address from (App ID + their login identity — email/Google/passkey),
// not from anything stored in this browser, so using the same App ID
// is what makes logging in with the same email/Google account here
// resolve to the EXACT SAME wallet address as in Dossier — no more
// manually reconnecting "the right wallet" or passing addresses
// through ?wallet= links and hoping they match.
const wagmiConfig = createConfig({
  chains: [anvilLocal, lensTestnet, arbitrumSepolia],
  connectors: [
    walletConnect({
      projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
      showQrModal: true,
      metadata: {
        name: "Rights DAO",
        description:
          "Human Rights Policy Decentralized Autonomous Org — governance registry",
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
    [anvilLocal.id]: http("http://127.0.0.1:8545"),
    [lensTestnet.id]: http("https://rpc.testnet.lens.dev"),
    [arbitrumSepolia.id]: http(
      import.meta.env.VITE_ARBITRUM_SEPOLIA_RPC ||
        "https://sepolia-rollup.arbitrum.io/rpc",
    ),
  },
});

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")).render(
  // React.StrictMode intentionally omitted here — see dossier's
  // main.jsx for why: Privy's embedded-wallet wagmi sync doesn't
  // tolerate StrictMode's dev-only double-invoke of effects (mount →
  // cleanup → mount), which can silently swallow the sync.
  <PrivyProvider
    appId={import.meta.env.VITE_PRIVY_APP_ID}
    config={{
      // Create an embedded wallet automatically for anyone who logs in
      // without already linking an external wallet — this REPLACES
      // "Connect MetaMask" as the default path (see the Connect
      // button in Layout.jsx). createOnLogin must be nested under
      // embeddedWallets.ethereum specifically (see dossier's main.jsx
      // for the exact same gotcha already hit and fixed there).
      embeddedWallets: {
        ethereum: {
          createOnLogin: "users-without-wallets",
        },
      },
      loginMethods: ["email", "google", "wallet", "passkey"],
      defaultChain: arbitrumSepolia,
      supportedChains: [arbitrumSepolia, anvilLocal, lensTestnet],
      appearance: {
        theme: "dark",
        accentColor: "#C9A227", // gold — this app's accent, vs dossier's seal red
        logo: typeof window !== "undefined" ? "/logo.png" : undefined,
      },
    }}
  >
    {/* QueryClientProvider must be an ANCESTOR of @privy-io/wagmi's
        WagmiProvider (it uses react-query internally for wallet
        reconnect) — see dossier's main.jsx for the exact error this
        avoids. */}
    <QueryClientProvider client={queryClient}>
      {/* reconnectOnMount={false}: wagmi's own silent-reconnect (from
          localStorage) races Privy's independent session-restore and
          can overwrite the freshly-synced embedded wallet with a
          stale connector — see dossier's main.jsx for the full story
          ("registration looked like it worked, then the wrong account
          popped back up"). Privy's session is the only source of
          truth for "which wallet is active" now. */}
      <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
        {/* Must be INSIDE WagmiProvider — it needs wagmi's useAccount/
            useWalletClient to know which wallet to derive the Nostr
            key from. Same nesting dossier uses for its own
            NostrIdentityProvider. */}
        <NostrIdentityProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/" element={<Layout />}>
              <Route index element={<HomePage />} />
              <Route path="proposals" element={<ProposalsPage />} />
              <Route path="proposals/new" element={<NewProposalPage />} />
              <Route path="proposals/:id" element={<ProposalDetailPage />} />
              <Route path="treasury" element={<TreasuryPage />} />
              <Route path="params" element={<ParamsPage />} />
              <Route path="moderation" element={<ModerationPage />} />
              <Route path="card" element={<VisitCardPage />} />
              <Route path="verification" element={<VerificationPage />} />
              <Route path="token" element={<TokenPage />} />
              <Route path="location" element={<LocationPage />} />
              <Route path="ranking" element={<RankingPage />} />
              <Route path="docs" element={<DocsPage />} />
              <Route path="forum" element={<ForumPage />} />
              <Route path="forum/:id" element={<ForumThreadPage />} />
            </Route>
            {/* Public page with no sidebar — this is exactly where the
                Business Card's QR code leads, meant to be viewed
                without connecting one's own wallet (offline scenario). */}
            <Route path="/card/:address" element={<CardPublicPage />} />
          </Routes>
        </BrowserRouter>
        </NostrIdentityProvider>
      </WagmiProvider>
    </QueryClientProvider>
  </PrivyProvider>,
);
