import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Globe,
  Vote,
  ShieldAlert,
  Landmark,
  Settings2,
  IdCard,
  Fingerprint,
  Award,
  MapPin,
  Trophy,
  MessagesSquare,
  BookOpen,
  ChevronDown,
  Menu,
  X,
} from "lucide-react";
import { useState, useEffect } from "react";
import { useDisconnect } from "wagmi";
import { usePrivy } from "@privy-io/react-auth";
import { useDao } from "../hooks/useDao";
import { usePrivyWalletSync } from "../hooks/usePrivyWalletSync";
import { useWalletHandoff } from "../hooks/useWalletHandoff";
import { truncAddr } from "../lib/format";
import OnboardingOverlay, { checkOnboardingStatus } from "./OnboardingOverlay";
import LanguageSelector from "./LanguageSelector";
import { SocialLinksRow } from "./SocialIcons";
import AtticusChat from "./AtticusChat";
import logo from "../assets/logo.png";
import atticusIcon from "../assets/atticus.png";

// ── Menu structure ──────────────────────────────────────────
// Flat items, no section, always visible, in order: Home, Business
// Card, Documentation, Forum, Ranking — Forum and Ranking moved right
// under Documentation (previously a separate TRAILING_ITEMS block
// rendered below the collapsed Governance/Community sections, at the
// very bottom of the nav).
// Link to the DAO's linked social app — Dossier. Locally this is a
// different port (5173); in production, set the real domain via
// .env.local.
const DOSSIER_APP_URL = import.meta.env.VITE_DOSSIER_APP_URL || "http://localhost:5173";

