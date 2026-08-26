// src/pages/GovernancePage.jsx
//
// ⚠️ MIGRATED — this page used to host the FULL DAO governance UI
// (token/proposals/propose/params tabs, on Lens Chain Sepolia) plus
// moderation and geo settings. Full governance now lives exclusively
// in the separate DAO app on Arbitrum Sepolia (see the "Full DAO
// governance →" link below, and GovernanceRedirect.jsx for the same
// handoff pattern in reverse). components/governance/ProposalsSection.jsx
// and ActionsSection.jsx — which implemented that old, now-superseded
// UI against the old contracts — have been deleted.
//
// What's left here, and why it stays local instead of also moving to
// the DAO app: report moderation (ModerationQueue) needs direct access
// to Lens posts/comments, which only this app has. Geo settings
// (location declaration, epoch ranking) used to live here too, as a
// second tab — REMOVED: the DAO app already has its own Location and
// Ranking pages reading the same LocationRegistry/CouncilRankingEpoch
// contracts, so keeping a duplicate here just meant two UIs that could
// drift out of sync for no reason. Moderation still reads/writes
// through useLensDAO.js, which now points at the NEW contracts on
// Arbitrum Sepolia (see that file's header for details).

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import Layout from "../components/Layout";
import { useLensAuth } from "../context/LensAuthContext";
import { useNavigate } from "react-router-dom";
import CreatePostModal from "../components/CreatePostModal";
import useUserInfo from "../hooks/useUserInfo";
import { useLensDAO } from "../hooks/useLensDAO";
import { useTipJar } from "../hooks/useTipJar";
import useLensPosts from "../hooks/useLensPosts";
import ModerationQueue from "../components/ModerationQueue";

// Full DAO governance (token/proposals/propose/params) now lives
// exclusively in the separate DAO app — see GovernanceRedirect.jsx for
// the same handoff pattern used when the whole page used to redirect.
// This page keeps only what genuinely belongs here: report moderation
// (needs Lens post access, which only this app has) and geo settings.
const DAO_APP_URL = import.meta.env.VITE_DAO_APP_URL || "http://localhost:5175";

// ─────────────────────────────────────────────────────────────
//  Shared UI kit (used by this file and both Section files)
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
//  Small helper components
// ─────────────────────────────────────────────────────────────

// The same helper used in Navbar.jsx - the on-chain policyURI is stored
// as "ipfs://<CID>" (protocol), convert it into a clickable https gateway link.
function ipfsUriToLink(ipfsUri) {
  if (!ipfsUri || !ipfsUri.startsWith("ipfs://")) return ipfsUri || null;
  const cid = ipfsUri.replace("ipfs://", "");
  return `https://${cid}.ipfs.inbrowser.link/`;
}

function PolicyReacceptBanner({ dao }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");

  const handleAccept = async () => {
    setLoading(true);
    setError("");
    const res = await dao.reacceptPolicy((msg) => setProgress(msg));
    setLoading(false);
    if (!res.success) setError(res.error || t("governance_error_generic"));
  };

  return (
    <div className="bg-amber-500/[0.08] border border-amber-300 dark:border-amber-500/25 rounded-xl px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div>
        <p className="text-[14px] font-medium text-amber-500 dark:text-amber-400/90">
          {t("governance_policy_updated")}
        </p>
        <p className="text-[12px] text-amber-600/70 dark:text-amber-400/50 mt-0.5">
          {t("governance_policy_updated_note")}
          {dao.shieldInfo?.policyURI && (
            <>
              {" "}
              <a
                href={ipfsUriToLink(dao.shieldInfo.policyURI)}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-amber-500"
              >
                {t("governance_read_new_version")}
              </a>
            </>
          )}
        </p>
        {error && <p className="text-[12px] text-red-400 mt-1">{error}</p>}
        {progress && !error && (
          <p className="text-[12px] text-amber-500/70 mt-1">{progress}</p>
        )}
      </div>
      <button
        onClick={handleAccept}
        disabled={loading}
        className="px-4 py-2 rounded-lg text-[13px] font-medium whitespace-nowrap
          bg-amber-500/15 border border-amber-300 dark:border-amber-500/30 text-amber-600 dark:text-amber-400
          hover:bg-amber-500/25 transition-colors disabled:opacity-50"
      >
        {loading ? t("governance_accepting") : t("governance_accept_new_version")}
      </button>
    </div>
  );
}

