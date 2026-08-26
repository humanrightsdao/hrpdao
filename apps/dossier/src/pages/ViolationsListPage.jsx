// src/pages/ViolationsListPage.jsx
import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  MapPin,
  Calendar,
  FileText,
  Filter,
  Search,
  Plus,
  AlertCircle,
  Globe,
  Map as MapIcon,
  Trash2,
  Flag,
  File,
  Share2,
} from "lucide-react";
import Layout from "../components/Layout";
import useLensViolations from "../hooks/useLensViolations";
import { useNavigate } from "react-router-dom";
import useUserInfo from "../hooks/useUserInfo";
import { useCountry } from "../hooks/useCountry";
import CreatePostModal from "../components/CreatePostModal";
import { SEVERITY_LEVELS, getSeverityInfo } from "../config/violationTypes";
// ADDED: the same report/moderation flow as on ViolationDetailsPage.jsx —
// previously "Report" here was an alert() stub, and blur/hide from
// ModerationQueue.jsx weren't tallied at all on this page. Without
// separate hook/component files — everything is right here, as agreed.
import { useLensAuth } from "../context/LensAuthContext";
import { useLensDAO } from "../hooks/useLensDAO";
import { useLensProfile } from "../hooks/useLensProfile";
import { useWalletClient } from "wagmi";
import ReportModal from "../components/ReportModal";
import useLensPosts from "../hooks/useLensPosts";
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";
// ADDED: reports (postReports.js) - needed for auto-quarantine
// (computeModerationState(..., { reports })), the same approach already
// applied in CountryFeed.jsx/ModerationQueue.jsx.
import { fetchAllReportComments } from "../utils/postReports";
import { EyeOff, ShieldAlert } from "lucide-react";

const ViolationsListPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { userInfo, loading: userLoading } = useUserInfo();
  const { getAllCountries, getTranslatedCountryName } = useCountry(
    localStorage.getItem("i18nextLng") || "en",
  );
  // NOTE: assuming useLensViolations exports deleteViolation
  // (by analogy with deleteRequest in useLensHelpRequests and deleteLensPost
  // in useLensPosts) — if the hook's function has a different name, fix it here.
  const {
    fetchViolations,
    loading: violationsLoading,
    deleteViolation,
  } = useLensViolations();

  // ADDED: needed for the report (ReportModal) — the same set as on
  // ViolationDetailsPage.jsx.
  // FIXED: this destructure was missing getWalletClient — useLensPosts()
  // below therefore ALWAYS got null for it, so createLensComment's
  // resolvedClient was always null and reporting a violation post
  // failed with "Wallet not connected" unconditionally, regardless of
  // the wallet actually being connected. Same fix as PostPage.jsx.
  const { sessionClient, getWalletClient } = useLensAuth();
  const dao = useLensDAO();
  const lensWalletAddress = localStorage.getItem("lens_wallet_address");
  const { profile: lensProfile } = useLensProfile(lensWalletAddress);
  const { data: walletClient } = useWalletClient();
  const { createLensComment } = useLensPosts(sessionClient, getWalletClient);

  const [reportModalViolation, setReportModalViolation] = useState(null);

  // ADDED: one shared fetchAllModActions() for the whole page (rather than
  // one per report in the list — otherwise N items = N full app scans).
  // computeModerationState() is applied per-item directly during render
  // from this same array.
  const [modActions, setModActions] = useState([]);
  // ADDED: reports, separate from moderation actions - needed for auto-quarantine.
  const [reports, setReports] = useState([]);
  // ДОДАНО: totalSupply() Shield SBT напряму з блокчейну — цю сторінку
  // переглядають і НЕ підключені відвідувачі, для яких dao.shieldInfo
  // завжди порожній (заповнюється лише після dao.connect()). Без цього
  // computeBanState() нижче завжди отримував totalEligibleVoters=0 →
  // кворум завжди 0% → пости забанених авторів ніколи не приховувались.
  const [shieldTotalSupply, setShieldTotalSupply] = useState(0);
  // ДОДАНО: доки modActions/shieldTotalSupply ще не завантажені (а самі
  // порушення могли завантажитись швидше і вже відрендерились) — пости
  // забаненого автора на мить показувались без фільтра, а тоді зникали.
  // modReady тримає список у стані завантаження, доки санкції не
  // прораховані хоча б раз.
  const [modReady, setModReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [actions, reportsList, supply] = await Promise.all([
          fetchAllModActions(),
          fetchAllReportComments(),
          fetchShieldTotalSupply(),
        ]);
        if (!cancelled) {
          setModActions(actions);
          setReports(reportsList);
          setShieldTotalSupply(supply);
        }
      } catch (err) {
        console.warn(
          "⚠️ Could not load moderation actions/reports:",
          err.message,
        );
      } finally {
        if (!cancelled) setModReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // State for violations
  const [violations, setViolations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // State for create post modal
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);

  // State for filtering
  const [filters, setFilters] = useState({
    country: "all",
    severityLevel: "all",
    searchQuery: "",
    showMyViolations: false,
    // ADDED: date filter, in the same style as on SupportPage
    // (client-side, applied on top of already-loaded violations — see loadViolations)
    dateFrom: "",
    dateTo: "",
  });

  // Sorting is currently fixed (no UI control exists to change it yet).
  // Kept as constants instead of state to avoid unused setter warnings;
  // convert back to useState if a sort control is added later.
  const sortBy = "created_at";
  const sortOrder = "desc";

  // State for pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const itemsPerPage = 10;

  // ДОДАНО: панель додаткових фільтрів (країна/рівень/дати/мої порушення)
  // згорнута за замовчуванням — той самий підхід, що на SupportPage:
  // завжди видимим лишається лише пошук, щоб не займати зайвий простір.
  const [filtersOpen, setFiltersOpen] = useState(false);

  // "My address" for determining the owner of a violation.
  //
  // IMPORTANT: violation.author.wallet_address is lensPost.author?.address,
  // i.e. the Lens ACCOUNT (smart contract) address, NOT the wallet (EOA)
  // address used to sign in. These are different addresses in Lens v2/v3.
  // lens_wallet_address / web3_wallet_address are specifically the EOA, so
  // comparing against them never matched and the delete button didn't
  // appear even for one's own violations.
  // LensAuthContext.loginWithAccount() stores the correct address separately —
  // localStorage.setItem("lens_account_address", accountItem.account?.address || accountItem.address) —
  // that's the one that should be compared against author.wallet_address.
  const myAccountAddress =
    localStorage.getItem("lens_account_address") ||
    userInfo?.wallet_address_web3 ||
    localStorage.getItem("web3_wallet_address") ||
    localStorage.getItem("lens_wallet_address") ||
    null;

  const isOwnViolation = (violation) => {
    const authorAddress =
      violation.author?.wallet_address || violation.wallet_address || null;
    return (
      !!myAccountAddress &&
      !!authorAddress &&
      authorAddress.toLowerCase() === myAccountAddress.toLowerCase()
    );
  };

  // Load violations
  const loadViolations = async () => {
    setLoading(true);
    setError("");

    try {
      const result = await fetchViolations({
        countryCode: filters.country !== "all" ? filters.country : null,
        severityLevel:
          filters.severityLevel !== "all" ? filters.severityLevel : null,
        searchQuery: filters.searchQuery || null,
      });

      if (!result.success) throw new Error(result.error);

      // Client-side sorting
      let sorted = [...result.violations];
      sorted.sort((a, b) => {
        const aVal = a[sortBy] || "";
        const bVal = b[sortBy] || "";
        return sortOrder === "desc"
          ? bVal.localeCompare(String(aVal))
          : aVal.localeCompare(String(bVal));
      });

      // "My violations" filter — compared in lowercase via the same
      // isOwnViolation(), to avoid discrepancies due to address casing
      // (checksum vs lowercase).
      if (filters.showMyViolations && userInfo) {
        sorted = sorted.filter((c) => isOwnViolation(c));
      }

      // ADDED: date filter — the same logic as in SupportPage.applyFilters()
      // (client-side, by created_at, "to" inclusive through the end of the day).
      if (filters.dateFrom) {
        const from = new Date(filters.dateFrom);
        sorted = sorted.filter((c) => new Date(c.created_at) >= from);
      }
      if (filters.dateTo) {
        const to = new Date(filters.dateTo);
        to.setHours(23, 59, 59, 999);
        sorted = sorted.filter((c) => new Date(c.created_at) <= to);
      }

      // Client-side pagination
      setTotalPages(Math.ceil(sorted.length / itemsPerPage));
      const from = (currentPage - 1) * itemsPerPage;
      setViolations(sorted.slice(from, from + itemsPerPage));
    } catch (err) {
      console.error("Error loading violations:", err);
      setError(err.message || "Error loading violations");
    } finally {
      setLoading(false);
    }
  };

  // Reload when filters change
  useEffect(() => {
    if (userInfo || !filters.showMyViolations) {
      loadViolations();
    }
  }, [filters, sortBy, sortOrder, currentPage, userInfo]);

  // Navigate to violation details page
  const handleViewDetails = (violationId) => {
    navigate(`/violations/${violationId}`);
  };

  // ADDED: "Share" — the same approach as shareRequest() on SupportPage
  // (Web Share API with a fallback to copying the link to the clipboard).
  const shareViolation = (violation) => {
    const url = `${window.location.origin}/violations/${violation.id}`;
    if (navigator.share) {
      navigator.share({
        title: violation.title,
        text: violation.violation_description?.slice(0, 100),
        url,
      });
    } else {
      navigator.clipboard.writeText(url);
    }
  };

  // ADDED: resetting filters the same way as resetFilters() on SupportPage
  const resetFilters = () => {
    setFilters({
      country: "all",
      severityLevel: "all",
      searchQuery: "",
      showMyViolations: false,
      dateFrom: "",
      dateTo: "",
    });
  };

  // ДОДАНО: кількість активних додаткових фільтрів (без урахування пошуку,
  // бо він завжди на видноті) — показуємо бейджем на кнопці-перемикачі.
  const activeExtraFiltersCount = [
    filters.country !== "all",
    filters.severityLevel !== "all",
    !!filters.dateFrom,
    !!filters.dateTo,
    filters.showMyViolations,
  ].filter(Boolean).length;

  // Delete own violation
  const handleDeleteViolation = async (violationId) => {
    if (
      !window.confirm(
        t("confirm_delete_violation") ||
          "Are you sure you want to delete this violation?",
      )
    ) {
      return;
    }

    try {
      const result = await deleteViolation(violationId);
      if (result && result.success === false) {
        throw new Error(result.error || "Failed to delete violation");
      }
      setViolations((prev) => prev.filter((c) => c.id !== violationId));
    } catch (err) {
      console.error("Error deleting violation:", err);
      setError(err.message || t("delete_failed") || "Deletion error");
    }
  };

  // CHANGED: previously an alert() stub. Now the same flow as on
  // ViolationDetailsPage.jsx.
  const handleReportViolation = async (violation) => {
    if (!dao.account) {
      const res = await dao.connect();
      if (!res?.success) {
        alert("You need to connect a wallet to file a report.");
        return;
      }
    }
    setReportModalViolation(violation);
  };

  // Severity badge: color and text are taken directly from
  // config/violationTypes.js, rather than duplicating a separate scale here.
  const getSeverityBadgeClasses = (severityLevel) => {
    switch (severityLevel) {
      case 3:
        return "text-red-700 bg-red-100 dark:text-red-400 dark:bg-red-900/20";
      case 2:
        return "text-orange-700 bg-orange-100 dark:text-orange-400 dark:bg-orange-900/20";
      case 1:
      default:
        return "text-yellow-700 bg-yellow-100 dark:text-yellow-400 dark:bg-yellow-900/20";
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

      {/* Main page - displayed only if create post modal is not open */}
      {!showCreatePostModal && (
        <div className="pt-3 pb-3 px-0 lg:p-4">
          {/* Header with title and navigation buttons.
              FIXED: the previous version switched between column/row via
              "sm:" (640px) — but that's a breakpoint on the width of the
              ENTIRE viewport, not the actual middle content column, which
              in this app is always narrow (squeezed by the side panels)
              regardless of the browser window's width. So on wide windows
              sm: enabled row mode even though there wasn't actually enough
              width for it — the button text still got cut off. Now the
              layout responds to the ACTUAL width of the container via
              flex-wrap, rather than a guessed breakpoint. */}
          <div className="mb-5 pb-4 border-b border-slate-300 dark:border-white/[0.06] flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="font-cinzel text-[19px] font-medium text-slate-900 dark:text-white/85 tracking-[0.04em] flex items-center gap-2">
                {t("violations_list") || "Violations List"}
              </h1>
            </div>

            {/* Navigation + CTA — the same layout as on SupportPage:
                secondary button (Map) + primary maroon create button */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => navigate("/violations-map")}
                className="min-w-0 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[14px] border border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-600 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-700 dark:hover:text-white/65 transition-all"
              >
                <MapIcon className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-center leading-tight">
                  {t("violations_map") || "Map"}
                </span>
              </button>
              <button
                onClick={() => navigate("/violations")}
                className="min-w-0 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg
                bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35
                dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:hover:bg-[#3D0012] transition-colors"
              >
                <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-center leading-tight">
                  {t("add_violation") || "Add violation"}
                </span>
              </button>
            </div>
          </div>

          {/* Filters */}
          {/* ЗМІНЕНО: пошук лишається завжди видимим (найчастіша дія),
              решта фільтрів (країна/рівень/дати/мої порушення/скинути)
              згорнута за замовчуванням і розкривається кнопкою-перемикачем
              з бейджем кількості активних фільтрів. */}
          <div className="mb-4">
            <div className="flex gap-2">
              {/* Search — завжди видимий */}
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-600 dark:text-white/40" />
                <input
                  type="text"
                  value={filters.searchQuery}
                  onChange={(e) =>
                    setFilters((prev) => ({
                      ...prev,
                      searchQuery: e.target.value,
                    }))
                  }
                  placeholder={
                    t("search_violations") || "Search violations..."
                  }
                  className="w-full h-[38px] pl-9 pr-3 bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-600 dark:text-white/65 placeholder-slate-400 dark:placeholder-white/[0.18] font-['Inter'] outline-none focus:border-blue-500/35 transition-all"
                />
              </div>

              {/* Кнопка-перемикач панелі додаткових фільтрів */}
              <button
                onClick={() => setFiltersOpen((prev) => !prev)}
                aria-expanded={filtersOpen}
                title={t("filters") || "Filters"}
                className={`relative flex-shrink-0 w-[38px] h-[38px] rounded-lg flex items-center justify-center border transition-all ${
                  filtersOpen
                    ? "border-blue-500/40 bg-blue-900/15 text-blue-400/85"
                    : "border-slate-300 dark:border-white/[0.09] bg-white dark:bg-[#000d1f] text-slate-700 dark:text-white/45 hover:border-slate-400 dark:hover:border-white/[0.15]"
                }`}
              >
                <Filter className="w-4 h-4" />
                {activeExtraFiltersCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] px-1 rounded-full bg-[#8B1A2A] dark:bg-[#2B000A] text-white/95 dark:text-white/85 text-[10px] leading-[16px] text-center">
                    {activeExtraFiltersCount}
                  </span>
                )}
              </button>
            </div>

            {/* Панель додаткових фільтрів — з'являється лише коли filtersOpen === true */}
            {filtersOpen && (
              <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-4 mt-2">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Country */}
                  <div>
                    <select
                      value={filters.country}
                      onChange={(e) =>
                        setFilters((prev) => ({
                          ...prev,
                          country: e.target.value,
                        }))
                      }
                      className="w-full h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-600 dark:text-white/65 font-['Inter'] outline-none focus:border-blue-500/35 transition-all appearance-none"
                    >
                      <option
                        value="all"
                        className="bg-white dark:bg-[#000d1f]"
                      >
                        {t("all_countries") || "All countries"}
                      </option>
                      {getAllCountries().map((country) => (
                        <option
                          key={country.code}
                          value={country.code}
                          className="bg-white dark:bg-[#000d1f]"
                        >
                          {country.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Severity */}
                  <div>
                    <select
                      value={filters.severityLevel}
                      onChange={(e) =>
                        setFilters((prev) => ({
                          ...prev,
                          severityLevel: e.target.value,
                        }))
                      }
                      className="w-full h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-600 dark:text-white/65 font-['Inter'] outline-none focus:border-blue-500/35 transition-all appearance-none"
                    >
                      <option
                        value="all"
                        className="bg-white dark:bg-[#000d1f]"
                      >
                        {t("all_severities") || "All severities"}
                      </option>
                      {Object.values(SEVERITY_LEVELS).map((level) => (
                        <option
                          key={level.id}
                          value={level.id}
                          className="bg-white dark:bg-[#000d1f]"
                        >
                          {level.emoji} {t(level.labelKey) || level.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Filter: date + My violations (button) + Reset — in the same style as SupportPage */}
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2">
                    <input
                      type="date"
                      value={filters.dateFrom}
                      onChange={(e) =>
                        setFilters((prev) => ({
                          ...prev,
                          dateFrom: e.target.value,
                        }))
                      }
                      className="h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-800 dark:text-white/45 font-['Inter'] outline-none focus:border-blue-500/35 transition-all w-[130px] [color-scheme:light] dark:[color-scheme:dark]"
                    />
                    <span className="text-slate-600 dark:text-white/40 text-[14px] flex-shrink-0">
                      —
                    </span>
                    <input
                      type="date"
                      value={filters.dateTo}
                      onChange={(e) =>
                        setFilters((prev) => ({
                          ...prev,
                          dateTo: e.target.value,
                        }))
                      }
                      className="h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-800 dark:text-white/45 font-['Inter'] outline-none focus:border-blue-500/35 transition-all w-[130px] [color-scheme:light] dark:[color-scheme:dark]"
                    />
                  </div>

                  <button
                    onClick={() =>
                      setFilters((prev) => ({
                        ...prev,
                        showMyViolations: !prev.showMyViolations,
                      }))
                    }
                    className={`flex items-center gap-1.5 h-[38px] px-3 rounded-lg text-[14px] border transition-all ${
                      filters.showMyViolations
                        ? "border-blue-500/40 bg-blue-900/15 text-blue-400/85"
                        : "border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/45 hover:border-slate-400 dark:hover:border-white/[0.15]"
                    }`}
                  >
                    <Filter className="w-3 h-3" />
                    {t("my_violations") || "My violations only"}
                  </button>

                  <button
                    onClick={resetFilters}
                    className="ml-auto flex items-center gap-1.5 h-[38px] px-3 rounded-lg text-[14px] border border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/45 hover:border-slate-400 dark:hover:border-white/[0.15] transition-all"
                  >
                    {t("reset_filters") || "Reset"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Content */}
          <div>
            {/* Error message */}
            {error && (
              <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-900/15 border border-red-300 dark:border-red-800/25 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400/75 flex-shrink-0" />
                <p className="text-[14px] text-red-700 dark:text-red-400/80">
                  {error}
                </p>
              </div>
            )}

            {/* Violations list */}
            {loading || !modReady ? (
              <div className="flex justify-center py-12">
                <div className="w-6 h-6 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin" />
              </div>
            ) : violations.length === 0 ? (
              <div className="text-center py-12 bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl">
                {filters.showMyViolations ? (
                  <>
                    <FileText className="w-10 h-10 text-slate-300 dark:text-white/[0.07] mx-auto mb-3" />
                    <p className="text-[16px] text-slate-600 dark:text-white/40 mb-1">
                      {t("no_my_violations") ||
                        "You haven't submitted any violations yet"}
                    </p>
                    <p className="text-[14px] text-slate-500 dark:text-white/40 mb-4">
                      {t("submit_first_violation_description") ||
                        "Submit your first violation to help protect human rights"}
                    </p>
                    <button
                      onClick={() => navigate("/violations")}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-[14px] bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/70 dark:hover:bg-[#3d0012] rounded-lg transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {t("submit_first_violation") || "Submit First Violation"}
                    </button>
                  </>
                ) : (
                  <>
                    <FileText className="w-10 h-10 text-slate-300 dark:text-white/[0.07] mx-auto mb-3" />
                    <p className="text-[16px] text-slate-600 dark:text-white/40 mb-1">
                      {t("no_published_violations") ||
                        "No published violations yet"}
                    </p>
                    <p className="text-[14px] text-slate-500 dark:text-white/40 mb-4">
                      {t("be_first_to_submit") ||
                        "Be the first to submit a violation"}
                    </p>
                    <button
                      onClick={() => navigate("/violations")}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-[14px] bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/70 dark:hover:bg-[#3d0012] rounded-lg transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      {t("submit_first_violation") || "Submit First Violation"}
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {violations.map((violation) => {
                  const modState = computeModerationState(
                    modActions,
                    violation.lens_post_id,
                    { reports },
                  );
                  const isCritical = modState.hiddenReason === "critical";

                  // ДОДАНО: пости авторів, чий акаунт забанено голосуванням
                  // (кворум Shield/Council), взагалі не показуємо в списку —
                  // раніше ця сторінка перевіряла лише hide/blur, але не
                  // бан автора.
                  const banState = violation.author?.owner_address
                    ? computeBanState(
                        modActions,
                        violation.author.owner_address,
                        shieldTotalSupply,
                      )
                    : null;
                  if (banState?.banned) return null;

                  const metaContentNode = (
                    <div className="flex-1 min-w-0">
                      {/* Meta information */}
                      <div className="flex flex-wrap items-center gap-2.5 text-[14px] text-slate-600 dark:text-white/40 mb-1.5">
                        {/* Country (uniform blue badge — matches SupportPage) */}
                        <div className="text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/15 border border-blue-300/60 dark:border-blue-700/20 text-blue-800 dark:text-blue-400/65 inline-flex items-center gap-1">
                          <Globe className="w-2.5 h-2.5" />
                          {getTranslatedCountryName(violation.country_code)}
                        </div>
                        <div className="flex items-center gap-1">
                          <MapPin className="w-3 h-3 text-slate-600 dark:text-white/40" />
                          <span className="truncate max-w-[200px]">
                            {violation.address}
                          </span>
                        </div>
                      </div>

                      {/* Date + time — separate line */}
                      <div className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-white/40 mb-2">
                        <Calendar className="w-3 h-3 text-slate-600 dark:text-white/40" />
                        <span>{formatDate(violation.created_at)}</span>
                      </div>

                      {/* Severity — under the date */}
                      <div className="flex items-center gap-2 mb-2">
                        <span
                          className={`px-2 py-0.5 text-[11px] font-medium rounded-full ${getSeverityBadgeClasses(
                            violation.severity_level,
                          )}`}
                        >
                          {getSeverityText(violation.severity_level)}
                        </span>
                      </div>

                      {/* Short description */}
                      {violation.violation_description && (
                        <p className="mt-2 text-[15px] text-slate-600 dark:text-white/40 leading-relaxed line-clamp-2">
                          {violation.violation_description.substring(0, 150)}
                          {violation.violation_description.length > 150 &&
                            "..."}
                        </p>
                      )}

                      {/* Attachments count — same presentation as SupportPage */}
                      {violation.evidence_files?.length > 0 && (
                        <div className="flex items-center gap-3 pt-2 mt-2 border-t border-slate-200 dark:border-white/[0.05]">
                          <span className="flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-white/40">
                            <File className="w-3 h-3" />
                            {violation.evidence_files.length}{" "}
                            {t("files") || "files"}
                          </span>
                        </div>
                      )}
                    </div>
                  );

                  return (
                    <div
                      key={violation.id}
                      onClick={() => handleViewDetails(violation.id)}
                      className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl overflow-hidden cursor-pointer transition-all duration-150 hover:border-slate-400 dark:hover:border-white/[0.13] hover:bg-slate-50 dark:hover:bg-[#001026]"
                    >
                      <div className="px-4 pt-3.5 pb-3">
                        <div className="flex items-start justify-between gap-3">
                          {/* CHANGED: content now shows either normally, or
                              blurred/hidden — depending on
                              computeModerationState() for this item. */}
                          {modState.hidden ? (
                            <div
                              className={`flex-1 flex items-center gap-2 py-2 px-3 rounded-lg border ${
                                isCritical
                                  ? "border-red-300 dark:border-red-500/25 bg-red-50 dark:bg-red-500/[0.06]"
                                  : "border-amber-300 dark:border-amber-500/25 bg-amber-50 dark:bg-amber-500/[0.06]"
                              }`}
                            >
                              <ShieldAlert
                                className={`w-4 h-4 flex-shrink-0 ${isCritical ? "text-red-500" : "text-amber-500"}`}
                              />
                              <p className="text-[12px] text-slate-700 dark:text-white/70">
                                {isCritical
                                  ? "Content hidden by a moderator (critical category)"
                                  : "Content hidden by a moderator"}
                              </p>
                            </div>
                          ) : modState.blurred ? (
                            <div className="relative flex-1 rounded-lg overflow-hidden">
                              <div className="pointer-events-none select-none blur-md opacity-60">
                                {metaContentNode}
                              </div>
                              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/10 dark:bg-black/30">
                                <EyeOff className="w-4 h-4 text-slate-600 dark:text-white/70" />
                                <p className="text-[11px] text-slate-700 dark:text-white/80 font-medium">
                                  Content flagged by a moderator as sensitive
                                </p>
                              </div>
                            </div>
                          ) : (
                            metaContentNode
                          )}

                          {/* Delete/Report buttons + chevron (navigation handled by the card itself) */}
                          <div
                            className="flex-shrink-0 flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                shareViolation(violation);
                              }}
                              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/65 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-all"
                              title={t("share")}
                            >
                              <Share2 className="w-3.5 h-3.5" />
                            </button>

                            {isOwnViolation(violation) ? (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleDeleteViolation(violation.id);
                                }}
                                className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-slate-600 dark:text-white/40 hover:text-red-600 dark:hover:text-red-400/80 hover:bg-red-50 dark:hover:bg-red-500/[0.08] transition-all"
                                title={t("delete") || "Delete"}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleReportViolation(violation);
                                }}
                                className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 text-slate-600 dark:text-white/40 hover:text-red-600 dark:hover:text-red-400/80 hover:bg-red-50 dark:hover:bg-red-500/[0.08] transition-all"
                                title={t("report") || "Report"}
                              >
                                <Flag className="w-3.5 h-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-5 pt-4 border-t border-slate-300 dark:border-white/[0.06]">
                <div className="flex flex-col sm:flex-row justify-center items-center gap-3">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() =>
                        setCurrentPage((prev) => Math.max(1, prev - 1))
                      }
                      disabled={currentPage === 1}
                      className="px-3 py-1.5 text-[14px] bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.09] rounded-lg text-slate-600 dark:text-white/40 disabled:opacity-30 disabled:cursor-not-allowed hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65 transition-all"
                    >
                      {t("previous") || "Previous"}
                    </button>

                    <div className="flex items-center gap-1">
                      {Array.from(
                        { length: Math.min(5, totalPages) },
                        (_, i) => {
                          let pageNum;
                          if (totalPages <= 5) {
                            pageNum = i + 1;
                          } else if (currentPage <= 3) {
                            pageNum = i + 1;
                          } else if (currentPage >= totalPages - 2) {
                            pageNum = totalPages - 4 + i;
                          } else {
                            pageNum = currentPage - 2 + i;
                          }

                          return (
                            <button
                              key={i}
                              onClick={() => setCurrentPage(pageNum)}
                              className={`w-8 h-8 text-[14px] rounded-lg transition-all ${
                                currentPage === pageNum
                                  ? "bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/80"
                                  : "bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] text-slate-600 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.14] hover:text-slate-900 dark:hover:text-white/60"
                              }`}
                            >
                              {pageNum}
                            </button>
                          );
                        },
                      )}
                    </div>

                    <button
                      onClick={() =>
                        setCurrentPage((prev) => Math.min(totalPages, prev + 1))
                      }
                      disabled={currentPage === totalPages}
                      className="px-3 py-1.5 text-[14px] bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.09] rounded-lg text-slate-600 dark:text-white/40 disabled:opacity-30 disabled:cursor-not-allowed hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65 transition-all"
                    >
                      {t("next") || "Next"}
                    </button>
                  </div>

                  {/* Count information */}
                  {violations.length > 0 && (
                    <div className="text-[14px] text-slate-600 dark:text-white/40">
                      {t("showing") || "Showing"}{" "}
                      {(currentPage - 1) * itemsPerPage + 1} -{" "}
                      {Math.min(currentPage * itemsPerPage, violations.length)}{" "}
                      {t("of") || "of"} {violations.length}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ADDED: report on a violation from the list */}
      {reportModalViolation && (
        <ReportModal
          post={{
            id: reportModalViolation.id,
            lens_post_id: reportModalViolation.lens_post_id,
            content: reportModalViolation.violation_description,
            media_urls: (reportModalViolation.evidence_files || []).map(
              (f) => f.url,
            ),
            media_types: [],
          }}
          authorAddress={reportModalViolation.author?.wallet_address}
          authorCandidates={[
            reportModalViolation.author?.wallet_address,
            reportModalViolation.author?.owner_address,
          ].filter(Boolean)}
          createLensComment={createLensComment}
          sessionClient={sessionClient}
          countryCode={lensProfile?.country || "EARTH"}
          dao={dao}
          onClose={() => setReportModalViolation(null)}
        />
      )}
    </Layout>
  );
};

export default ViolationsListPage;
