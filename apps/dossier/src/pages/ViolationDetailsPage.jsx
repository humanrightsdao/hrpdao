// src/pages/ViolationDetailsPage.jsx
import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  MapPin,
  Calendar,
  FileText,
  ArrowLeft,
  AlertCircle,
  Globe,
  ExternalLink,
  Map,
  Flag,
  List,
  Trash2,
  Share2,
  Eye,
  EyeOff,
  ShieldAlert,
  Check,
  X,
} from "lucide-react";
import Layout from "../components/Layout";
import useLensViolations from "../hooks/useLensViolations";
import useUserInfo from "../hooks/useUserInfo";
import { useCountry } from "../hooks/useCountry";
import CreatePostModal from "../components/CreatePostModal";
import {
  getSeverityInfo,
  VIOLATION_CATEGORIES,
} from "../config/violationTypes";
// CHANGED: the old useViolationReports (counter + threshold) was removed
// by agreement — unified onto the same ReportModal/DAO flow used for
// posts and help requests (a violation is also just a regular Lens Post,
// so lens_post_id works the same way).
import { useLensAuth } from "../context/LensAuthContext";
import { useLensDAO } from "../hooks/useLensDAO";
import { useLensProfile } from "../hooks/useLensProfile";
import useLensComments from "../hooks/useLensComments";
import CommentsSection from "../components/CommentsSection";
// ADDED: without this, moderation actions (blur/hide/critical hide) were
// only tallied inside ModerationQueue.jsx — on the violation's own page
// there was no effect at all, even though the action had been published
// successfully. Without separate hook/component files — all the tallying
// and UI is right here.
import {
  fetchAllModActions,
  computeModerationState,
} from "../utils/moderationActions";
import { fetchAllReportComments } from "../utils/postReports";
import { checkPostRateLimit } from "../utils/postRateLimit";
import ReportModal from "../components/ReportModal";

