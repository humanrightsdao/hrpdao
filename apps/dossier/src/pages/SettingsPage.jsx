// src/pages/SettingsPage.jsx
import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import LanguageSelector from "../components/LanguageSelector";
import { useLensAuth } from "../context/LensAuthContext";
import Layout from "../components/Layout";
import CreatePostModal from "../components/CreatePostModal";
import useUserInfo from "../hooks/useUserInfo";
import { useNostrIdentity } from "../hooks/useNostrIdentity";
import { useNostrRelay } from "../hooks/useNostrRelay";
import { collectUserExportData } from "../utils/exportUserData";
import {
  LogOut,
  Moon,
  Download,
  RefreshCw,
  Copy,
  Check,
  Trash2,
  AlertTriangle,
} from "lucide-react";

// REMOVED: deleteSupabaseUserData() and the entire challenge-signature +
// Edge Function delete-account mechanism. This was removed NOT because
// the protection was bad (quite the opposite — the crypto signature
// verification was the right approach), but because after migrating
// country_ratings to Lens (see COUNTRY_RATINGS_LENS_MIGRATION.md) there
// simply is NO personal data left in Supabase that needs deleting. No
// data — nothing for this separate mechanism to protect. All
// deactivation is now 100% Lens operations (steps 1-2 below) + local
// cleanup (step 3).

