// src/pages/SupportPage.jsx
// ✅ Повністю мігровано на Lens Protocol (canary v3)
// Прибрано: Supabase, EditHelpRequestModal, функція редагування
// Залишено: перегляд, створення, видалення через Lens

import React, { useEffect, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Search,
  Filter,
  Share2,
  Trash2,
  Flag,
  Globe,
  Calendar,
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
  Plus,
} from "lucide-react";
import { useDisconnect, useWalletClient } from "wagmi";
import Layout from "../components/Layout";
import { useNavigate } from "react-router-dom";
import useUserInfo from "../hooks/useUserInfo";
import countries from "../utils/countries";
import CreateHelpRequestModal from "../components/CreateHelpRequestModal";
import CreatePostModal from "../components/CreatePostModal";
import { useLensHelpRequests } from "../hooks/useLensHelpRequests";
import { useLensProfile } from "../hooks/useLensProfile";
// ДОДАНО: той самий флоу скарг/модерації, що на HelpRequestPage.jsx —
// раніше "Поскаржитись" тут був alert()-заглушкою, а блюр/приховати з
// ModerationQueue.jsx взагалі не рахувались на цій сторінці. Без окремих
// hook/component файлів — усе прямо тут.
import { useLensAuth } from "../context/LensAuthContext";
import { useLensDAO } from "../hooks/useLensDAO";
import ReportModal from "../components/ReportModal";
import useLensPosts from "../hooks/useLensPosts";
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";
// ДОДАНО: скарги - потрібні для автокарантину (той самий підхід, що вже
// в CountryFeed.jsx/ViolationsListPage.jsx/ModerationQueue.jsx).
import { fetchAllReportComments } from "../utils/postReports";
import { EyeOff, ShieldAlert } from "lucide-react";