// Pass the wallet address in the URL (?wallet=0x...) so the other app
// can immediately recognize the same user without forcing them to
// connect their wallet again. Without an address, it's just a plain link.
function withWallet(baseUrl, address) {
  if (!address) return baseUrl;
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}wallet=${address}`;
}

const FLAT_ITEMS = [
  { to: "/", labelKey: "home", end: true, icon: Globe },
  { to: "/card", labelKey: "card", icon: IdCard },
  { to: "/docs", labelKey: "docs", icon: BookOpen },
  { to: "/forum", labelKey: "forum", icon: MessagesSquare },
  { to: "/ranking", labelKey: "ranking", icon: Trophy },
];

const NAV_GROUPS = [
  {
    id: "governance",
    titleKey: "governance",
    items: [
      { to: "/proposals", labelKey: "proposals", icon: Vote },
      { to: "/moderation", labelKey: "moderation", icon: ShieldAlert },
      { to: "/treasury", labelKey: "treasury", icon: Landmark },
      { to: "/params", labelKey: "params", icon: Settings2 },
    ],
  },
  {
    id: "community",
    titleKey: "community",
    items: [
      { to: "/token", labelKey: "token", icon: Award },
      { to: "/verification", labelKey: "verification", icon: Fingerprint },
      { to: "/location", labelKey: "location", icon: MapPin },
    ],
  },
];

export default function Layout() {
  const { t } = useTranslation();
  const dao = useDao();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [atticusOpen, setAtticusOpen] = useState(false);
  // Collapsed by default for both sections.
  const [collapsed, setCollapsed] = useState({ governance: true, community: true });
  const [hovered, setHovered] = useState(null);
  const toggleGroup = (id) => {
    setCollapsed((c) => ({ ...c, [id]: !c[id] }));
    // A click takes priority over "hover": without this, the section
    // wouldn't visually collapse while the mouse cursor stayed over
    // it (which it always does right after a click).
    setHovered(null);
  };
  const isGroupOpen = (id) => hovered === id || !collapsed[id];

  // ── Login/logout (Privy embedded wallet — same as Dossier) ──────
  // Same login screen/experience as the Dossier app: email, Google,
  // passkey, or an external wallet, via Privy — instead of requiring
  // a browser extension. Logging in with the SAME email/Google
  // account in both apps resolves to the SAME embedded wallet address
  // (Privy derives it from appId + login identity, not from anything
  // stored in this browser), so RIGHTS/Shield/Council membership
  // earned in one app is automatically visible in the other with no
  // extra step. Requires VITE_PRIVY_APP_ID to be the same value in
  // both apps' .env.local.
  const {
    login,
    logout: privyLogout,
    ready: privyReady,
    authenticated,
  } = usePrivy();
  const { disconnect: wagmiDisconnect } = useDisconnect();
  const loggingOutRef = usePrivyWalletSync();

  // ⚠️ FIXED: this used to call login() unconditionally on every click.
  // That's fine the FIRST time, but the button stays on "Connect
  // Wallet"/"Sign In" until dao.isConnected flips true — and that only
  // happens once usePrivyWalletSync has synced Privy's wallet into
  // wagmi AND useDao's silentConnect() has picked it up (see the two
  // effects above). If the user is impatient (or that sync is simply
  // still in flight — e.g. right after a page reload restoring an
  // existing Privy session) and clicks again while ALREADY
  // authenticated with Privy, login() throws "Attempted to log in, but
  // user is already logged in" — Privy refuses to re-open a session
  // that already exists — and nothing else happens, so the click looks
  // like it "does nothing" and the account never actually gets in.
  // Now: only call login() if there's genuinely no Privy session yet.
  // If already authenticated, don't ask Privy to log in again — nudge
  // the sync along instead by re-running silentConnect a few times,
  // giving usePrivyWalletSync's setActiveWallet a moment to land.
  const connectWallet = async () => {
    if (!privyReady) return;
    if (authenticated) {
      for (let i = 0; i < 5 && !dao.isConnected; i++) {
        await new Promise((r) => setTimeout(r, 400));
        await dao.silentConnect();
      }
      if (!dao.isConnected) {
        // Retries genuinely exhausted — confirmed via console: this
        // Privy session is authenticated with ZERO linked wallets
        // (useWallets() stays empty forever, not just briefly during
        // sync). That's a dead session, not a race condition.
        //
        // ⚠️ FIXED: this used to call privyConnectWallet() here —
        // Privy's WALLET-LINKING modal (link an external wallet to an
        // already-authenticated account). That modal only ever offers
        // wallet options by design — it's not the login modal, so
        // email/Google/passkey never appear there. That's exactly why
        // "email/Google/passkey зникли, лишились лише гаманці": it was
        // the wrong modal, not a config problem. Force a clean
        // re-authentication instead — log out of the stuck session,
        // then open the FULL login() modal again, so createOnLogin can
        // do its job and the user gets the complete choice back
        // (email/Google/passkey/wallet).
        try {
          await privyLogout();
        } catch (err) {
          console.warn("⚠️ Privy logout (before re-login) failed:", err);
        }
        try {
          await login();
        } catch (err) {
          console.warn("⚠️ Wallet login cancelled or failed:", err);
        }
      }
      return;
    }
    try {
      await login();
    } catch (err) {
      // Privy rejects/throws if the user closes the modal without
      // completing login — that's a normal cancellation, not a real
      // error, so it only goes to the console.
      console.warn("⚠️ Wallet login cancelled or failed:", err);
    }
  };

  // Same pattern as dossier's GovernancePage.jsx: useDao.js's own
  // silentConnect()-on-mount effect only ever fires ONCE, at the very
  // first render — before Privy's wallet-sync has necessarily
  // resolved. Depending on `dao.silentConnect` itself (a useCallback
  // whose identity changes whenever wagmi's active `connector`
  // changes — i.e. right after Privy syncs a wallet in) re-runs this
  // whenever a wallet actually becomes available, which is what
  // actually initializes contracts/RIGHTS/Shield state after a fresh
  // login click.
  useEffect(() => {
    if (!dao.isConnected && !dao.connecting) {
      dao.silentConnect();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.silentConnect]);

  // Auto-open the login modal for anyone arriving via a "?wallet=..."
  // deep link from Dossier (ModerationQueue's "view in DAO" link,
  // GovernanceRedirect, etc.) — skips the extra click on the Connect
  // button. Privy doesn't support logging in AS a specific address
  // from a URL, so this only opens the modal; the address itself is
  // whatever that Privy login resolves to (the same one, if it's the
  // same login identity).
  useWalletHandoff(dao.isConnected, connectWallet, dao.account);

  const handleDisconnect = async () => {
    // Set BEFORE anything else, for the same reason as in dossier's
    // LensAuthContext.logout(): otherwise the wallet-sync effect can
    // slip in a reconnect before wagmi's disconnect() below has fully
    // taken effect.
    loggingOutRef.current = true;
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
      loggingOutRef.current = false;
    }
  };

  useEffect(() => {
    if (!dao.isConnected || dao.rights === null || !dao.account) return;
    // Already an established member via some other on-chain path
    // (existing Shield/Council SBT, or activity-based rights already
    // above zero) — checked live every time rather than cached, so
    // this exemption doesn't depend on any stored "onboarded" flag at
    // all. No signature/write needed for this branch.
    if (dao.hasShield || dao.hasCouncil || dao.rights > 0) return;

    // Server-side, signature-verified record (worker/index.js +
    // ONBOARDING_KV) — NOT localStorage, survives "Clear site data"
    // and works from any device for the same wallet. See
    // OnboardingOverlay.jsx for the write side.
    let cancelled = false;
    checkOnboardingStatus(dao.account).then((onboarded) => {
      if (cancelled) return;
      if (!onboarded) setShowOnboarding(true);
    });
    return () => {
      cancelled = true;
    };
  }, [dao.isConnected, dao.rights, dao.hasShield, dao.hasCouncil, dao.account]);

  const navLinkClass = ({ isActive }) =>
    `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-body mb-0.5 transition-colors ${
      isActive
        ? "bg-verdigris/15 text-verdigrisBright"
        : "text-parchmentDim hover:text-parchment hover:bg-surface2"
    }`;

  return (
    <div className="min-h-screen flex bg-ink">
      {/* ── Sidebar ──────────────────────────────────────── */}
      <aside
        className={`fixed lg:sticky top-0 h-screen w-72 shrink-0 border-r border-hairline bg-surface z-40 flex flex-col transition-transform lg:translate-x-0 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="h-16 shrink-0 flex items-center justify-between px-5 border-b border-hairline">
          <div className="flex items-center gap-2.5 min-w-0">
            <img
              src={logo}
              alt="Human Rights Policy DAO"
              className="w-9 h-9 object-contain shrink-0"
            />
            <div className="leading-tight min-w-0">
              <div className="font-cinzel text-parchment text-[0.95rem] truncate">
                Human Rights Policy
              </div>
              <div className="font-body text-[11px] text-parchmentDim truncate">
                Decentralized Autonomous Org.
              </div>
            </div>
          </div>
          <button className="lg:hidden text-parchmentDim shrink-0" onClick={() => setMobileOpen(false)}>
            <X size={20} />
          </button>
        </div>

        {dao.isConnected && (dao.hasCouncil || dao.hasShield) && (
          <div className="px-5 py-3 shrink-0 border-b border-hairline flex items-center gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full shrink-0"
              style={{ background: dao.hasCouncil ? "#C9A227" : "#3B7DFF" }}
            />
            <span className={`font-mono text-[12px] ${dao.hasCouncil ? "text-gold" : "text-verdigrisBright"}`}>
              {dao.hasCouncil ? t("dao.common.council") : t("dao.common.shield")}
            </span>
          </div>
        )}

        <nav className="px-3 py-4 overflow-y-auto flex-1 min-h-0">
          {/* Flat items with no section */}
          <div className="mb-5">
            {FLAT_ITEMS.map(({ to, labelKey, end, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                onClick={() => setMobileOpen(false)}
                className={navLinkClass}
              >
                <Icon size={16} strokeWidth={2} />
                {t(`dao.nav.${labelKey}`)}
              </NavLink>
            ))}
          </div>

          {/* Collapsed sections */}
          {NAV_GROUPS.map((group) => {
            const open = isGroupOpen(group.id);
            return (
              <div
                key={group.id}
                className="mb-5"
                onMouseEnter={() => setHovered(group.id)}
                onMouseLeave={() => setHovered(null)}
              >
                <button
                  onClick={() => toggleGroup(group.id)}
                  className="w-full flex items-center justify-between px-3 mb-1.5 group"
                >
                  <span className="font-mono text-[11px] uppercase tracking-widest text-parchmentDim/70 group-hover:text-parchmentDim">
                    {t(`dao.nav.${group.titleKey}`)}
                  </span>
                  <ChevronDown
                    size={13}
                    className={`text-parchmentDim/50 transition-transform ${open ? "" : "-rotate-90"}`}
                  />
                </button>
                {open &&
                  group.items.map(({ to, labelKey, icon: Icon }) => (
                    <NavLink
                      key={to}
                      to={to}
                      onClick={() => setMobileOpen(false)}
                      className={navLinkClass}
                    >
                      <Icon size={16} strokeWidth={2} />
                      {t(`dao.nav.${labelKey}`)}
                    </NavLink>
                  ))}
              </div>
            );
          })}
        </nav>

        <div className="px-5 py-4 shrink-0 border-t border-hairline space-y-2">
          <a
            href={withWallet(DOSSIER_APP_URL, dao.account)}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 font-mono text-[12px] text-parchmentDim hover:text-verdigrisBright transition-colors"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-verdigris shrink-0" />
            Dossier
          </a>
        </div>

        <div className="px-5 py-4 shrink-0 border-t border-hairline">
          <SocialLinksRow size={15} className="flex-wrap gap-x-3 gap-y-2" />
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 bg-black/60 z-30 lg:hidden" onClick={() => setMobileOpen(false)} />
      )}

      {/* ── Main content ─────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 border-b border-hairline sticky top-0 z-20 bg-ink/90 backdrop-blur flex items-center justify-between px-5 sm:px-8">
          <button className="lg:hidden text-parchmentDim" onClick={() => setMobileOpen(true)}>
            <Menu size={22} />
          </button>

          <div className="hidden lg:flex items-center gap-2">
            <a
              href={withWallet(DOSSIER_APP_URL, dao.account)}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 font-mono text-xs px-3 py-1.5 border border-hairline rounded-full text-parchmentDim hover:border-verdigris hover:text-verdigrisBright transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-verdigris shrink-0" />
              Dossier
            </a>
          </div>

          <div className="flex items-center gap-2">
            <LanguageSelector compact />

            {dao.isConnected ? (
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs px-3.5 py-2 border border-hairline rounded-full text-parchment">
                  {truncAddr(dao.account)}
                </span>
                <button
                  onClick={handleDisconnect}
                  className="font-mono text-xs px-3 py-2 border border-hairline rounded-full text-parchmentDim hover:border-seal hover:text-sealBright transition-colors"
                  title={t("dao.common.disconnect")}
                >
                  {t("dao.common.disconnect")}
                </button>
              </div>
            ) : (
              <button
                onClick={connectWallet}
                disabled={dao.connecting || !privyReady}
                className="font-body text-sm px-4 py-2 bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium rounded-full hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {dao.connecting ? t("dao.common.connecting") : t("dao.common.connectWallet")}
              </button>
            )}
          </div>
        </header>

        {dao.error && dao.error !== "Please connect your wallet first" && (
          <div className="bg-seal/10 border-b border-seal/40 text-sealBright text-xs font-mono px-5 py-2 text-center">
            {dao.error}
          </div>
        )}

        <main className="flex-1 px-5 sm:px-8 py-8 max-w-6xl w-full mx-auto">
          <Outlet context={dao} />
        </main>

        <footer className="border-t border-hairline">
          <div className="max-w-6xl mx-auto px-5 sm:px-8 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <span className="text-[12px] font-mono text-parchmentDim">
              {t("dao.common.brandLine")}
            </span>
            <SocialLinksRow size={16} />
          </div>
        </footer>
      </div>

      {showOnboarding && (
        <OnboardingOverlay account={dao.account} onDone={() => setShowOnboarding(false)} />
      )}

      {!atticusOpen && (
        <button
          onClick={() => setAtticusOpen(true)}
          className="fixed bottom-24 right-6 z-40 w-14 h-14 rounded-full overflow-hidden shadow-2xl ring-2 ring-verdigris/40 hover:ring-verdigrisBright transition-all hover:scale-105"
          title={t("dao.atticus.triggerTitle")}
        >
          <img src={atticusIcon} alt="Atticus" className="w-full h-full object-cover" />
        </button>
      )}

      <AtticusChat open={atticusOpen} onClose={() => setAtticusOpen(false)} />
    </div>
  );
}