export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const { userInfo, loading: userInfoLoading, loadUserInfo } = useUserInfo();
  const {
    logout: lensLogout,
    anonymizeAccountMetadata,
    sessionClient,
  } = useLensAuth();

  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const savedTheme = localStorage.getItem("theme");
    if (savedTheme) return savedTheme === "dark";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  const [showCreatePostModal, setShowCreatePostModal] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);
  const {
    nostrIdentity,
    deriving: nostrDeriving,
    error: nostrError,
    deriveNostrIdentity,
    signEvent: signNostrEvent,
    linkNostrIdentityToLensAccount,
    linking: nostrLinking,
    linkError: nostrLinkError,
  } = useNostrIdentity();
  const { publishToNostr } = useNostrRelay();
  const [testPublishing, setTestPublishing] = useState(false);
  const [testPublishResults, setTestPublishResults] = useState(null);

  const handlePublishTestNote = async () => {
    setTestPublishing(true);
    setTestPublishResults(null);
    try {
      const event = await signNostrEvent({
        kind: 1,
        content:
          "Testing my synchronized Nostr identity from Dossier (HRP DAO) 🔗",
      });
      if (!event) throw new Error("Could not sign event.");
      const results = await publishToNostr(event);
      setTestPublishResults(results);
    } catch (err) {
      console.error("⚠️ Test publish failed:", err);
      setTestPublishResults([{ url: "—", ok: false, reason: err.message }]);
    } finally {
      setTestPublishing(false);
    }
  };
  const [npubCopied, setNpubCopied] = useState(false);

  // ── Data export ────────────────────────────────────────────────────────
  // Profile and settings are always exported (this is local state, no
  // network requests). The remaining categories are optional: each one
  // means a separate request(s) to Lens, so the user picks exactly what
  // they need instead of pulling everything at once.
  const [exportCategories, setExportCategories] = useState({
    posts: true,
    comments: true,
    helpRequests: true,
    violations: true,
    following: true,
    reactions: true,
  });
  const [exportLoading, setExportLoading] = useState(false);
  const [exportProgress, setExportProgress] = useState("");
  const [exportError, setExportError] = useState("");
  // The category list is hidden until the user clicks "Export Data"
  // themselves — the same way showResetConfirm below hides the reset
  // confirmation until the corresponding button is clicked.
  const [showExportOptions, setShowExportOptions] = useState(false);

  const toggleExportCategory = (key) => {
    setExportCategories((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // ── Account deletion ───────────────────────────────────────────────────
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deletingAccount, setDeletingAccount] = useState(false);
  const [deleteStep, setDeleteStep] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const DELETE_CONFIRM_WORD = "DELETE";

  useEffect(() => {
    if (userInfoLoading) return;

    if (!userInfo) {
      navigate("/");
      return;
    }

    if (!userInfo.hasCompletedOnboarding) {
      navigate("/create-lens-account");
      return;
    }

    setUserProfile({
      id: userInfo.id,
      unique_name: userInfo.uniqueName,
      country: userInfo.country,
      avatar_url: userInfo.avatarUrl,
      wallet_address: userInfo.walletAddress,
      has_completed_onboarding: userInfo.hasCompletedOnboarding,
      authMethod: userInfo.authMethod,
    });

    const lensAddr = localStorage.getItem("lens_wallet_address");
    const web3Addr = localStorage.getItem("web3_wallet_address");
    setWalletAddress(lensAddr || web3Addr || userInfo.walletAddress || "");

    setLoading(false);
  }, [userInfo, userInfoLoading, navigate]);

  useEffect(() => {
    const savedTheme = localStorage.getItem("theme");
    if (
      savedTheme === "dark" ||
      (!savedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ) {
      document.documentElement.classList.add("dark");
      setIsDarkMode(true);
    }
  }, []);

  const toggleDarkMode = () => {
    const newDarkMode = !isDarkMode;
    setIsDarkMode(newDarkMode);
    localStorage.setItem("theme", newDarkMode ? "dark" : "light");
    if (newDarkMode) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  };

  const handleLogout = async () => {
    try {
      try {
        await lensLogout();
      } catch (lensError) {
        console.error("Lens logout error", lensError);
      }

      localStorage.removeItem("lens_wallet_address");
      localStorage.removeItem("web3_wallet_address");
      localStorage.removeItem("web3_signature");
      localStorage.removeItem("web3_message");
      navigate("/");
    } catch (error) {
      console.error(t("logout_error"), error);
      alert(t("logout_failed"));
    }
  };

  // ── Account deactivation ─────────────────────────────────────────────────
  // IMPORTANT: it's impossible to fully delete a Lens account — it's a
  // smart contract on the blockchain, it will stay there forever (see the
  // Privacy Policy, "Blockchain Data" section). "Deactivation" here means
  // ONLY Lens and local steps, no external backend anymore:
  //   1) anonymize the profile's public metadata on Lens (name/bio/avatar)
  //      — this is ONLY POSSIBLE while the session is still active, so it
  //      runs BEFORE logout;
  //   2) disconnect the app from the Lens account (revoke the session);
  //   3) clear the app's local data on this device.
  //
  // The user's country rating (a Lens post tagged country_rating, see
  // COUNTRY_RATINGS_LENS_MIGRATION.md) is NOT deleted here as a separate
  // step — it stays on the blockchain the same way the rest of the Lens
  // content does (posts, comments), and this is consistently described in
  // the Privacy Policy, "Blockchain Data" section. Anyone who wants to
  // remove specifically the rating can do so on the profile page
  // (deletePost) before deactivating — technically the same as with any
  // of their own posts.
  const handleDeleteAccount = async () => {
    if (deleteConfirmInput.trim().toUpperCase() !== DELETE_CONFIRM_WORD) {
      setDeleteError(
        t("delete_account_confirm_mismatch", { word: DELETE_CONFIRM_WORD }) ||
          `Enter the word "${DELETE_CONFIRM_WORD}" to confirm`,
      );
      return;
    }

    setDeletingAccount(true);
    setDeleteError("");

    try {
      // 1) Anonymize the Lens profile metadata while the session is still alive.
      setDeleteStep(t("delete_account_step_lens_metadata"));
      const metadataResult = await anonymizeAccountMetadata();
      if (!metadataResult.success) {
        // Don't block the process — the account still needs to be disconnected.
        console.error(
          "⚠️ Lens metadata anonymization error during deletion:",
          metadataResult.error,
        );
      }

      // 2) Disconnect the app from the Lens account (revoke the session).
      setDeleteStep(t("delete_account_step_lens_session"));
      try {
        await lensLogout();
      } catch (lensError) {
        console.error(
          "⚠️ Lens logout error during account deletion:",
          lensError,
        );
      }

      // 3) Clear the app's local data.
      setDeleteStep(t("delete_account_step_local"));
      localStorage.removeItem("lens_wallet_address");
      localStorage.removeItem("web3_wallet_address");
      localStorage.removeItem("web3_signature");
      localStorage.removeItem("web3_message");
      localStorage.removeItem("lens_account_address");
      Object.keys(localStorage)
        .filter((k) => k.startsWith("lens_reaction_"))
        .forEach((k) => localStorage.removeItem(k));

      setShowDeleteConfirm(false);
      navigate("/");
    } catch (error) {
      console.error("❌ Error deactivating account:", error);
      setDeleteError(
        (t("delete_account_failed") || "Failed to deactivate account") +
          ": " +
          error.message,
      );
    } finally {
      setDeletingAccount(false);
      setDeleteStep("");
    }
  };

  const handleResetSettings = () => {
    setShowResetConfirm(true);
  };

  const confirmResetSettings = () => {
    localStorage.removeItem("theme");
    setIsDarkMode(window.matchMedia("(prefers-color-scheme: dark)").matches);

    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }

    setShowResetConfirm(false);
  };

  const handleExportData = async () => {
    if (exportLoading) return;

    setExportLoading(true);
    setExportError("");
    setExportProgress(t("export_preparing") || "Preparing export...");

    try {
      // Optional Lens categories (posts/comments/help requests/
      // complaints/following/reactions) — only the ones the user has
      // left enabled. Profile and settings don't need to be loaded,
      // they're already local in state.
      const lensData = await collectUserExportData({
        sessionClient,
        accountAddress: userInfo?.lensAccountAddress || null,
        categories: exportCategories,
        onProgress: setExportProgress,
      });

      const userData = {
        exportVersion: "1.1",
        exportedAt: new Date().toISOString(),
        profile: userProfile,
        preferences: {
          language: i18n.language,
          darkMode: isDarkMode,
          lastUpdated: new Date().toISOString(),
        },
        ...lensData,
      };

      const dataStr = JSON.stringify(userData, null, 2);
      const dataBlob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(dataBlob);

      const link = document.createElement("a");
      link.href = url;
      link.download = `user-settings-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setExportSuccess(true);
      setShowExportOptions(false);
      setTimeout(() => setExportSuccess(false), 3000);
    } catch (error) {
      console.error("Export data error:", error);
      setExportError(t("export_data_failed") || "Failed to export data");
      // The panel is NOT collapsed on error — the user sees the message
      // and can retry right away, without having to expand the list again.
    } finally {
      setExportLoading(false);
      setExportProgress("");
    }
  };

  const handleCopyAddress = async () => {
    if (!userInfo?.lensAccountAddress) return;
    try {
      await navigator.clipboard.writeText(userInfo.lensAccountAddress);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 2000);
    } catch (err) {
      console.error("Copy address error", err);
    }
  };

  const handleCopyNpub = async () => {
    if (!nostrIdentity?.npub) return;
    try {
      await navigator.clipboard.writeText(nostrIdentity.npub);
      setNpubCopied(true);
      setTimeout(() => setNpubCopied(false), 2000);
    } catch (err) {
      console.error("Copy npub error", err);
    }
  };

  if (loading || userInfoLoading) {
    return (
      <Layout
        userProfile={userProfile}
        walletAddress={walletAddress}
        onLogout={handleLogout}
        loading={true}
        error={error}
        onCreatePost={() => setShowCreatePostModal(true)}
        compactMode={true}
      >
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin" />
        </div>
      </Layout>
    );
  }

  // ─── Design tokens ───────────────────────────────────────────────────────────
  // 3 font sizes only: 16px body · 14px mono/meta · 11px label
  // Light theme: contrast raised to WCAG AA (slate-400/500 → slate-500/600/700).
  // Dark theme — unchanged, it's fine there.
  const cardBg = "bg-white dark:bg-[#000d1f]";
  const cardBorder = "border border-slate-300 dark:border-white/[0.07]";
  const subText = "text-slate-600 dark:text-white/45";
  const bodyText = "text-slate-900 dark:text-white/60";
  const rowBg =
    "bg-slate-100 dark:bg-white/[0.02] hover:bg-slate-200 dark:hover:bg-white/[0.04]";
  const rowBorder =
    "border border-slate-300 dark:border-white/[0.07] hover:border-slate-400 dark:hover:border-white/[0.12]";
  const chevron =
    "text-slate-500 dark:text-white/45 group-hover:text-slate-700 dark:group-hover:text-white/60";
  // A quiet, web3-style label — but still readable on a white background
  const sectionLabel =
    "text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40";

  return (
    <Layout
      userProfile={userProfile}
      walletAddress={walletAddress}
      onLogout={handleLogout}
      loading={loading}
      error={error}
      onCreatePost={() => setShowCreatePostModal(true)}
      compactMode={true}
    >
      {showCreatePostModal && (
        <CreatePostModal
          onClose={() => setShowCreatePostModal(false)}
          userCountry={userInfo?.country || "EARTH"}
        />
      )}

      <div className="max-w-4xl mx-auto px-0 lg:px-2">
        {/* Page title */}
        <div className="mb-6 pb-4 border-b border-slate-300 dark:border-white/[0.06]">
          <h1 className="font-cinzel text-[19px] font-medium text-slate-950 dark:text-white/85 tracking-[0.04em]">
            {t("menu_settings")}
          </h1>
        </div>

        {/* ── General settings: language, theme, export, Lens — one area ──── */}
        <div
          className={`${cardBg} ${cardBorder} rounded-xl overflow-hidden mb-4`}
        >
          <div className="p-3 sm:p-4 space-y-4">
            {/* Language */}
            <div>
              <p className={`${sectionLabel} mb-2 px-1`}>
                {t("language_settings")}
              </p>
              <LanguageSelector
                compact={true}
                buttonClassName="w-full flex items-center justify-between gap-3 rounded-lg border border-slate-300 dark:border-white/[0.1] bg-slate-100 dark:bg-white/[0.03] text-slate-900 dark:text-white/65 text-[16px] px-4 py-3 hover:bg-slate-100 dark:hover:bg-white/[0.06] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all duration-300"
                listClassName="rounded-lg border border-slate-200 dark:border-white/[0.08] bg-white dark:bg-[#000d1f] text-[16px] shadow-2xl"
              />
            </div>

            <div className="border-t border-slate-200 dark:border-white/[0.06]" />

            {/* Theme */}
            <div>
              <p className={`${sectionLabel} mb-2 px-1`}>
                {t("theme_settings") || "Theme"}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => !isDarkMode && toggleDarkMode()}
                  className={`h-11 rounded-lg border text-[16px] flex items-center justify-center gap-2 transition-all ${
                    isDarkMode
                      ? "bg-[#8B1A2A] border-[#8B1A2A]/25 text-white/95 shadow-[0_0_0_2px_rgba(139,26,42,0.15)] dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:shadow-[0_0_0_2px_rgba(43,0,10,0.15)]"
                      : "bg-slate-100 border-slate-300 text-slate-600 hover:border-slate-400 hover:text-slate-800"
                  }`}
                >
                  <Moon className="w-4 h-4" />
                  {t("dark") || "Dark"}
                </button>

                <button
                  onClick={() => isDarkMode && toggleDarkMode()}
                  className={`h-11 rounded-lg border text-[16px] flex items-center justify-center gap-2 transition-all ${
                    !isDarkMode
                      ? "bg-[#8B1A2A] border-[#8B1A2A]/25 text-white/95 shadow-[0_0_0_2px_rgba(139,26,42,0.15)] dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:shadow-[0_0_0_2px_rgba(43,0,10,0.15)]"
                      : "bg-white/[0.04] border-white/[0.07] text-white/45 hover:border-white/[0.12]"
                  }`}
                >
                  <svg
                    className="w-4 h-4"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <circle cx="12" cy="12" r="5" />
                    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                  </svg>
                  {t("light") || "Light"}
                </button>
              </div>
            </div>

            <div className="border-t border-slate-200 dark:border-white/[0.06]" />

            {/* Export Data + Reset Settings */}
            <div>
              <p className={`${sectionLabel} mb-2 px-1`}>
                {t("data_settings") || "Data"}
              </p>
              {/* The "Export Data" button only expands/collapses the
                  category list below — it doesn't trigger the action
                  itself. This is the same accordion pattern as "Reset
                  Settings" below (showResetConfirm): clicking the row ->
                  panel appears -> an explicit confirm button in the panel
                  triggers the action. */}
              <button
                onClick={() => {
                  if (exportLoading) return;
                  setExportError("");
                  setShowExportOptions((prev) => !prev);
                }}
                disabled={exportLoading}
                aria-expanded={showExportOptions}
                className={`w-full flex items-center justify-between px-3 py-3 rounded-xl ${rowBorder} ${rowBg} transition-all text-left group disabled:opacity-60 disabled:cursor-not-allowed`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-[32px] h-[32px] rounded-lg flex items-center justify-center bg-emerald-100 dark:bg-emerald-900/20 border border-emerald-300/40 dark:border-emerald-700/15 flex-shrink-0">
                    {exportLoading ? (
                      <div className="w-3.5 h-3.5 rounded-full border-2 border-emerald-600/30 border-t-emerald-600 dark:border-emerald-400/30 dark:border-t-emerald-400 animate-spin" />
                    ) : (
                      <Download className="w-4 h-4 text-emerald-600 dark:text-emerald-400/60" />
                    )}
                  </div>
                  <p className={`text-[16px] font-medium ${bodyText}`}>
                    {exportLoading
                      ? exportProgress || t("exporting") || "Exporting..."
                      : t("export_data")}
                  </p>
                </div>
                {!exportLoading && (
                  <svg
                    className={`w-4 h-4 ${chevron} transition-transform flex-shrink-0 ${
                      showExportOptions ? "rotate-90" : ""
                    }`}
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                )}
              </button>

              {showExportOptions && (
                <div className="px-1 py-2">
                  <p className={`text-[14px] ${subText} mb-2.5`}>
                    {t("export_choose_categories") ||
                      "Choose which data to include in the export:"}
                  </p>

                  {/* Profile and settings — always included (local
                      state, no network requests), so no checkbox. */}
                  <div className="flex flex-col gap-1.5 mb-3">
                    <p
                      className={`flex items-center gap-1.5 text-[14px] ${subText}`}
                    >
                      <svg
                        className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400/70 flex-shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                      {t("export_cat_profile") || "Profile and settings"}
                    </p>

                    {[
                      { key: "posts", label: t("export_cat_posts") || "Posts" },
                      {
                        key: "comments",
                        label: t("export_cat_comments") || "Comments",
                      },
                      {
                        key: "helpRequests",
                        label:
                          t("export_cat_help_requests") ||
                          "Help requests",
                      },
                      {
                        key: "violations",
                        label:
                          t("export_cat_violations") || "Violation reports",
                      },
                      {
                        key: "following",
                        label: t("export_cat_following") || "Following",
                      },
                      {
                        key: "reactions",
                        label: t("export_cat_reactions") || "Reactions",
                      },
                    ].map(({ key, label }) => (
                      <label
                        key={key}
                        className={`flex items-center gap-2 text-[14px] ${bodyText} cursor-pointer select-none`}
                      >
                        <input
                          type="checkbox"
                          checked={exportCategories[key]}
                          onChange={() => toggleExportCategory(key)}
                          disabled={exportLoading}
                          className="w-3.5 h-3.5 rounded accent-emerald-600"
                        />
                        {label}
                      </label>
                    ))}
                  </div>

                  {exportError && (
                    <div className="flex items-center gap-2 p-3 mb-3 bg-red-50 dark:bg-red-900/15 border border-red-200 dark:border-red-700/25 rounded-lg">
                      <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400/70 flex-shrink-0" />
                      <p className="text-[14px] text-red-800 dark:text-red-400/80">
                        {exportError}
                      </p>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={handleExportData}
                      disabled={exportLoading}
                      className="flex-1 py-2.5 text-[16px] bg-emerald-700 border border-emerald-700/25 text-white/95 rounded-lg hover:bg-emerald-800 dark:bg-emerald-900/40 dark:border-emerald-700/40 dark:text-white/85 dark:hover:bg-emerald-900/60 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {exportLoading
                        ? exportProgress || t("exporting") || "Exporting..."
                        : t("confirm_export") || "Export"}
                    </button>
                    <button
                      onClick={() => setShowExportOptions(false)}
                      disabled={exportLoading}
                      className="flex-1 py-2.5 text-[16px] bg-slate-100 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.08] text-slate-800 dark:text-white/35 rounded-lg hover:bg-slate-200 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {t("cancel") || "Cancel"}
                    </button>
                  </div>
                </div>
              )}

              {exportSuccess && (
                <div className="flex items-center gap-2 p-3 mt-2 bg-emerald-50 dark:bg-emerald-900/15 border border-emerald-200 dark:border-emerald-700/25 rounded-lg">
                  <svg
                    className="w-4 h-4 text-emerald-600 dark:text-emerald-400/70 flex-shrink-0"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <p className="text-[16px] text-emerald-800 dark:text-emerald-400/75">
                    {t("settings_export_success")}
                  </p>
                </div>
              )}

              {/* Reset Settings — right under Export Data */}
              <button
                onClick={handleResetSettings}
                className={`w-full flex items-center justify-between px-3 py-3 rounded-xl ${rowBorder} ${rowBg} transition-all text-left group mt-2`}
              >
                <div className="flex items-center gap-3">
                  <div className="w-[32px] h-[32px] rounded-lg flex items-center justify-center bg-orange-100 dark:bg-orange-900/15 border border-orange-300/40 dark:border-orange-700/15 flex-shrink-0">
                    <RefreshCw className="w-4 h-4 text-orange-600 dark:text-orange-400/60" />
                  </div>
                  <p className={`text-[16px] font-medium ${bodyText}`}>
                    {t("reset_settings")}
                  </p>
                </div>
                <svg
                  className={`w-4 h-4 ${chevron} transition-colors flex-shrink-0`}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>

              {showResetConfirm && (
                <div className="px-1 py-2">
                  <p className="text-[16px] text-orange-700 dark:text-orange-400/80 mb-3">
                    {t("settings_reset_confirm")}
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={confirmResetSettings}
                      className="flex-1 py-2.5 text-[16px] bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 rounded-lg hover:bg-[#9B2232] dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:hover:bg-[#3d0012] transition-colors"
                    >
                      {t("confirm") || "Confirm"}
                    </button>
                    <button
                      onClick={() => setShowResetConfirm(false)}
                      className="flex-1 py-2.5 text-[16px] bg-slate-100 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.08] text-slate-800 dark:text-white/35 rounded-lg hover:bg-slate-200 dark:hover:bg-white/[0.06] transition-colors"
                    >
                      {t("cancel") || "Cancel"}
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Lens Account */}
            {userInfo?.lensAccountAddress && (
              <>
                <div className="border-t border-slate-200 dark:border-white/[0.06]" />
                <div className="flex items-start justify-between gap-3 px-3 py-3 bg-slate-100 dark:bg-white/[0.02] border border-slate-300 dark:border-white/[0.06] rounded-xl">
                  <div className="min-w-0">
                    <p
                      className={`text-[11px] uppercase tracking-[0.1em] font-medium ${subText} mb-1.5`}
                    >
                      {t("lens_account") || "Lens Account"}
                    </p>
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className="text-[14px] font-mono text-blue-700 dark:text-blue-400/60 break-all leading-relaxed">
                        {userInfo.lensAccountAddress}
                      </p>
                      <button
                        onClick={handleCopyAddress}
                        title={t("copy") || "Copy"}
                        className="flex-shrink-0 p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-white/[0.08] transition-colors"
                      >
                        {addressCopied ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400/70" />
                        ) : (
                          <Copy className="w-3.5 h-3.5 text-slate-500 dark:text-white/40" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* Nostr Identity — deterministically derived from the same
                wallet as the Lens account above (see useNostrIdentity.js);
                shown here mainly to verify the derivation works end-to-end
                before building the actual cross-posting/chat features on
                top of it. */}
            <div className="border-t border-slate-200 dark:border-white/[0.06]" />
            <div className="flex items-start justify-between gap-3 px-3 py-3 bg-slate-100 dark:bg-white/[0.02] border border-slate-300 dark:border-white/[0.06] rounded-xl">
              <div className="min-w-0 flex-1">
                <p
                  className={`text-[11px] uppercase tracking-[0.1em] font-medium ${subText} mb-1.5`}
                >
                  {t("nostr_identity") || "Nostr Identity"}
                </p>
                {nostrIdentity ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <p className="text-[14px] font-mono text-purple-700 dark:text-purple-400/60 break-all leading-relaxed">
                        {nostrIdentity.npub}
                      </p>
                      <button
                        onClick={handleCopyNpub}
                        title={t("copy") || "Copy"}
                        className="flex-shrink-0 p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-white/[0.08] transition-colors"
                      >
                        {npubCopied ? (
                          <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400/70" />
                        ) : (
                          <Copy className="w-3.5 h-3.5 text-slate-500 dark:text-white/40" />
                        )}
                      </button>
                    </div>
                    {/* CHANGED: the manual "Link to my Lens account"
                        button is gone — most people had no idea what
                        it did or why they'd need to press it. Linking
                        now happens automatically in the background
                        (see the auto-link effect in
                        useNostrIdentity.jsx) the moment the user logs
                        in. This is now a passive status line instead
                        of an action button; a retry button only shows
                        up if the automatic attempt actually failed. */}
                    {nostrLinking ? (
                      <p className="text-[12px] text-purple-700/70 dark:text-purple-300/60 flex items-center gap-1.5">
                        <span className="inline-block w-2.5 h-2.5 rounded-full border border-purple-500/50 border-t-transparent animate-spin" />
                        {t("syncing_with_lens") || "Syncing with Lens…"}
                      </p>
                    ) : userInfo?.nostrNpub === nostrIdentity.npub ? (
                      <p className="text-[12px] text-emerald-600 dark:text-emerald-400/70 flex items-center gap-1">
                        <Check className="w-3.5 h-3.5" />
                        {t("synced_with_lens") || "Synced with your Lens account"}
                      </p>
                    ) : nostrLinkError ? (
                      <div className="space-y-1.5">
                        <p className="text-[12px] text-red-600 dark:text-red-400/70">
                          {nostrLinkError}
                        </p>
                        <button
                          onClick={async () => {
                            const ok = await linkNostrIdentityToLensAccount({
                              name: userInfo?.name,
                              bio: userInfo?.bio,
                              picture: userInfo?.avatarUrl,
                            });
                            if (ok) await loadUserInfo(true);
                          }}
                          disabled={nostrLinking}
                          className="text-[13px] px-3 py-1.5 rounded-lg bg-purple-600/10 dark:bg-purple-400/10 text-purple-700 dark:text-purple-300 border border-purple-600/20 dark:border-purple-400/20 hover:bg-purple-600/15 dark:hover:bg-purple-400/15 transition-colors disabled:opacity-50"
                        >
                          {t("retry") || "Retry"}
                        </button>
                      </div>
                    ) : null}

                    {/* TEST: end-to-end check that identity → signing →
                        relay publish actually works, before building
                        the real cross-posting UI on top of this. */}
                    <button
                      onClick={handlePublishTestNote}
                      disabled={testPublishing}
                      className="text-[13px] px-3 py-1.5 rounded-lg bg-slate-600/10 dark:bg-white/[0.06] text-slate-700 dark:text-white/70 border border-slate-600/20 dark:border-white/[0.1] hover:bg-slate-600/15 dark:hover:bg-white/[0.1] transition-colors disabled:opacity-50 block"
                    >
                      {testPublishing
                        ? t("publishing") || "Publishing…"
                        : t("publish_test_note") || "Publish test note"}
                    </button>
                    {testPublishResults && (
                      <div className="text-[12px] space-y-0.5">
                        {testPublishResults.map((r, i) => (
                          <p
                            key={i}
                            className={
                              r.ok
                                ? "text-emerald-600 dark:text-emerald-400/70"
                                : "text-red-600 dark:text-red-400/70"
                            }
                          >
                            {r.ok ? "✅" : "❌"} {r.url}
                            {r.reason ? ` — ${r.reason}` : ""}
                          </p>
                        ))}
                      </div>
                    )}
                    {/* REMOVED: "Open Nostr Chat" button — chat is
                        already reachable from the main navbar/sidebar
                        on every page, so a second entry point here in
                        Settings was redundant clutter. */}
                  </div>
                ) : nostrError ? (
                  // Auto-derivation failed (e.g. an external wallet's
                  // signature prompt was dismissed). This is the one
                  // case a manual action still makes sense — silently
                  // never trying again would leave the user
                  // permanently stuck with no Nostr features.
                  <div className="space-y-1.5">
                    <p className="text-[12px] text-red-600 dark:text-red-400/70">
                      {nostrError}
                    </p>
                    <button
                      onClick={deriveNostrIdentity}
                      disabled={nostrDeriving}
                      className="text-[13px] px-3 py-1.5 rounded-lg bg-purple-600/10 dark:bg-purple-400/10 text-purple-700 dark:text-purple-300 border border-purple-600/20 dark:border-purple-400/20 hover:bg-purple-600/15 dark:hover:bg-purple-400/15 transition-colors disabled:opacity-50"
                    >
                      {nostrDeriving
                        ? t("deriving") || "Setting up…"
                        : t("retry") || "Retry"}
                    </button>
                  </div>
                ) : (
                  // CHANGED: this used to be a "Show my Nostr identity"
                  // button the user had to press to kick off
                  // derivation. Since useNostrIdentity.jsx now derives
                  // (and links) automatically in the background the
                  // moment the user is logged in, this branch only
                  // matters for the brief window before that finishes
                  // — so it's now a passive status line instead of a
                  // second confusing purple button that looked almost
                  // identical to the (already-removed) "Link" one.
                  <p className="text-[13px] text-slate-500 dark:text-white/40 flex items-center gap-1.5">
                    {nostrDeriving && (
                      <span className="inline-block w-2.5 h-2.5 rounded-full border border-purple-500/50 border-t-transparent animate-spin" />
                    )}
                    {nostrDeriving
                      ? t("deriving") || "Setting up…"
                      : t("preparing_nostr_identity") || "Setting up…"}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Logout ───────────────────────────────────────────────────────────── */}
        <div
          className={`${cardBg} border border-red-200/60 dark:border-red-900/25 rounded-xl overflow-hidden`}
        >
          <div className="p-3">
            <button
              onClick={handleLogout}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-[16px] font-medium transition-all
                bg-slate-100 border border-slate-300 text-slate-800 hover:bg-[#8B1A2A] hover:border-[#8B1A2A]/25 hover:text-white/95
                dark:bg-white/[0.03] dark:border-white/[0.08] dark:text-white/70 dark:hover:bg-[#2B000A] dark:hover:border-[#2B000A]/50 dark:hover:text-white/85"
            >
              <LogOut className="w-4 h-4" />
              {t("logout")}
            </button>
          </div>
        </div>

        {/* ── Danger Zone: Account deletion ──────────────────────────────────── */}
        <div
          className={`${cardBg} border border-red-300/60 dark:border-red-900/30 rounded-xl overflow-hidden mt-4`}
        >
          <div className="p-3 sm:p-4">
            <p
              className={`${sectionLabel} mb-2 px-1 text-red-500 dark:text-red-400/60`}
            >
              {t("danger_zone") || "Danger zone"}
            </p>

            {!showDeleteConfirm ? (
              <button
                onClick={() => {
                  setShowDeleteConfirm(true);
                  setDeleteConfirmInput("");
                  setDeleteError("");
                }}
                className="w-full flex items-center justify-between px-3 py-3 rounded-xl border border-red-300/50 dark:border-red-900/30 bg-red-50 dark:bg-red-900/10 hover:bg-red-100 dark:hover:bg-red-900/15 transition-all text-left group"
              >
                <div className="flex items-center gap-3">
                  <div className="w-[32px] h-[32px] rounded-lg flex items-center justify-center bg-red-100 dark:bg-red-900/20 border border-red-300/50 dark:border-red-700/25 flex-shrink-0">
                    <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400/70" />
                  </div>
                  <p className="text-[16px] font-medium text-red-700 dark:text-red-400/80">
                    {t("delete_account") || "Delete account"}
                  </p>
                </div>
              </button>
            ) : (
              <div className="px-1 py-2 space-y-3">
                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-900/25 rounded-lg">
                  <AlertTriangle className="w-4 h-4 text-red-600 dark:text-red-400/70 flex-shrink-0 mt-0.5" />
                  <p className="text-[14px] text-red-800 dark:text-red-400/80 leading-relaxed">
                    {t("delete_account_warning") ||
                      "This will disconnect the app from your Lens account, delete public profile data, and remove local access. This action cannot be undone. Note: the blockchain account itself on Lens Protocol cannot be physically deleted."}
                  </p>
                </div>

                <div>
                  <p className={`${subText} text-[14px] mb-1.5`}>
                    {t("delete_account_type_to_confirm", {
                      word: DELETE_CONFIRM_WORD,
                    }) || `Enter "${DELETE_CONFIRM_WORD}" to confirm`}
                  </p>
                  <input
                    type="text"
                    value={deleteConfirmInput}
                    onChange={(e) => setDeleteConfirmInput(e.target.value)}
                    placeholder={DELETE_CONFIRM_WORD}
                    autoFocus
                    className="w-full px-3 py-2.5 text-[16px] rounded-lg border border-red-300 dark:border-red-900/40
                      bg-white dark:bg-white/[0.03] text-slate-800 dark:text-white/70
                      placeholder-slate-300 dark:placeholder-white/[0.16]
                      focus:outline-none focus:ring-2 focus:ring-red-400/40 focus:border-red-400 transition-all"
                  />
                </div>

                {deleteError && (
                  <p className="text-[14px] text-red-600 dark:text-red-400/80">
                    {deleteError}
                  </p>
                )}

                <div className="flex gap-2">
                  <button
                    onClick={handleDeleteAccount}
                    disabled={
                      deletingAccount ||
                      deleteConfirmInput.trim().toUpperCase() !==
                        DELETE_CONFIRM_WORD
                    }
                    className="flex-1 py-2.5 text-[16px] font-medium bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95
                      rounded-lg hover:bg-[#9B2232] dark:bg-red-900/40 dark:border-red-800/50 dark:text-red-100
                      dark:hover:bg-red-900/55 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {deletingAccount
                      ? deleteStep || t("deleting") || "Deactivating..."
                      : t("confirm_delete_account") || "Deactivate account"}
                  </button>
                  <button
                    onClick={() => {
                      setShowDeleteConfirm(false);
                      setDeleteConfirmInput("");
                      setDeleteError("");
                    }}
                    disabled={deletingAccount}
                    className="flex-1 py-2.5 text-[16px] bg-slate-100 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.08]
                      text-slate-800 dark:text-white/35 rounded-lg hover:bg-slate-200 dark:hover:bg-white/[0.06] transition-colors disabled:opacity-40"
                  >
                    {t("cancel") || "Cancel"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