const ViolationDetailsPage = () => {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const { userInfo, loading: userLoading } = useUserInfo();
  const { getTranslatedCountryName } = useCountry(
    localStorage.getItem("i18nextLng") || "en",
  );
  const { fetchViolationById, deleteViolation } = useLensViolations();

  const [violation, setViolation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);

  // Deleting one's own violation. The logic for determining "one's own"
  // violation is exactly the
  // same as in ViolationsListPage.jsx: violation.author.wallet_address is
  // the Lens ACCOUNT address (post.author.address), NOT the EOA wallet, so
  // we compare specifically against localStorage.lens_account_address
  // (set by LensAuthContext.loginWithAccount), not against
  // lens_wallet_address/
  // web3_wallet_address.
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // ADDED: a "Share" toast — the same pattern as on HelpRequestPage.
  const [shareToast, setShareToast] = useState(false);

  const myAccountAddress =
    localStorage.getItem("lens_account_address") ||
    userInfo?.wallet_address_web3 ||
    localStorage.getItem("web3_wallet_address") ||
    localStorage.getItem("lens_wallet_address") ||
    null;

  const isOwnViolation = (c) => {
    const authorAddress =
      c?.author?.wallet_address || c?.wallet_address || null;
    return (
      !!myAccountAddress &&
      !!authorAddress &&
      authorAddress.toLowerCase() === myAccountAddress.toLowerCase()
    );
  };

  const handleDeleteViolation = async () => {
    setDeleteLoading(true);
    try {
      const result = await deleteViolation(violation.id);
      if (!result.success) {
        throw new Error(result.error || "Failed to delete violation");
      }
      navigate("/violations-list");
    } catch (err) {
      console.error("Error deleting violation:", err);
      setError(err.message || t("delete_failed") || "Deletion error");
      setShowDeleteConfirm(false);
    } finally {
      setDeleteLoading(false);
    }
  };

  // CHANGED (embedded wallet): getWalletClient (the function) and
  // address (the connected EOA address) now come from useLensAuth() —
  // same reasoning as PostPage.jsx/HelpRequestPage.jsx.
  // ADDED: the same set as on PostPage.jsx/HelpRequestPage.jsx —
  // sessionClient for comments/reports, dao for the Shield/Senate check,
  // lensProfile for the avatar/country in the comments block.
  const { sessionClient, getWalletClient, address: connectedAddress } =
    useLensAuth();
  const dao = useLensDAO();
  const lensWalletAddress = localStorage.getItem("lens_wallet_address");
  const { profile: lensProfile } = useLensProfile(lensWalletAddress);

  const [reportModalPost, setReportModalPost] = useState(null);
  const [reportModalComment, setReportModalComment] = useState(null);

  // Load violation details
  const loadViolationDetails = async () => {
    setLoading(true);
    setError("");

    try {
      const result = await fetchViolationById(id);

      if (!result.success) {
        throw new Error(result.error);
      }

      setViolation(result.violation);
    } catch (err) {
      console.error("Error loading violation:", err);
      setError(
        err.message || t("load_violation_error") || "Error loading violation",
      );
      setViolation(null);
    } finally {
      setLoading(false);
    }
  };

  // CHANGED: instead of submitReport(id) from useViolationReports — the
  // same ReportModal/DAO flow as on PostPage.jsx/CountryFeed.jsx.
  const handleReport = async () => {
    if (!dao.account) {
      const res = await dao.connect();
      if (!res?.success) {
        alert("You need to connect a wallet to file a report.");
        return;
      }
    }
    setReportModalPost(violation);
  };

  const handleReportComment = async (comment) => {
    if (!dao.account) {
      const res = await dao.connect();
      if (!res?.success) {
        alert("You need to connect a wallet to file a report.");
        return;
      }
    }
    setReportModalComment(comment);
  };

  // ADDED: comments on the violation — the same generic hook as on
  // PostPage.jsx/HelpRequestPage.jsx.
  const {
    comments,
    postingComment,
    postComment,
    deleteComment,
    reactToComment,
    isCommentOwner,
    createLensComment,
  } = useLensComments(
    violation?.lens_post_id,
    sessionClient,
    lensProfile,
    getWalletClient,
    connectedAddress,
  );

  // ADDED: a wrapper over postComment with the shared publishing limit
  // (1/min, 10/hr, 20/day - the same counter used for posts).
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

  useEffect(() => {
    let cancelled = false;
    if (!violation?.lens_post_id) return;
    (async () => {
      try {
        const [actions, reportsList] = await Promise.all([
          fetchAllModActions(),
          fetchAllReportComments(),
        ]);
        if (!cancelled) {
          setModState(
            computeModerationState(actions, violation.lens_post_id, {
              reports: reportsList,
            }),
          );
        }
      } catch (err) {
        console.warn("⚠️ Could not load moderation state:", err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [violation?.lens_post_id]);

  const getCountryDisplayName = (countryCode) => {
    if (!countryCode || countryCode === "EARTH") {
      return t("earth") || "Planet Earth";
    }
    return getTranslatedCountryName(countryCode) || countryCode;
  };

  useEffect(() => {
    if (id) {
      loadViolationDetails();
    }
  }, [id, userInfo]);

  // Severity badge — colors and text come from config/violationTypes.js.
  // The shape (rounded-full) is the reference style for all
  // highlighted/badge elements on both details pages.
  const getSeverityBadgeClasses = (severityLevel) => {
    switch (severityLevel) {
      case 3:
        return "bg-red-50 dark:bg-red-500/20 text-red-700 dark:text-red-400/90 border-red-300 dark:border-red-500/30";
      case 2:
        return "bg-orange-50 dark:bg-orange-500/20 text-orange-700 dark:text-orange-400/90 border-orange-300 dark:border-orange-500/30";
      case 1:
      default:
        return "bg-yellow-50 dark:bg-yellow-500/15 text-yellow-700 dark:text-yellow-400/80 border-yellow-300 dark:border-yellow-500/25";
    }
  };

  const getSeverityText = (severityLevel) => {
    const info = getSeverityInfo(severityLevel);
    return t(info.labelKey) || info.label;
  };

  // Format date
  const formatDate = (dateString) => {
    if (!dateString) return t("unknown_date") || "Unknown";
    const date = new Date(dateString);
    return date.toLocaleDateString(localStorage.getItem("i18nextLng") || "en", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Format date short (for compact display).
  // FIXED: previously this had no hour/minute — the time the user
  // explicitly entered in the violation creation form (a separate "Time"
  // field, combined into violationDate + "T" + violationTime in
  // ViolationsPage before submission) was simply dropped when displayed.
  // Now shown the same way as formatDate.
  const formatDateShort = (dateString) => {
    if (!dateString) return "";
    const date = new Date(dateString);
    return date.toLocaleDateString(localStorage.getItem("i18nextLng") || "en", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // ADDED: "Share" — previously this page had no such button at all;
  // now a working flow (Web Share API → clipboard fallback) with proper
  // error/cancellation handling, the same as on HelpRequestPage.
  const handleShare = () => {
    const shareData = {
      title: violation?.title || t("violation_details") || "Violation",
      text: violation?.violation_description?.slice(0, 100) || "",
      url: `${window.location.origin}/violations/${id}`,
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

  if (userLoading) {
    return (
      <Layout
        userProfile={userInfo}
        onLogout={() => {}}
        loading={true}
        onCreatePost={() => setShowCreatePostModal(true)}
      >
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout
      userProfile={userInfo}
      onLogout={() => {
        localStorage.removeItem("token");
        localStorage.removeItem("web3_wallet_address");
        window.location.href = "/";
      }}
      loading={userLoading}
      onCreatePost={() => setShowCreatePostModal(true)}
    >
      {/* Create post modal */}
      {showCreatePostModal && userInfo && (
        <div className="h-full">
          <CreatePostModal
            onClose={() => setShowCreatePostModal(false)}
            userCountry={userInfo?.country || "EARTH"}
          />
        </div>
      )}

      {/* Main page - only shown if create post modal is not open */}
      {!showCreatePostModal && (
        <div className="w-full py-4 px-0 lg:px-3">
          {/* Back navigation and map link */}
          <div className="mb-4 pb-4 border-b border-slate-300 dark:border-white/[0.06] flex items-center justify-between">
            <Link
              to="/violations-list"
              className="inline-flex items-center gap-1.5 text-[14px] text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/65 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {t("back_to_list") || "Back to list"}
            </Link>

            {/* Navigation buttons */}
            <div className="flex items-center gap-2">
              <Link
                to="/violations-map"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] border border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-600 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65 transition-all"
              >
                <Map className="w-3 h-3" />
                {t("view_on_map") || "Map"}
              </Link>
              <Link
                to="/violations-list"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[14px] border border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-600 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65 transition-all"
              >
                <List className="w-3 h-3" />
                {t("violations_list") || "List"}
              </Link>
            </div>
          </div>

          {/* Error message */}
          {error && (
            <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-900/15 border border-red-300 dark:border-red-800/25 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-700 dark:text-red-400/75 flex-shrink-0" />
              <p className="text-[14px] text-red-700 dark:text-red-400/80">
                {error}
              </p>
              <Link
                to="/violations-list"
                className="ml-auto text-[14px] text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/65 transition-colors"
              >
                {t("back_to_list") || "Back"}
              </Link>
            </div>
          )}

          {/* Loading */}
          {loading && (
            <div className="flex justify-center py-8">
              <div className="w-8 h-8 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin" />
            </div>
          )}

          {/* Violation details — ONE unified card (header + meta + content) */}
          {!loading && violation && (
            <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl overflow-hidden">
              {/* Header */}
              <div className="p-4 border-b border-slate-300 dark:border-white/[0.06]">
                {/* Country + address — the very top of the card; actions
                    ("Share" / "Report"/"Delete") — top right corner */}
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    {/* CHANGED: the country badge used to be rounded-full
                        (pill-shaped) — now rounded (more square), matching
                        ViolationsListPage, for a consistent look. */}
                    <div className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/15 border border-blue-300/60 dark:border-blue-700/20 text-blue-800 dark:text-blue-400/65">
                      <Globe className="w-2.5 h-2.5" />
                      {getTranslatedCountryName(violation.country_code)}
                    </div>
                    <div className="flex items-start gap-1.5">
                      <MapPin className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-slate-600 dark:text-white/40" />
                      <span className="text-[14px] text-slate-700 dark:text-white/45">
                        {violation.address}
                      </span>
                    </div>
                  </div>

                  {/* CHANGED: the "Share"/"Delete"/"Report" buttons used to
                      be text buttons (took up a lot of space) — now
                      compact square icons with a title tooltip. */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <div className="relative">
                      <button
                        onClick={handleShare}
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

                    {isOwnViolation(violation) ? (
                      !showDeleteConfirm ? (
                        <button
                          onClick={() => setShowDeleteConfirm(true)}
                          title={t("delete") || "Delete"}
                          aria-label={t("delete") || "Delete"}
                          className="w-8 h-8 flex items-center justify-center rounded-lg border border-red-300 dark:border-red-500/25 text-red-700 dark:text-red-400/70 hover:bg-red-500/[0.08] hover:border-red-400 dark:hover:border-red-500/40 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      ) : (
                        <div className="flex items-center gap-1.5 flex-wrap justify-end">
                          <button
                            onClick={handleDeleteViolation}
                            disabled={deleteLoading}
                            title={t("yes") || "Yes"}
                            aria-label={t("yes") || "Yes"}
                            className="w-8 h-8 flex items-center justify-center bg-red-50 dark:bg-red-500/20 border border-red-300 dark:border-red-500/30 text-red-700 dark:text-red-400/80 rounded-lg hover:bg-red-100 dark:hover:bg-red-500/30 transition-colors disabled:opacity-50"
                          >
                            {deleteLoading ? (
                              <div className="w-3.5 h-3.5 rounded-full border-2 border-red-600/30 border-t-red-500 animate-spin" />
                            ) : (
                              <Check className="w-4 h-4" />
                            )}
                          </button>
                          <button
                            onClick={() => setShowDeleteConfirm(false)}
                            disabled={deleteLoading}
                            title={t("cancel") || "Cancel"}
                            aria-label={t("cancel") || "Cancel"}
                            className="w-8 h-8 flex items-center justify-center border border-slate-300 dark:border-white/[0.09] text-slate-600 dark:text-white/40 rounded-lg hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-700 dark:hover:text-white/45 transition-colors disabled:opacity-50"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      )
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

                {/* Severity level. We deliberately don't show the
                    violation's title (violation.title) here — it
                    duplicates the text already shown below in the
                    "VIOLATION DESCRIPTION" section. */}
                <div>
                  <span
                    className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-full border ${getSeverityBadgeClasses(
                      violation.severity_level,
                    )}`}
                  >
                    <span>
                      {getSeverityInfo(violation.severity_level).emoji}
                    </span>
                    {getSeverityText(violation.severity_level)}
                  </span>
                </div>

                {/* Creation date — the same label/placement as on HelpRequestPage */}
                <div className="mt-3 pt-3 border-t border-slate-200 dark:border-white/[0.05]">
                  <div className="flex items-center gap-1.5 text-[14px] text-slate-600 dark:text-white/40">
                    <Calendar className="w-3 h-3 flex-shrink-0" />
                    <span>
                      {t("created_at") || "Created:"}{" "}
                      {formatDate(violation.created_at)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Main content — extracted into a variable via an IIFE, so
                  it can be shown either normally or blurred/hidden,
                  without duplicating the JSX. */}
              {(() => {
                const mainContentNode = (
                  <div className="p-4 space-y-4">
                    {/* Violation description */}
                    <div>
                      <h3 className="text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40 mb-2">
                        {t("violation_description") || "Violation Description"}
                      </h3>
                      <div className="bg-slate-50 dark:bg-white/[0.025] border border-slate-200 dark:border-white/[0.06] rounded-lg p-3">
                        <p className="text-[14px] text-slate-600 dark:text-white/45 leading-relaxed whitespace-pre-line">
                          {violation.violation_description}
                        </p>
                      </div>
                    </div>

                    {/* Violation type */}
                    {violation.violation_type_id && (
                      <div>
                        <h3 className="text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40 mb-2">
                          {t("violation_type") || "Violation Type"}
                        </h3>
                        <div className="bg-slate-50 dark:bg-white/[0.025] border border-slate-200 dark:border-white/[0.06] rounded-lg p-3">
                          <p className="text-[14px] text-slate-600 dark:text-white/45">
                            {(() => {
                              const category = VIOLATION_CATEGORIES.find(
                                (c) => c.id === violation.category_id,
                              );
                              const type = category?.types.find(
                                (t2) => t2.id === violation.violation_type_id,
                              );
                              if (!category || !type)
                                return violation.violation_type_id;
                              return `${t(category.labelKey) || category.label} → ${
                                t(type.labelKey) || type.label
                              }`;
                            })()}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* General description */}
                    {violation.description && (
                      <div>
                        <h3 className="text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40 mb-2">
                          {t("general_description") || "General Description"}
                        </h3>
                        <div className="bg-slate-50 dark:bg-white/[0.025] border border-slate-200 dark:border-white/[0.06] rounded-lg p-3">
                          <p className="text-[14px] text-slate-600 dark:text-white/45 leading-relaxed whitespace-pre-line">
                            {violation.description}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Violation date */}
                    {violation.violation_date && (
                      <div>
                        <h3 className="text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40 mb-2">
                          {t("violation_date") || "Violation Date"}
                        </h3>
                        <div className="bg-slate-50 dark:bg-white/[0.025] border border-slate-200 dark:border-white/[0.06] rounded-lg p-3">
                          <p className="text-[14px] text-slate-600 dark:text-white/45">
                            {formatDateShort(violation.violation_date)}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Coordinates */}
                    {violation.latitude && violation.longitude && (
                      <div>
                        <h3 className="text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40 mb-2">
                          {t("location") || "Coordinates"}
                        </h3>
                        <div className="bg-slate-50 dark:bg-white/[0.025] border border-slate-200 dark:border-white/[0.06] rounded-lg p-2.5">
                          <p className="text-[14px] text-slate-600 dark:text-white/40 font-mono">
                            {violation.latitude.toFixed(6)},{" "}
                            {violation.longitude.toFixed(6)}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Evidence — small, uniform square thumbnails in a grid;
                    tile size is determined by the number of grid columns
                    (grid-cols) relative to the card's width, not by the
                    file's physical size. The same grid size as the
                    attachments on HelpRequestPage. Full size — on click,
                    in a new tab. */}
                    {violation.evidence_files &&
                      violation.evidence_files.length > 0 && (
                        <div>
                          <h3 className="text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40 mb-2">
                            {t("evidence_files") || "Evidence"} (
                            {violation.evidence_files.length})
                          </h3>
                          <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2">
                            {violation.evidence_files.map((file, index) => (
                              <a
                                key={index}
                                href={file.url.replace(
                                  "lens://grove/",
                                  "https://api.grove.storage/",
                                )}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="relative group block"
                              >
                                {file.type?.startsWith("image/") ||
                                file.url?.includes(".jpg") ||
                                file.url?.includes(".jpeg") ||
                                file.url?.includes(".png") ||
                                file.url?.includes(".webp") ? (
                                  <div className="relative aspect-square overflow-hidden rounded-lg border border-slate-200 dark:border-white/[0.07] bg-slate-50 dark:bg-white/[0.02]">
                                    <img
                                      src={file.url.replace(
                                        "lens://grove/",
                                        "https://api.grove.storage/",
                                      )}
                                      alt={file.name}
                                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                                    />
                                    <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                                      <ExternalLink className="w-4 h-4 text-white dark:text-white/80" />
                                    </div>
                                  </div>
                                ) : (
                                  <div className="aspect-square bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.07] rounded-lg flex items-center justify-center group-hover:bg-slate-200 dark:group-hover:bg-white/[0.06] transition-colors">
                                    <FileText className="w-5 h-5 text-slate-600 dark:text-white/40" />
                                  </div>
                                )}
                                <p className="mt-1 text-[11px] text-slate-600 dark:text-white/40 truncate">
                                  {file.name}
                                </p>
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                  </div>
                );

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
                            {new Date(
                              modState.criticalDeadline,
                            ).toLocaleString()}
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
                          {"Content flagged by a moderator as sensitive"}
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
          )}

          {/* ── Comments ── */}
          {violation && (
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
          )}
        </div>
      )}

      {/* ADDED: report on the violation itself */}
      {reportModalPost && (
        <ReportModal
          post={{
            id: reportModalPost.id,
            lens_post_id: reportModalPost.lens_post_id,
            content: reportModalPost.violation_description,
            media_urls: (reportModalPost.evidence_files || []).map(
              (f) => f.url,
            ),
            media_types: [],
          }}
          authorAddress={reportModalPost.author?.wallet_address}
          authorCandidates={[
            reportModalPost.author?.wallet_address,
            reportModalPost.author?.owner_address,
          ].filter(Boolean)}
          createLensComment={createLensComment}
          sessionClient={sessionClient}
          countryCode={lensProfile?.country || "EARTH"}
          dao={dao}
          onClose={() => setReportModalPost(null)}
        />
      )}

      {/* ADDED: report on a comment */}
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

export default ViolationDetailsPage;
