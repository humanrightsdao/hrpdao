// src/pages/HelpRequestPage.jsx
// ✅ Fully migrated to Lens Protocol (canary v3)
// Removed: supabase, EditHelpRequestModal, payment details (bank, PayPal, crypto)
// Kept: description, help types, media, author wallet address, deletion via Lens

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Share2,
  Copy,
  Check,
  Globe,
  Calendar,
  FileText,
  Image as ImageIcon,
  Play,
  File,
  AlertCircle,
  Heart,
  Pill,
  Home,
  BookOpen,
  Briefcase,
  Scale,
  Utensils,
  Shirt,
  Brain,
  HandHeart,
  Trash2,
  Flag,
  Eye,
  EyeOff,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import { useDisconnect } from "wagmi";
import Layout from "../components/Layout";
import useUserInfo from "../hooks/useUserInfo";
import { useLensHelpRequests } from "../hooks/useLensHelpRequests";
import { useLensProfile } from "../hooks/useLensProfile";
// NOTE: comments + reports — the same flow as on PostPage.jsx.
// useLensComments() — a generic hook (fetchPostReferences/
// createLensComment/reactions), CommentsSection — presentational UI,
// ReportModal — the same report/DAO-sanction modal used on posts
// (a help request here is also a regular Lens Post, so lens_post_id
// works the same way).
import { useLensAuth } from "../context/LensAuthContext";
import { useLensDAO } from "../hooks/useLensDAO";
import useLensComments from "../hooks/useLensComments";
import CommentsSection from "../components/CommentsSection";
// NOTE: without this, moderation actions (blur/hide/critical-hide) only
// counted inside ModerationQueue.jsx — the request page itself had no
// effect, even though the action had been published successfully. No
// separate hook/component files — all the accounting and UI live right
// here.
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";
import { fetchAllReportComments } from "../utils/postReports";
import { checkPostRateLimit } from "../utils/postRateLimit";
import ReportModal from "../components/ReportModal";
import { useCountry } from "../hooks/useCountry";
// NOTE: the "Create post" button in the Sidebar only renders if the
// onCreatePost prop is passed to Layout — same as on
// ComplaintDetailsPage.jsx. Previously this page never passed that
// prop, so the sidebar button was missing.
import CreatePostModal from "../components/CreatePostModal";

// ─── Component ────────────────────────────────────────────────────────────────