const SupportPage = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient();
  // Адреса гаманця, яким залогінені в Lens (та сама конвенція, що в
  // CountryFeed.jsx/PostPage.jsx/CreatePostModal.jsx).
  const lensWalletAddress = localStorage.getItem("lens_wallet_address");
  const { profile: lensProfile } = useLensProfile(lensWalletAddress);

  const { userInfo, loading: userInfoLoading } = useUserInfo();

  // ДОДАНО: потрібні для скарги (ReportModal) — той самий набір, що на
  // HelpRequestPage.jsx.
  // FIXED: this destructure was missing getWalletClient — useLensPosts()
  // below therefore ALWAYS got null for it, so createLensComment's
  // resolvedClient was always null and reporting a help-request post
  // failed with "Wallet not connected" unconditionally, regardless of
  // the wallet actually being connected. Same fix as PostPage.jsx.
  const { sessionClient, getWalletClient } = useLensAuth();
  const dao = useLensDAO();
  const { createLensComment } = useLensPosts(sessionClient, getWalletClient);

  const [reportModalRequest, setReportModalRequest] = useState(null);

  // ДОДАНО: один спільний fetchAllModActions() на всю сторінку (а не по
  // одному на кожен запит у списку).
  const [modActions, setModActions] = useState([]);
  // ДОДАНО: скарги, окремо від дій модерації - потрібні для автокарантину.
  const [reports, setReports] = useState([]);
  // ДОДАНО: totalSupply() Shield SBT напряму з блокчейну (той самий фікс,
  // що в ViolationsListPage.jsx/CountryFeed.jsx/FollowingPage.jsx) —
  // dao.shieldInfo?.totalSupply заповнюється лише після dao.connect(),
  // без якого computeBanState() нижче завжди вважав кворум за 0%.
  const [shieldTotalSupply, setShieldTotalSupply] = useState(0);
  // ДОДАНО: доки modActions/shieldTotalSupply ще не завантажені (а самі
  // запити могли завантажитись швидше і вже відрендерились) — запити
  // забаненого автора на мить показувались без фільтра. modReady тримає
  // список у стані завантаження, доки санкції не прораховані хоча б раз.
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

  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filteredRequests, setFilteredRequests] = useState([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);

  // Фільтри
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCountry, setSelectedCountry] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showOwnRequests, setShowOwnRequests] = useState(false);
  // ДОДАНО: панель додаткових фільтрів (країна/дати/мої запити) згорнута
  // за замовчуванням — завжди видимим лишається лише пошук, щоб не займати
  // зайвий простір на сторінці.
  const [filtersOpen, setFiltersOpen] = useState(false);

  // ✅ Lens хук — передаємо lensClient з useUserInfo або окремо
  const {
    requests,
    loading: requestsLoading,
    loadRequests,
    createRequest,
    deleteRequest,
  } = useLensHelpRequests();

  // ВИПРАВЛЕНО (2): попередній фікс брав myWalletAddress з EOA-джерел
  // (walletClient.account.address / lensProfile.address / lens_wallet_address)
  // у такому порядку, що першим майже завжди підставлявся саме EOA-гаманець.
  // А request.author.wallet_address — це post.author.address, тобто адреса
  // Lens ACCOUNT (смартконтракту), яка в Lens v2/v3 ВІДРІЗНЯЄТЬСЯ від
  // EOA-гаманця власника. Через це збіг або був випадковим (коли walletClient
  // ще не встиг підвантажитись і використовувався lensProfile.address), або
  // не працював зовсім. LensAuthContext.loginWithAccount() зберігає правильну
  // адресу окремо — localStorage.lens_account_address — її і ставимо першою.
  const myAccountAddress =
    localStorage.getItem("lens_account_address") ||
    lensProfile?.address ||
    walletClient?.account?.address ||
    lensWalletAddress ||
    null;

  const getAuthorWalletAddress = (request) =>
    request.author?.wallet_address || request.lens_user_id || null;

  const isOwnRequest = (request) => {
    const authorAddress = getAuthorWalletAddress(request);
    return (
      !!myAccountAddress &&
      !!authorAddress &&
      authorAddress.toLowerCase() === myAccountAddress.toLowerCase()
    );
  };

  // Типи допомоги — форма як у бейджа пріоритету (rounded-full, без бордера),
  // колір ЗЕЛЕНИЙ як у RightSidebar (greenBg, greenBd, green)
  const helpTypeCls =
    "text-emerald-700 bg-emerald-100 dark:text-emerald-400/80 dark:bg-emerald-400/10";
  const helpTypes = [
    {
      id: "financial",
      icon: Heart,
      cls: helpTypeCls,
    },
    {
      id: "psychological",
      icon: Brain,
      cls: helpTypeCls,
    },
    {
      id: "physical",
      icon: HandHeart,
      cls: helpTypeCls,
    },
    {
      id: "medical",
      icon: Pill,
      cls: helpTypeCls,
    },
    {
      id: "educational",
      icon: BookOpen,
      cls: helpTypeCls,
    },
    {
      id: "housing",
      icon: Home,
      cls: helpTypeCls,
    },
    {
      id: "food",
      icon: Utensils,
      cls: helpTypeCls,
    },
    {
      id: "clothing",
      icon: Shirt,
      cls: helpTypeCls,
    },
    {
      id: "legal",
      icon: Scale,
      cls: helpTypeCls,
    },
    {
      id: "employment",
      icon: Briefcase,
      cls: helpTypeCls,
    },
  ];

  // ── Ефекти ──────────────────────────────────────────────────────────────────

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
      has_completed_onboarding: userInfo.hasCompletedOnboarding,
      authMethod: "lens",
    });
    setLoading(false);
  }, [userInfo, userInfoLoading, navigate]);

  useEffect(() => {
    if (userProfile) {
      loadRequests({ countryCode: selectedCountry });
    }
  }, [userProfile]);

  useEffect(() => {
    applyFilters();
  }, [requests, searchQuery, dateFrom, dateTo, showOwnRequests]);

  // ── Фільтрація ───────────────────────────────────────────────────────────────

  const applyFilters = useCallback(() => {
    let filtered = [...requests];

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (r) =>
          r.description?.toLowerCase().includes(q) ||
          r.title?.toLowerCase().includes(q) ||
          r.author?.unique_name?.toLowerCase().includes(q),
      );
    }

    if (dateFrom) {
      const from = new Date(dateFrom);
      filtered = filtered.filter((r) => new Date(r.created_at) >= from);
    }

    if (dateTo) {
      const to = new Date(dateTo);
      to.setHours(23, 59, 59, 999);
      filtered = filtered.filter((r) => new Date(r.created_at) <= to);
    }

    if (showOwnRequests) {
      filtered = filtered.filter((r) => isOwnRequest(r));
    }

    setFilteredRequests(filtered);
  }, [
    requests,
    searchQuery,
    dateFrom,
    dateTo,
    showOwnRequests,
    myAccountAddress,
  ]);

  // ── Actions ──────────────────────────────────────────────────────────────────

  const handleLogout = () => {
    localStorage.removeItem("lens_wallet_address");
    disconnect();
    navigate("/");
  };

  const handleDeleteRequest = async (requestId) => {
    if (deleteConfirmId !== requestId) {
      setDeleteConfirmId(requestId);
      setTimeout(() => setDeleteConfirmId(null), 4000);
      return;
    }
    setDeleteConfirmId(null);

    try {
      await deleteRequest(requestId);
    } catch (err) {
      console.error("Error deleting request:", err);
      setError(t("delete_failed") || "Помилка видалення");
    }
  };

  // ЗМІНЕНО: раніше alert()-заглушка. Тепер той самий флоу, що на
  // HelpRequestPage.jsx.
  const handleReportRequest = async (request) => {
    if (!dao.account) {
      const res = await dao.connect();
      if (!res?.success) {
        alert("Для подання скарги потрібно підключити гаманець.");
        return;
      }
    }
    setReportModalRequest(request);
  };

  const shareRequest = (request) => {
    const url = `${window.location.origin}/help/${request.id}`;
    if (navigator.share) {
      navigator.share({
        title: request.title,
        text: request.description?.slice(0, 100),
        url,
      });
    } else {
      navigator.clipboard.writeText(url);
    }
  };

  const handleCreateSuccess = () => {
    setShowCreateModal(false);
    loadRequests({ countryCode: selectedCountry });
  };

  const resetFilters = () => {
    setSearchQuery("");
    setSelectedCountry("all");
    setDateFrom("");
    setDateTo("");
    setShowOwnRequests(false);
  };

  // ДОДАНО: кількість активних додаткових фільтрів (без урахування пошуку,
  // бо він завжди на видноті) — показуємо бейджем на кнопці-перемикачі.
  const activeExtraFiltersCount = [
    selectedCountry !== "all",
    !!dateFrom,
    !!dateTo,
    showOwnRequests,
  ].filter(Boolean).length;

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const getCountryName = (code) => {
    const country = countries.find((c) => c.code === code);
    if (!country) return code;
    const lang = i18n.language.split("-")[0] || "en";
    const supported = [
      "en",
      "uk",
      "es",
      "fr",
      "de",
      "zh",
      "hi",
      "ar",
      "pt",
      "ru",
      "ja",
    ];
    const l = supported.includes(lang) ? lang : "en";
    return country.name[l] || country.name.en || code;
  };

  const formatDate = (dateString) => {
    if (!dateString) return "";
    const date = new Date(dateString);
    const lang = i18n.language;
    const localeMap = {
      uk: "uk-UA",
      es: "es-ES",
      fr: "fr-FR",
      de: "de-DE",
      zh: "zh-CN",
      ru: "ru-RU",
      ja: "ja-JP",
    };
    const locale = localeMap[lang.split("-")[0]] ?? "en-US";
    return date.toLocaleDateString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  const formatTime = (dateString) => {
    if (!dateString) return "";
    const date = new Date(dateString);
    const lang = i18n.language;
    const localeMap = {
      uk: "uk-UA",
      es: "es-ES",
      fr: "fr-FR",
      de: "de-DE",
      zh: "zh-CN",
      ru: "ru-RU",
      ja: "ja-JP",
    };
    const locale = localeMap[lang.split("-")[0]] ?? "en-US";
    return date.toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // ── Loading / Error screens ───────────────────────────────────────────────────

  if (loading || userInfoLoading) {
    return (
      <Layout
        userProfile={userProfile}
        onLogout={handleLogout}
        loading={true}
        error={error}
        onCreatePost={() => setShowCreatePostModal(true)}
      >
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin" />
        </div>
      </Layout>
    );
  }

  if (error) {
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
            <AlertCircle className="w-10 h-10 text-red-400 dark:text-red-400/50 mx-auto mb-3" />
            <p className="text-[16px] text-red-600 dark:text-red-400/70">
              {error}
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  // ── Main render ───────────────────────────────────────────────────────────────

  return (
    <Layout
      userProfile={userProfile}
      onLogout={handleLogout}
      loading={loading}
      error={error}
      onCreatePost={() => setShowCreatePostModal(true)}
    >
      {/* Create post modal */}
      {showCreatePostModal && userProfile && (
        <div className="h-full">
          <CreatePostModal
            onClose={() => setShowCreatePostModal(false)}
            userCountry={userInfo?.country || "EARTH"}
          />
        </div>
      )}

      {/* ✅ Create help request modal */}
      {showCreateModal && userProfile && !showCreatePostModal && (
        <CreateHelpRequestModal
          userProfile={userProfile}
          createRequest={createRequest}
          onClose={() => setShowCreateModal(false)}
          onSuccess={handleCreateSuccess}
        />
      )}

      {/* Main page */}
      {!showCreateModal && !showCreatePostModal && (
        <div className="pt-3 pb-3 px-0 lg:p-4">
          {/* Header */}
          <div className="flex items-start justify-between gap-3 mb-5 pb-4 border-b border-slate-300 dark:border-white/[0.06]">
            <div>
              <h1 className="font-cinzel text-[19px] font-medium text-slate-900 dark:text-white/85 tracking-[0.04em] flex items-center gap-2">
                {t("support_requests") || "Запити підтримки"}
              </h1>
            </div>
            <button
              onClick={() => setShowCreateModal(true)}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg
              bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35
              dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:hover:bg-[#3D0012] transition-colors flex-shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              {t("create_request") || "Створити запит"}
            </button>
          </div>

          {/* Filters */}
          {/* ЗМІНЕНО: пошук лишається завжди видимим (найчастіша дія),
              решта фільтрів (країна/дати/мої запити/скинути) згорнута за
              замовчуванням і розкривається кнопкою-перемикачем з бейджем
              кількості активних фільтрів — щоб не займати місце на сторінці. */}
          <div className="mb-3">
            <div className="flex gap-2">
              {/* Search — завжди видимий */}
              <div className="relative flex-1 min-w-[160px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-600 dark:text-white/40 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("search_requests") || "Пошук запитів..."}
                  className="w-full h-[38px] pl-9 pr-3 bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[16px] text-slate-900 dark:text-white/65 placeholder-slate-400 dark:placeholder-white/[0.25] font-['Inter'] outline-none focus:border-blue-500/35 transition-all"
                />
              </div>

              {/* Кнопка-перемикач панелі додаткових фільтрів */}
              <button
                onClick={() => setFiltersOpen((prev) => !prev)}
                aria-expanded={filtersOpen}
                title={t("filters") || "Фільтри"}
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
              <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-3 mt-2 space-y-2">
                <div className="flex gap-2 flex-wrap">
                  {/* Country */}
                  <select
                    value={selectedCountry}
                    onChange={(e) => {
                      setSelectedCountry(e.target.value);
                      loadRequests({ countryCode: e.target.value });
                    }}
                    className="h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-600 dark:text-white/45 font-['Inter'] outline-none focus:border-blue-500/35 transition-all min-w-[120px] flex-shrink-0 appearance-none"
                  >
                    <option value="all">
                      {t("all_countries") || "Всі країни"}
                    </option>
                    <option value="EARTH">
                      {t("planet_earth") || "Планета Земля"}
                    </option>
                    {countries
                      .filter((c) => c.code !== "EARTH")
                      .map((country) => (
                        <option key={country.code} value={country.code}>
                          {getCountryName(country.code)}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="flex gap-2 flex-wrap items-center">
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-800 dark:text-white/45 font-['Inter'] outline-none focus:border-blue-500/35 transition-all w-[130px] [color-scheme:light] dark:[color-scheme:dark]"
                  />
                  <span className="text-slate-600 dark:text-white/40 text-[14px] flex-shrink-0">
                    —
                  </span>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="h-[38px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-800 dark:text-white/45 font-['Inter'] outline-none focus:border-blue-500/35 transition-all w-[130px] [color-scheme:light] dark:[color-scheme:dark]"
                  />

                  <button
                    onClick={() => setShowOwnRequests(!showOwnRequests)}
                    className={`flex items-center gap-1.5 h-[38px] px-3 rounded-lg text-[14px] border transition-all ${
                      showOwnRequests
                        ? "border-blue-500/40 bg-blue-900/15 text-blue-400/85"
                        : "border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/45 hover:border-slate-400 dark:hover:border-white/[0.15]"
                    }`}
                  >
                    <Filter className="w-3 h-3" />
                    {t("my_requests") || "Мої запити"}
                  </button>

                  <button
                    onClick={resetFilters}
                    className="ml-auto flex items-center gap-1.5 h-[38px] px-3 rounded-lg text-[14px] border border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/45 hover:border-slate-400 dark:hover:border-white/[0.15] transition-all"
                  >
                    {t("reset_filters") || "Скинути"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Requests list */}
          <div className="space-y-3">
            {requestsLoading || !modReady ? (
              <div className="flex flex-col items-center py-10">
                <div className="w-7 h-7 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin mb-3" />
                <p className="text-[14px] text-slate-600 dark:text-white/40">
                  {t("loading_requests") || "Завантаження запитів..."}
                </p>
              </div>
            ) : filteredRequests.length === 0 ? (
              <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.06] rounded-xl p-10 text-center">
                <AlertCircle className="w-10 h-10 text-slate-300 dark:text-white/[0.07] mx-auto mb-3" />
                <h3 className="font-cinzel text-[16px] text-slate-700 dark:text-white/40 mb-1">
                  {t("no_requests_found") || "Запитів не знайдено"}
                </h3>
                <p className="text-[14px] text-slate-600 dark:text-white/40 max-w-xs mx-auto mb-4">
                  {t("no_requests_description") ||
                    "Спробуйте змінити фільтри або створіть перший запит"}
                </p>
              </div>
            ) : (
              filteredRequests.map((request) => {
                const isOwner = isOwnRequest(request);
                const hasAttachments = request.attachments?.length > 0;
                const author = request.author;

                // Отримуємо ім'я та handle (як у CountryFeed)
                const authorName =
                  author?.name || author?.unique_name || t("anonymous");
                const authorHandle = author?.unique_name
                  ? `@${author.unique_name}`
                  : null;

                // ДОДАНО: стан модерації для цього конкретного запиту,
                // рахований зі спільного modActions (один fetch на всю
                // сторінку, не по одному на кожен запит).
                const modState = computeModerationState(
                  modActions,
                  request.lens_post_id,
                  { reports },
                );
                const isCritical = modState.hiddenReason === "critical";

                // ДОДАНО: запити авторів, чий акаунт забанено голосуванням,
                // взагалі не показуємо — раніше ця сторінка перевіряла
                // лише hide/blur, але не бан автора.
                const banState = author?.owner_address
                  ? computeBanState(
                      modActions,
                      author.owner_address,
                      shieldTotalSupply,
                    )
                  : null;
                if (banState?.banned) return null;

                return (
                  <div
                    key={request.id}
                    onClick={() => navigate(`/help/${request.id}`)}
                    className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl px-4 pt-3.5 pb-3 cursor-pointer transition-all duration-150 hover:border-slate-300 dark:hover:border-white/[0.13] hover:bg-slate-50 dark:hover:bg-[#001026]"
                  >
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="flex-1 min-w-0">
                        {/* Автор + країна + дата з аватаркою у вигляді ромба (як у CountryFeed) */}
                        <div className="flex items-center gap-2.5 flex-wrap">
                          {/* Аватарка у формі ромба (шестикутник) */}
                          <div className="relative flex-shrink-0">
                            <div
                              className="relative w-[40px] h-[44px] p-[1.5px] clip-path-hexagon
                                bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]"
                            >
                              <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon">
                                {author?.avatar_url ? (
                                  <img
                                    src={author.avatar_url}
                                    alt={authorName}
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
                                    ${author?.avatar_url ? "hidden" : "flex"}
                                  `}
                                >
                                  {authorName?.[0]?.toUpperCase() || "U"}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Ім'я + @handle (як у CountryFeed) */}
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-[16px] font-medium text-slate-900 dark:text-white/65">
                              {authorName}
                            </span>
                            {authorHandle && (
                              <span className="text-[13px] text-slate-600 dark:text-white/40 flex-shrink-0">
                                {authorHandle}
                              </span>
                            )}
                          </div>

                          <div className="text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/15 border border-blue-300/60 dark:border-blue-700/20 text-blue-800 dark:text-blue-400/65 inline-flex items-center gap-1">
                            <Globe className="w-2.5 h-2.5" />
                            {getCountryName(request.country_code)}
                          </div>
                        </div>

                        {/* Дата та час — окремий рядок (розмір як у PostCard) */}
                        <div className="flex items-center gap-1 mt-1.5 text-[10px] text-slate-600 dark:text-white/40">
                          <Calendar className="w-3 h-3 text-slate-600 dark:text-white/40" />
                          <span>
                            {formatDate(request.created_at)} ·{" "}
                            {formatTime(request.created_at)}
                          </span>
                        </div>
                      </div>

                      {/* Action buttons */}
                      <div
                        className="flex items-center gap-1 flex-shrink-0 relative"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            shareRequest(request);
                          }}
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/65 hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-all"
                          title={t("share")}
                        >
                          <Share2 className="w-3.5 h-3.5" />
                        </button>

                        {isOwner ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteRequest(request.id);
                            }}
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-600 dark:text-white/40 hover:text-red-600 dark:hover:text-red-400/80 hover:bg-red-50 dark:hover:bg-red-500/[0.08] transition-all"
                            title={t("delete")}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleReportRequest(request);
                            }}
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-600 dark:text-white/40 hover:text-red-600 dark:hover:text-red-400/80 hover:bg-red-50 dark:hover:bg-red-500/[0.08] transition-all"
                            title={t("report") || "Поскаржитись"}
                          >
                            <Flag className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {/* Delete confirmation */}
                        {isOwner && deleteConfirmId === request.id && (
                          <div className="absolute top-full right-0 mt-1 z-10 bg-white dark:bg-[#1a0505] border border-red-300 dark:border-red-800/35 rounded-xl p-3 w-52 shadow-[0_8px_24px_rgba(0,0,0,0.15)] dark:shadow-[0_8px_24px_rgba(0,0,0,0.5)]">
                            <p className="text-[14px] text-red-700 dark:text-red-400/85 mb-2.5">
                              {t("confirm_delete_request") ||
                                "Підтвердити видалення?"}
                            </p>
                            <div className="flex gap-2">
                              <button
                                onClick={() => handleDeleteRequest(request.id)}
                                className="flex-1 py-1.5 text-[14px] bg-red-600 dark:bg-red-900/25 border border-red-700 dark:border-red-700/30 text-white dark:text-red-400/80 rounded-lg hover:bg-red-700 dark:hover:bg-red-900/40 transition-colors"
                              >
                                {t("delete")}
                              </button>
                              <button
                                onClick={() => setDeleteConfirmId(null)}
                                className="flex-1 py-1.5 text-[14px] bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.08] text-slate-700 dark:text-white/45 rounded-lg hover:bg-slate-200 dark:hover:bg-white/[0.06] transition-colors"
                              >
                                {t("cancel")}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* ЗМІНЕНО: контент тепер або звичайно, або
                        заблюреним/прихованим — залежно від
                        computeModerationState() для цього елемента. */}
                    {modState.hidden ? (
                      <div
                        className={`flex items-center gap-2 py-2 px-3 rounded-lg border ${
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
                            ? "Вміст приховано модератором (критична категорія)"
                            : "Вміст приховано модератором"}
                        </p>
                      </div>
                    ) : (
                      <div
                        className={
                          modState.blurred
                            ? "relative rounded-lg overflow-hidden"
                            : undefined
                        }
                      >
                        <div
                          className={
                            modState.blurred
                              ? "pointer-events-none select-none blur-md opacity-60"
                              : undefined
                          }
                        >
                          {/* Help types — форма пілюлі як у бейджа пріоритету, колір зелений як у RightSidebar */}
                          <div className="flex flex-wrap gap-1.5 mb-2">
                            {request.help_types?.slice(0, 3).map((typeId) => {
                              const type = helpTypes.find(
                                (h) => h.id === typeId,
                              );
                              if (!type) return null;
                              const Icon = type.icon;
                              return (
                                <span
                                  key={typeId}
                                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${type.cls}`}
                                >
                                  <Icon className="w-2.5 h-2.5" />
                                  {t(`help_type_${typeId}`) || typeId}
                                </span>
                              );
                            })}
                            {request.help_types?.length > 3 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-100 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-400/80">
                                +{request.help_types.length - 3}
                              </span>
                            )}
                          </div>

                          {/* Description preview */}
                          <p className="text-[15px] text-slate-700 dark:text-white/45 line-clamp-2 leading-relaxed mb-3">
                            {request.description}
                          </p>

                          {/* Footer */}
                          {hasAttachments && (
                            <div className="flex flex-wrap items-center gap-3 pt-2 mt-2 border-t border-slate-200 dark:border-white/[0.05]">
                              <span className="flex items-center gap-1.5 text-[12px] text-slate-600 dark:text-white/40">
                                <File className="w-3 h-3" />
                                {request.attachments.length}{" "}
                                {t("files") || "файлів"}
                              </span>
                            </div>
                          )}
                        </div>
                        {modState.blurred && (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-black/10 dark:bg-black/30">
                            <EyeOff className="w-4 h-4 text-slate-600 dark:text-white/70" />
                            <p className="text-[11px] text-slate-700 dark:text-white/80 font-medium">
                              Вміст позначено модератором як чутливий
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* ДОДАНО: скарга на запит про допомогу зі списку */}
      {reportModalRequest && (
        <ReportModal
          post={{
            id: reportModalRequest.id,
            lens_post_id: reportModalRequest.lens_post_id,
            content: reportModalRequest.description,
            media_urls: reportModalRequest.attachments || [],
            media_types: [],
          }}
          authorAddress={getAuthorWalletAddress(reportModalRequest)}
          authorCandidates={[
            getAuthorWalletAddress(reportModalRequest),
            reportModalRequest.author?.owner_address,
          ].filter(Boolean)}
          createLensComment={createLensComment}
          sessionClient={sessionClient}
          countryCode={lensProfile?.country || "EARTH"}
          dao={dao}
          onClose={() => setReportModalRequest(null)}
        />
      )}
    </Layout>
  );
};

export default SupportPage;