function AccessBadge({ hasShield, hasCouncil, rights, isRestricted }) {
  const { t } = useTranslation();
  if (isRestricted)
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1
        bg-red-500/10 border border-red-300 dark:border-red-500/25 text-red-700 dark:text-red-400/85
        text-[11px] font-medium rounded-[6px]"
      >
        {t("governance_voting_suspended")}
      </span>
    );
  if (hasCouncil)
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1
        bg-amber-500/10 border border-amber-300 dark:border-amber-500/25 text-amber-700 dark:text-amber-400/85
        text-[11px] font-medium rounded-[6px]"
      >
        {t("governance_badge_council")}
      </span>
    );
  if (hasShield)
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1
        bg-purple-500/10 border border-purple-300 dark:border-purple-500/25 text-purple-700 dark:text-purple-400/85
        text-[11px] font-medium rounded-[6px]"
      >
        {t("governance_badge_shield")}
      </span>
    );
  if ((rights ?? 0) > 0)
    return (
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1
        bg-indigo-500/10 border border-indigo-300 dark:border-indigo-500/25 text-indigo-700 dark:text-indigo-400/80
        text-[11px] font-medium rounded-[6px]"
      >
        {t("governance_badge_rights", { rights })}
      </span>
    );
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2.5 py-1
      bg-slate-100 dark:bg-white/[0.05] border border-slate-300 dark:border-white/[0.1] text-slate-600 dark:text-white/35
      text-[11px] rounded-[6px]"
    >
      {t("governance_new_member")}
    </span>
  );
}

export function Spinner() {
  return (
    <span
      className="w-5 h-5 border-2 border-blue-300 dark:border-blue-500/50
      border-t-blue-400 rounded-full animate-spin"
    />
  );
}

// ─────────────────────────────────────────────────────────────
//  Main page
// ─────────────────────────────────────────────────────────────