const HelpRequestPage = () => {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const { disconnect } = useDisconnect();
  // CHANGED (embedded wallet): getWalletClient (the function) and
  // address (the connected EOA address, for identity checks like
  // myAccountAddress below) now come from useLensAuth() — see the
  // same change in PostPage.jsx for the full reasoning.
  const { sessionClient, getWalletClient, address: connectedAddress } =
    useLensAuth();
  // The wallet address logged into Lens (the same convention used in
  // CountryFeed.jsx/SupportPage.jsx/PostPage.jsx).
  const lensWalletAddress = localStorage.getItem("lens_wallet_address");
  const { profile: lensProfile } = useLensProfile(lensWalletAddress);

  const { userInfo, loading: userInfoLoading } = useUserInfo();
  const { fetchRequestById, deleteRequest } = useLensHelpRequests();
  // sessionClient is needed both for comments (useLensComments) and for
  // reports (ReportModal); dao is the same Shield/Senate SBT check used
  // on CountryFeed.jsx/PostPage.jsx.
  const dao = useLensDAO();
  const { getTranslatedCountryName } = useCountry(i18n.language);

  const [userProfile, setUserProfile] = useState(null);
  const [request, setRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copiedKey, setCopiedKey] = useState(null);
  const [shareToast, setShareToast] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Separate states for reporting the request itself vs. reporting a
  // comment on it (the same reportModalPost/reportModalComment pattern
  // used on PostPage.jsx).
  const [reportModalPost, setReportModalPost] = useState(null);
  const [reportModalComment, setReportModalComment] = useState(null);
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);

  // Help types (badge shape — rounded-full, matching the severity badge
  // on ComplaintDetailsPage)
  const helpTypes = [
    {
      id: "financial",
      icon: Heart,
      cls: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400/85",
    },
    {
      id: "psychological",
      icon: Brain,
      cls: "bg-purple-500/10 border-purple-500/20 text-purple-400/85",
    },
    {
      id: "physical",
      icon: HandHeart,
      cls: "bg-blue-500/10 border-blue-500/20 text-blue-400/85",
    },
    {
      id: "medical",
      icon: Pill,
      cls: "bg-red-500/10 border-red-500/20 text-red-400/85",
    },
    {
      id: "educational",
      icon: BookOpen,
      cls: "bg-indigo-500/10 border-indigo-500/20 text-indigo-400/85",
    },
    {
      id: "housing",
      icon: Home,
      cls: "bg-amber-500/10 border-amber-500/20 text-amber-400/85",
    },
    {
      id: "food",
      icon: Utensils,
      cls: "bg-orange-500/10 border-orange-500/20 text-orange-400/85",
    },
    {
      id: "clothing",
      icon: Shirt,
      cls: "bg-pink-500/10 border-pink-500/20 text-pink-400/85",
    },
    {
      id: "legal",
      icon: Scale,
      cls: "bg-slate-100 dark:bg-white/[0.06] border-white/[0.1] text-slate-600 dark:text-white/40",
    },
    {
      id: "employment",
      icon: Briefcase,
      cls: "bg-cyan-500/10 border-cyan-500/20 text-cyan-400/85",
    },
  ];

  // ── Effects ──────────────────────────────────────────────────────────────────

  // Normalize userProfile from useUserInfo
  useEffect(() => {
    if (userInfoLoading) return;
    if (!userInfo) return;
    setUserProfile({
      id: userInfo.id,
      unique_name: userInfo.uniqueName,
      country: userInfo.country,
      avatar_url: userInfo.avatarUrl,
      authMethod: "lens",
    });
  }, [userInfo, userInfoLoading]);

  // Load the post from Lens by ID
  useEffect(() => {
    if (!id) return;
    loadRequest();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadRequest = async () => {
    setLoading(true);
    setError("");
    const result = await fetchRequestById(id);
    if (result.success) {
      setRequest(result.request);
    } else {
      setError(
        result.error || t("failed_to_load_request") || "Failed to load request",
      );
    }
    setLoading(false);
  };

  // ── Comments ─────────────────────────────────────────────────────────────────
  // NOTE: request.lens_post_id only appears once loading has finished;
  // before that the hook simply does nothing (loadComments bails out on
  // its own if lensPostId is falsy).
  const {
    comments,
    postingComment,
    postComment,
    deleteComment,
    reactToComment,
    isCommentOwner,
    createLensComment,
  } = useLensComments(
    request?.lens_post_id,
    sessionClient,
    lensProfile,
    getWalletClient,
    connectedAddress,
  );

  // A wrapper around postComment with a shared publish rate limit
  // (1/min, 10/hr, 20/day). myAccountAddress is declared below (the
  // Lens Account address, the same one used for isOwner) - the function
  // just CLOSES OVER that variable and is called later (on user click),
  // so by call time the variable is already guaranteed to be initialized.
  const postCommentWithLimit = async (text, mediaFiles) => {
    const rateCheck = await checkPostRateLimit(myAccountAddress, text);
    if (!rateCheck.allowed) {
      alert(rateCheck.reason);
      return;
    }
    return postComment(text, mediaFiles);
  };

  const [modState, setModState] = useState({
    blurred: false,
    hidden: false,
    hiddenReason: null,
    criticalDeadline: null,
    criticalConfirmed: false,
  });
  const [contentRevealed, setContentRevealed] = useState(false);
  // Author ban check — this page previously only checked hide/blur on
  // the post itself, not whether the author's account was banned (the
  // same fix already applied on SupportPage.jsx/ViolationsListPage.jsx).
  const [banState, setBanState] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!request?.lens_post_id) return;
    (async () => {
      try {
        const [actions, reportsList, supply] = await Promise.all([
          fetchAllModActions(),
          fetchAllReportComments(),
          fetchShieldTotalSupply(),
        ]);
        if (!cancelled) {
          setModState(
            computeModerationState(actions, request.lens_post_id, {
              reports: reportsList,
            }),
          );
          if (request.author?.owner_address) {
            setBanState(
              computeBanState(actions, request.author.owner_address, supply),
            );
          }
        }
      } catch (err) {
        console.warn("⚠️ Could not load moderation state:", err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request?.lens_post_id]);

  const getCountryDisplayName = (countryCode) => {
    if (!countryCode || countryCode === "EARTH") {
      return t("earth") || "Planet Earth";
    }
    return getTranslatedCountryName(countryCode) || countryCode;
  };

  // ── Actions ──────────────────────────────────────────────────────────────────

  const handleLogout = () => {
    localStorage.removeItem("lens_wallet_address");
    disconnect();
    navigate("/");
  };

  const handleDelete = async () => {
    // First click — show the confirm block
    if (!deleteConfirm) {
      setDeleteConfirm(true);
      return;
    }

    setDeleting(true);
    try {
      await deleteRequest(id);
      navigate("/support");
    } catch (err) {
      console.error("[HelpRequestPage] delete:", err);
      setDeleting(false);
      setDeleteConfirm(false);
      setError(t("delete_failed") || "Deletion error");
    }
  };

  // Changed: this used to be an alert placeholder ("Lens has no native
  // reports"). Now it's the same flow as PostPage.jsx/CountryFeed.jsx —
  // ReportModal (a structured Lens comment with the report + an
  // on-chain sanction proposal right away for Shield/Senate holders).
  const handleReport = async () => {
    if (!dao.account) {
      const res = await dao.connect();
      if (!res?.success) {
        alert(
          t("wallet_connect_required") ||
            "You need to connect a wallet to file a report.",
        );
        return;
      }
    }
    setReportModalPost(request);
  };

  // NOTE: reporting a comment — the same ReportModal, given a
  // "post-like" object built from the comment.
  const handleReportComment = async (comment) => {
    if (!dao.account) {
      const res = await dao.connect();
      if (!res?.success) {
        alert(
          t("wallet_connect_required") ||
            "You need to connect a wallet to file a report.",
        );
        return;
      }
    }
    setReportModalComment(comment);
  };

  const copyToClipboard = (text, key) => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopiedKey(key);
        setTimeout(() => setCopiedKey(null), 2000);
      })
      .catch(console.error);
  };

  // Changed: navigator.share()/clipboard.writeText() used to be called
  // without error handling — cancelling the system share dialog
  // (AbortError) or being denied clipboard access went uncaught, so the
  // button appeared "broken". Now both paths have a catch.
  const shareRequest = () => {
    const shareData = {
      title: t("help_request") || "Help request",
      text: request?.description?.slice(0, 100) ?? "",
      url: `${window.location.origin}/help/${id}`,
    };

    const copyLink = () =>
      navigator.clipboard
        .writeText(shareData.url)
        .then(() => {
          setShareToast(true);
          setTimeout(() => setShareToast(false), 2500);
        })
        .catch((err) => {
          console.error("Copy link error:", err);
          setError(t("share_failed") || "Failed to share the link");
        });

    if (navigator.share) {
      navigator.share(shareData).catch((err) => {
        // The user closed the system dialog themselves — not an error.
        if (err?.name === "AbortError") return;
        copyLink();
      });
    } else {
      copyLink();
    }
  };

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const getCountryName = (code) => {
    if (!code || code === "EARTH") return "";
    try {
      return (
        new Intl.DisplayNames([i18n.language || "uk"], { type: "region" }).of(
          code,
        ) || code
      );
    } catch {
      return code;
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return "";
    const d = new Date(dateString);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // Determine media type from the URI (lens:// or https://)
  const getMediaType = (uri) => {
    const lower = uri.toLowerCase();
    if (/\.(jpg|jpeg|png|gif|webp)/.test(lower)) return "image";
    if (/\.(mp4|webm|mov|avi)/.test(lower)) return "video";
    if (/\.pdf/.test(lower)) return "pdf";
    return "file";
  };

  const getFileIcon = (uri) => {
    const type = getMediaType(uri);
    if (type === "pdf") return <FileText className="w-5 h-5 text-red-400/55" />;
    if (type === "image")
      return <ImageIcon className="w-5 h-5 text-blue-400/55" />;
    return <File className="w-5 h-5 text-slate-500 dark:text-white/30" />;
  };

  // Convert lens:// → https:// for display
  const resolveUri = (uri) => {
    if (!uri) return "";
    if (uri.startsWith("lens://")) {
      return `https://api.grove.storage/${uri.replace("lens://", "")}`;
    }
    return uri;
  };

  // ── Author helpers (same as CountryFeed) ───────────────────────────────────

  const getAuthorName = (fallback = t("anonymous")) =>
    request?.author?.name || request?.author?.unique_name || fallback;

  const getAuthorHandle = () => {
    const uname = request?.author?.unique_name || null;
    return uname ? `@${uname}` : null;
  };

  const getAuthorAvatar = () => request?.author?.avatar_url || null;

  // NOTE: the author's wallet address. In this component author.id is
  // specifically the wallet address (see the "Author wallet address"
  // block below), request.lens_user_id is the same identifier used as
  // a fallback.
  const getAuthorWalletAddress = () =>
    request?.author?.id || request?.lens_user_id || null;

  const getAvatarUrl = (avatarUrl) => {
    if (!avatarUrl) return null;
    return resolveUri(avatarUrl);
  };

  // ── Loading / Error screens ───────────────────────────────────────────────────

  if (loading) {
    return (
      <Layout
        userProfile={userProfile}
        onLogout={handleLogout}
        loading={loading}
        error={error}
        onCreatePost={() => setShowCreatePostModal(true)}
      >
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin" />
        </div>
      </Layout>
    );
  }

  if (error || !request) {
    return (
      <Layout
        userProfile={userProfile}
        onLogout={handleLogout}
        loading={false}
        error={error}
        onCreatePost={() => setShowCreatePostModal(true)}
      >
        <div className="min-h-screen flex items-center justify-center p-4">
          <div className="text-center">
            <AlertCircle className="w-10 h-10 text-red-300 dark:text-red-400/40 mx-auto mb-3" />
            <p className="text-[16px] text-red-600 dark:text-red-400/65 mb-4">
              {error || t("request_not_found")}
            </p>
            <button
              onClick={() => navigate("/support")}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-[16px] bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35 dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/75 dark:hover:bg-[#3d0012] rounded-lg transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {t("back_to_requests") || "Back to requests"}
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  // Fixed (2): the previous fix took myWalletAddress from EOA sources
  // (walletClient.account.address / lensProfile.address /
  // lens_wallet_address) — but request.author.id / request.lens_user_id
  // (= post.author.address in useLensHelpRequests.js) is the Lens
  // ACCOUNT address (smart contract), which in Lens v2/v3 DIFFERS from
  // the owner's EOA wallet. That's why the "Delete" button was
  // disappearing. LensAuthContext.loginWithAccount() stores the correct
  // address separately — localStorage.lens_account_address — so that's
  // checked first (the same fix as in SupportPage.jsx).
  const myAccountAddress =
    localStorage.getItem("lens_account_address") ||
    lensProfile?.address ||
    connectedAddress ||
    lensWalletAddress ||
    null;
  const authorWalletAddress = getAuthorWalletAddress();
  const isOwner =
    !!myAccountAddress &&
    !!authorWalletAddress &&
    authorWalletAddress.toLowerCase() === myAccountAddress.toLowerCase();
  const author = request.author;

  // ── Main render ───────────────────────────────────────────────────────────────

  return (
    <Layout
      userProfile={userProfile}
      onLogout={handleLogout}
      loading={false}
      error={error}
      onCreatePost={() => setShowCreatePostModal(true)}
    >
      {/* Create post modal — the same modal and the same display
          condition (showCreatePostModal) as on ComplaintDetailsPage.jsx */}
      {showCreatePostModal && (
        <div className="h-full">
          <CreatePostModal
            onClose={() => setShowCreatePostModal(false)}
            userCountry={userProfile?.country || "EARTH"}
          />
        </div>
      )}

      {!showCreatePostModal && (
        <div className="w-full py-4 px-0 lg:px-3">
          {/* Back navigation — structurally consistent with ComplaintDetailsPage */}
          <div className="mb-4 pb-4 border-b border-slate-300 dark:border-white/[0.06] flex items-center justify-between">
            <button
              onClick={() => navigate("/support")}
              className="inline-flex items-center gap-1.5 text-[14px] text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/65 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {t("back_to_requests") || "Back to requests"}
            </button>
          </div>

          {/* Confirm delete banner */}
          {isOwner && deleteConfirm && (
            <div className="bg-red-50 dark:bg-[#1a0505] border border-red-300 dark:border-red-800/30 rounded-xl p-3.5 mb-3">
              <p className="text-[16px] text-red-700 dark:text-red-400/80 mb-3">
                {t("delete_request_confirm") ||
                  "Confirm deletion? The post will be hidden on-chain."}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex-1 py-1.5 text-[16px] font-medium bg-red-600 dark:bg-red-900/25 border border-red-700 dark:border-red-700/30 text-white dark:text-red-400/80 rounded-lg hover:bg-red-700 dark:hover:bg-red-900/40 transition-colors disabled:opacity-40"
                >
                  {t("delete")}
                </button>
                <button
                  onClick={() => setDeleteConfirm(false)}
                  className="flex-1 py-1.5 text-[16px] bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.08] text-slate-600 dark:text-white/40 rounded-lg hover:bg-slate-200 dark:hover:bg-white/[0.06] transition-colors"
                >
                  {t("cancel")}
                </button>
              </div>
            </div>
          )}

          {/* ── A single unified card: author + meta + description + wallet + attachments ── */}
          <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl overflow-hidden">
            {/* Header: author (name + @handle + country on one line) + actions
              (Share / Delete-Report) in the card's top-right corner */}
            <div className="p-4 border-b border-slate-300 dark:border-white/[0.06]">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="relative flex-shrink-0">
                    <div
                      className="relative w-[40px] h-[44px] p-[1.5px] clip-path-hexagon
                      bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]"
                    >
                      <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon">
                        {getAuthorAvatar() ? (
                          <img
                            src={getAvatarUrl(getAuthorAvatar())}
                            alt={getAuthorName()}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.target.style.display = "none";
                              if (e.target.parentElement) {
                                const fallbackDiv =
                                  e.target.parentElement.querySelector(
                                    ".avatar-fallback",
                                  );
                                if (fallbackDiv)
                                  fallbackDiv.style.display = "flex";
                              }
                            }}
                          />
                        ) : null}
                        <div
                          className={`
                          avatar-fallback w-full h-full flex items-center justify-center
                          font-cinzel text-[13px] text-[#c8b8a2] bg-[#0d0415]
                          ${getAuthorAvatar() ? "hidden" : "flex"}
                        `}
                        >
                          {getAuthorName()?.[0]?.toUpperCase() || "U"}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="min-w-0">
                    {/* Name, @handle, and country — on one line */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[16px] font-medium text-slate-900 dark:text-white/75">
                        {getAuthorName()}
                      </span>
                      {getAuthorHandle() && (
                        <span className="text-[14px] text-slate-600 dark:text-white/40 flex-shrink-0">
                          {getAuthorHandle()}
                        </span>
                      )}
                      {/* Changed: the country badge used to be
                          rounded-full (pill-shaped) — now it's rounded
                          (more square), matching ViolationsListPage, for
                          a consistent look. */}
                      <div className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/15 border border-blue-300/60 dark:border-blue-700/20 text-blue-800 dark:text-blue-400/65">
                        <Globe className="w-2.5 h-2.5" />
                        {getCountryName(request.country_code) ||
                          getTranslatedCountryName(request.country_code)}
                      </div>
                    </div>
                    {author?.country && (
                      <div className="flex items-center gap-1 mt-0.5 text-[11px] text-slate-600 dark:text-white/40">
                        <Globe className="w-2.5 h-2.5" />
                        {getCountryName(author.country)}
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions — top-right corner of the card.
                    Changed: the "Share"/"Delete"/"Report" buttons used
                    to be text buttons (taking up a lot of space) — now
                    they're compact square icons with a title tooltip,
                    matching ViolationDetailsPage. */}
                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <div className="relative">
                    <button
                      onClick={shareRequest}
                      title={t("share") || "Share"}
                      aria-label={t("share") || "Share"}
                      className="w-8 h-8 flex items-center justify-center rounded-lg border border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-600 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65 transition-all"
                    >
                      <Share2 className="w-4 h-4" />
                    </button>
                    {shareToast && (
                      <div className="absolute top-full right-0 mt-1 z-10 bg-emerald-50 dark:bg-[#051a0d] border border-emerald-300 dark:border-emerald-700/30 text-emerald-700 dark:text-emerald-400/80 text-[14px] px-2.5 py-1.5 rounded-lg whitespace-nowrap">
                        {t("link_copied") || "Link copied!"}
                      </div>
                    )}
                  </div>

                  {isOwner ? (
                    <button
                      onClick={handleDelete}
                      disabled={deleting}
                      title={
                        deleteConfirm
                          ? t("confirm_delete") || "Confirm?"
                          : t("delete") || "Delete"
                      }
                      aria-label={
                        deleteConfirm
                          ? t("confirm_delete") || "Confirm?"
                          : t("delete") || "Delete"
                      }
                      className={`w-8 h-8 flex items-center justify-center rounded-lg border transition-colors disabled:opacity-50 ${
                        deleteConfirm
                          ? "bg-red-50 dark:bg-red-500/20 border-red-400 dark:border-red-500/40 text-red-700 dark:text-red-400/90"
                          : "border-red-300 dark:border-red-500/25 text-red-700 dark:text-red-400/70 hover:bg-red-500/[0.08] hover:border-red-400 dark:hover:border-red-500/40"
                      }`}
                    >
                      {deleting ? (
                        <div className="w-3.5 h-3.5 rounded-full border-2 border-red-600/30 border-t-red-500 animate-spin" />
                      ) : (
                        <Trash2 className="w-4 h-4" />
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={handleReport}
                      title={t("report") || "Report"}
                      aria-label={t("report") || "Report"}
                      className="w-8 h-8 flex items-center justify-center rounded-lg border border-red-300 dark:border-red-500/25 text-red-700 dark:text-red-400/70 hover:bg-red-500/[0.08] hover:border-red-400 dark:hover:border-red-500/40 transition-colors"
                    >
                      <Flag className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Help types */}
              {request.help_types?.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {request.help_types.map((typeId) => {
                    const type = helpTypes.find((h) => h.id === typeId);
                    if (!type) return null;
                    const Icon = type.icon;
                    return (
                      <span
                        key={typeId}
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${type.cls}`}
                      >
                        <Icon className="w-3 h-3" />
                        {t(`help_type_${typeId}`) || typeId}
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Creation date — the same label/placement as on ComplaintDetailsPage */}
              <div className="mt-3 pt-3 border-t border-slate-200 dark:border-white/[0.05]">
                <div className="flex items-center gap-1.5 text-[14px] text-slate-600 dark:text-white/40">
                  <Calendar className="w-3 h-3 flex-shrink-0" />
                  <span>
                    {t("created_at") || "Created:"}{" "}
                    {formatDate(request.created_at)}
                  </span>
                </div>
              </div>
            </div>

            {/* Main content — pulled into a variable via an IIFE so it can
                be shown either normally or blurred/hidden, without
                duplicating JSX (the blur/hide actions from
                ModerationQueue.jsx previously had no visible effect on
                the page itself). */}
            {(() => {
              const mainContentNode = (
                <div className="p-4 space-y-4">
                  {/* Description */}
                  <div>
                    <h3 className="text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40 mb-2">
                      {t("description") || "Description"}
                    </h3>
                    <div className="bg-slate-50 dark:bg-white/[0.025] border border-slate-200 dark:border-white/[0.06] rounded-lg p-3">
                      <p className="text-[14px] text-slate-600 dark:text-white/45 leading-relaxed whitespace-pre-wrap">
                        {request.description}
                      </p>
                    </div>
                  </div>

                  {/* Author wallet address */}
                  {author?.id && (
                    <div>
                      <h3 className="text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40 mb-2">
                        {t("author_wallet") || "Author wallet address"}
                      </h3>
                      <div className="bg-slate-50 dark:bg-white/[0.025] border border-slate-200 dark:border-white/[0.06] rounded-lg overflow-hidden">
                        <div className="flex items-center gap-3 px-3.5 py-2.5">
                          <Wallet className="w-3.5 h-3.5 text-slate-600 dark:text-white/40 flex-shrink-0" />
                          <span className="text-[14px] font-mono text-blue-700 dark:text-blue-400/60 flex-1 truncate">
                            {author.id}
                          </span>
                          <button
                            onClick={() => copyToClipboard(author.id, "wallet")}
                            className={`w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 transition-all ${
                              copiedKey === "wallet"
                                ? "bg-emerald-500/15 text-emerald-400/80"
                                : "text-slate-600 dark:text-white/40 hover:bg-slate-200 dark:hover:bg-white/[0.06] hover:text-slate-900 dark:hover:text-white/55"
                            }`}
                          >
                            {copiedKey === "wallet" ? (
                              <Check className="w-3 h-3" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Media attachments — small, uniformly sized square
                thumbnails in a grid (the same grid sizing used for
                evidence on ComplaintDetailsPage:
                grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 + aspect-square). Tile size
                is determined by the number of columns relative to the
                card width, not by the file's actual dimensions — so
                images/videos/files are all now the same size. Full-size
                video/image opens on click, in a new tab. */}
                  {request.attachments?.length > 0 && (
                    <div>
                      <h3 className="text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40 mb-2">
                        {t("attachments") || "Attached files"} (
                        {request.attachments.length})
                      </h3>
                      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2">
                        {request.attachments.map((uri, index) => {
                          if (!uri) return null;
                          const url = resolveUri(uri);
                          const type = getMediaType(uri);

                          if (type === "image") {
                            return (
                              <a
                                key={index}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="relative aspect-square block overflow-hidden rounded-lg border border-slate-200 dark:border-white/[0.07] bg-slate-50 dark:bg-white/[0.02] group"
                              >
                                <img
                                  src={url}
                                  alt={`Attachment ${index + 1}`}
                                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                                  loading="lazy"
                                />
                                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/35 transition-all flex items-center justify-center">
                                  <Eye className="w-4 h-4 text-white opacity-0 group-hover:opacity-90 transition-opacity" />
                                </div>
                              </a>
                            );
                          }

                          if (type === "video") {
                            return (
                              <a
                                key={index}
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="relative aspect-square block overflow-hidden rounded-lg border border-slate-200 dark:border-white/[0.07] bg-slate-100 dark:bg-[#050e1f] group"
                              >
                                <video
                                  src={url}
                                  className="w-full h-full object-cover"
                                  preload="metadata"
                                  muted
                                />
                                <div className="absolute inset-0 bg-black/25 group-hover:bg-black/40 transition-all flex items-center justify-center">
                                  <div className="w-7 h-7 rounded-full bg-white/85 flex items-center justify-center">
                                    <Play className="w-3.5 h-3.5 text-slate-900 fill-slate-900 ml-0.5" />
                                  </div>
                                </div>
                              </a>
                            );
                          }

                          return (
                            <a
                              key={index}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="aspect-square flex flex-col items-center justify-center gap-1 p-2 rounded-lg bg-slate-50 dark:bg-white/[0.025] border border-slate-200 dark:border-white/[0.06] hover:border-slate-400 dark:hover:border-white/[0.13] hover:bg-slate-100 dark:hover:bg-white/[0.04] transition-all text-center"
                            >
                              {getFileIcon(uri)}
                              <p className="text-[11px] text-slate-600 dark:text-white/40 truncate w-full">
                                {uri.split("/").pop()}
                              </p>
                            </a>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );

              if (banState?.banned) {
                return (
                  <div className="flex flex-col items-center text-center gap-2 py-10 px-4 rounded-xl border border-red-300 dark:border-red-500/25 bg-red-50 dark:bg-red-500/[0.06]">
                    <ShieldAlert className="w-6 h-6 text-red-500" />
                    <p className="text-[13px] font-medium text-slate-700 dark:text-white/70">
                      This author's account has been banned by community vote
                    </p>
                  </div>
                );
              }

              if (modState.hidden) {
                const isCritical = modState.hiddenReason === "critical";
                return (
                  <div
                    className={`flex flex-col items-center text-center gap-2 py-10 px-4 rounded-xl border ${
                      isCritical
                        ? "border-red-300 dark:border-red-500/25 bg-red-50 dark:bg-red-500/[0.06]"
                        : "border-amber-300 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/[0.06]"
                    }`}
                  >
                    <ShieldAlert
                      className={`w-6 h-6 ${isCritical ? "text-red-500" : "text-amber-500"}`}
                    />
                    <p className="text-[13px] font-medium text-slate-700 dark:text-white/70">
                      {isCritical
                        ? "Content hidden by a moderator (critical category)"
                        : "Content hidden by a moderator"}
                    </p>
                    {isCritical &&
                      modState.criticalDeadline &&
                      !modState.criticalConfirmed && (
                        <p className="text-[11px] text-slate-500 dark:text-white/40">
                          {"Awaiting confirmation from other moderators until"}{" "}
                          {new Date(modState.criticalDeadline).toLocaleString()}
                        </p>
                      )}
                  </div>
                );
              }

              if (modState.blurred && !contentRevealed) {
                return (
                  <div className="relative rounded-xl overflow-hidden">
                    <div className="pointer-events-none select-none blur-md opacity-60">
                      {mainContentNode}
                    </div>
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/10 dark:bg-black/30">
                      <EyeOff className="w-5 h-5 text-slate-600 dark:text-white/70" />
                      <p className="text-[12px] text-slate-700 dark:text-white/80 font-medium">
                        {"Content has been flagged by a moderator as sensitive"}
                      </p>
                      <button
                        onClick={() => setContentRevealed(true)}
                        className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium bg-white/90 dark:bg-white/10 border border-slate-300 dark:border-white/20 rounded-lg hover:bg-white dark:hover:bg-white/15 transition-colors"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        {"Show content"}
                      </button>
                    </div>
                  </div>
                );
              }

              return mainContentNode;
            })()}
          </div>

          {/* ── Comments ── */}
          <div className="mt-4">
            <CommentsSection
              comments={comments}
              lensProfile={lensProfile}
              postingComment={postingComment}
              onSubmitComment={postCommentWithLimit}
              onDeleteComment={deleteComment}
              onReactComment={reactToComment}
              onReportComment={handleReportComment}
              isCommentOwner={isCommentOwner}
              getCountryDisplayName={getCountryDisplayName}
              formatDate={formatDate}
            />
          </div>
        </div>
      )}

      {/* Report on the request itself */}
      {reportModalPost && (
        <ReportModal
          post={{
            id: reportModalPost.id,
            lens_post_id: reportModalPost.lens_post_id,
            content: reportModalPost.description,
            media_urls: reportModalPost.attachments || [],
            media_types: [],
          }}
          authorAddress={getAuthorWalletAddress()}
          authorCandidates={[
            getAuthorWalletAddress(),
            request?.author?.owner_address,
          ].filter(Boolean)}
          createLensComment={createLensComment}
          sessionClient={sessionClient}
          countryCode={lensProfile?.country || "EARTH"}
          dao={dao}
          onClose={() => setReportModalPost(null)}
        />
      )}

      {/* Report on a comment */}
      {reportModalComment && (
        <ReportModal
          post={{
            id: reportModalComment.id,
            lens_post_id:
              reportModalComment.lens_comment_id || reportModalComment.id,
            content: reportModalComment.content,
            media_urls: [],
            media_types: [],
          }}
          authorAddress={
            reportModalComment.author?.wallet_address ||
            reportModalComment.author?.id
          }
          authorCandidates={[
            reportModalComment.author?.wallet_address,
            reportModalComment.author?.id,
            reportModalComment.author?.owner_address,
          ].filter(Boolean)}
          createLensComment={createLensComment}
          sessionClient={sessionClient}
          countryCode={lensProfile?.country || "EARTH"}
          dao={dao}
          onClose={() => setReportModalComment(null)}
        />
      )}
    </Layout>
  );
};

export default HelpRequestPage;