const GovernancePage = () => {
  const { t } = useTranslation();
  const { userInfo, loading: userLoading, error: userError } = useUserInfo();
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);
  const navigate = useNavigate();

  const dao = useLensDAO();
  const tipJar = useTipJar();
  // sessionClient is needed for createLensComment() below (publishing a
  // system link-comment post↔proposal from ModerationQueue.jsx), and
  // logout is used to FIX handleLogout below, which used to call
  // supabase.auth.signOut() — the app has long since moved to a
  // Lens-native session (LensAuthContext); Supabase Auth never had an
  // active session here, so that call effectively did nothing.
  // FIXED: missing getWalletClient — see ViolationsListPage.jsx/
  // SupportPage.jsx for the identical bug. This one is more
  // consequential than it looks: createLensComment from here is what
  // ModerationQueue.jsx uses for EVERY moderation action (blur/hide/
  // ban votes AND the escalation-link comment), not just reports —
  // all of it was failing with "Wallet not connected" unconditionally.
  const {
    sessionClient,
    getWalletClient,
    logout: lensLogout,
    // walletConnected: the ONE wagmi-level connection state, set by
    // Privy on the login screen (App.jsx). This page is only reachable
    // by an already-authenticated user (see the redirect effect below),
    // so by the time we get here the wallet is already connected —
    // there's nothing left for the user to "connect" on this page.
    isConnected: walletConnected,
  } = useLensAuth();
  const { createLensComment, createLensPost } = useLensPosts(sessionClient, getWalletClient);

  // REMOVED: the standalone "Підключити MetaMask" button + its own
  // handleConnect(). It was a leftover, page-specific connect flow
  // sitting next to the app's single Privy login (App.jsx) — a second
  // "connect" entry point users could hit on every visit/reload of
  // this page before the wallet-sync effect in LensAuthContext.jsx
  // finished, which is what looked like "the app asks to connect
  // MetaMask again". There is only ONE connection now (Privy, done on
  // the login screen); this page just links its own read/write DAO
  // contracts (Arbitrum Sepolia) to that already-active wallet
  // automatically, the moment it becomes available — no button, no
  // separate MetaMask-branded prompt.
  const [daoConnectAttempted, setDaoConnectAttempted] = useState(false);

  useEffect(() => {
    if (!walletConnected) {
      // Wallet not active yet (Privy session still restoring) — reset
      // so we retry as soon as it becomes available, instead of
      // permanently giving up after one failed attempt.
      setDaoConnectAttempted(false);
      return;
    }
    if (dao.isConnected || dao.connecting || daoConnectAttempted) return;
    setDaoConnectAttempted(true);
    // dao.connect() reuses the already-active Privy/wagmi wallet (no
    // extra login prompt) and switches to Arbitrum Sepolia for DAO
    // writes — the same thing the old button used to do, just
    // triggered automatically instead of waiting for a click.
    dao.connect().then((result) => {
      if (result?.success && result?.signer) {
        tipJar.initTipJar(result.signer);
      }
    });
  }, [walletConnected, dao.isConnected, dao.connecting, daoConnectAttempted]);

  useEffect(() => {
    if (!userLoading && !userInfo) {
      navigate("/");
      return;
    }
    if (!userLoading && userInfo && !userInfo.hasCompletedOnboarding) {
      navigate("/create-lens-account");
      return;
    }
  }, [userInfo, userLoading, navigate]);

  // Sanction cases (DisciplineModule) are loaded once, on connect —
  // ModerationQueue itself only needs dao.proposeSanction/
  // canProposeSanction/checkTargetMembership, not the full list, but
  // warming dao.sanctionProposals here means an "already escalated"
  // lookup never has to wait on a fresh RPC scan.
  useEffect(() => {
    if (dao.isConnected && dao.sanctionProposals.length === 0) {
      dao.loadSanctionProposals();
    }
  }, [dao.isConnected]);

  const handleLogout = async () => {
    try {
      // Changed: this used to be supabase.auth.signOut() - the app logs
      // in via Lens (LensAuthContext), not Supabase Auth, so that call
      // never actually logged anyone out. lensLogout() calls
      // sessionClient.logout() and clears the session in the context's
      // React state.
      await lensLogout();
      // Without this, stale lens_wallet_address/lens_account_address
      // would remain in localStorage after logging out - on the next
      // login with a different wallet, useLensProfile.js could pick up
      // someone else's "active account" from the previous session (see
      // the comments in useLensProfile.js about the savedAccountAddr
      // check).
      localStorage.removeItem("lens_wallet_address");
      localStorage.removeItem("lens_account_address");
      navigate("/");
    } catch (error) {
      console.error(t("logout_error"), error);
      alert(t("logout_failed"));
    }
  };

  // Adaptive theme
  const headingCls = "text-slate-900 dark:text-white/65";
  const bodyCls = "text-slate-700 dark:text-white/25";

  return (
    <Layout
      userProfile={userInfo}
      onLogout={handleLogout}
      loading={userLoading}
      error={userError}
      onCreatePost={() => setShowCreatePostModal(true)}
    >
      {showCreatePostModal && (
        <CreatePostModal
          onClose={() => setShowCreatePostModal(false)}
          userCountry={userInfo?.country || "EARTH"}
        />
      )}

      <div className="h-full flex flex-col pt-4 pb-4 px-0 lg:p-4 gap-4">
        <div
          className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-slate-300 dark:border-white/[0.06]`}
        >
          <div>
            <h1
              className={`font-cinzel text-[19px] font-medium ${headingCls} tracking-[0.04em]`}
            >
              {t("governance_page_title")}
            </h1>
            <a
              href={dao.account ? `${DAO_APP_URL}?wallet=${dao.account}` : DAO_APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[12px] text-blue-600 dark:text-blue-400/80 hover:underline inline-flex items-center gap-1 mt-0.5"
            >
              {t("governance_full_dao_link")}
            </a>
          </div>

          {dao.isConnected ? (
            <div className="flex flex-wrap items-center gap-2">
              <AccessBadge
                hasShield={dao.hasShield}
                hasCouncil={dao.hasCouncil}
                rights={dao.rights}
                isRestricted={dao.isRestricted}
              />
              <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/[0.07] border border-emerald-300 dark:border-emerald-500/20 rounded-lg text-[14px]">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-mono text-emerald-700 dark:text-emerald-400/80">
                  {dao.account.slice(0, 6)}...{dao.account.slice(-4)}
                </span>
                {dao.votingPower > 0 && (
                  <span className="text-emerald-700 dark:text-emerald-400/55">
                    {t("governance_vp_suffix", { vp: dao.votingPower })}
                  </span>
                )}
              </div>
            </div>
          ) : (
            dao.connecting && (
              <div className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-slate-500 dark:text-white/30">
                <span className="w-3.5 h-3.5 border-2 border-slate-400/40 dark:border-white/20 border-t-transparent rounded-full animate-spin" />
                {t("governance_connecting")}
              </div>
            )
          )}
        </div>

        {dao.isConnected &&
          dao.hasShield &&
          dao.shieldInfo?.hasAcceptedPolicy === false && (
            <PolicyReacceptBanner dao={dao} />
          )}

        {dao.error && (
          <div className="bg-red-500/[0.07] border border-red-300 dark:border-red-500/22 rounded-xl px-4 py-3 text-[16px] text-red-700 dark:text-red-400/75 flex items-center gap-2">
            <span>✗</span> {dao.error}
          </div>
        )}

        {/* No standalone "please connect" screen anymore — the wallet
            is already connected via Privy (App.jsx) by the time this
            page is reachable at all. While dao.connect() links that
            wallet to the DAO contracts (Arbitrum Sepolia), just show a
            lightweight loading state instead of blocking the page
            behind a MetaMask-specific prompt. */}
        {!dao.isConnected && (dao.connecting || !walletConnected) && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 py-16">
            <span className="w-8 h-8 border-2 border-slate-400/40 dark:border-white/20 border-t-transparent rounded-full animate-spin" />
            <p className={`text-[14px] ${bodyCls}`}>
              {t("governance_connecting")}
            </p>
          </div>
        )}

        {dao.isConnected && (
          <>
            {dao.roleWarnings?.length > 0 && (
              <div className="bg-red-500/[0.08] border border-red-300 dark:border-red-500/30 rounded-xl px-4 py-3 mb-3">
                <p className="text-[16px] font-semibold text-red-700 dark:text-red-400/90 mb-1">
                  {t("governance_contract_config_issue")}
                </p>
                {dao.roleWarnings.map((w) => (
                  <p
                    key={w.id}
                    className="text-[14px] text-red-700 dark:text-red-400/70 leading-relaxed"
                  >
                    {w.text}
                  </p>
                ))}
              </div>
            )}
            <div className="flex-1 overflow-y-auto">
              <div className="space-y-3">
                <h2 className="text-[15px] font-semibold text-slate-700 dark:text-white/80">
                  {t("moderation_panel")}
                </h2>
                <ModerationQueue
                  dao={dao}
                  createLensComment={createLensComment}
                  createLensPost={createLensPost}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
};

export default GovernancePage;
