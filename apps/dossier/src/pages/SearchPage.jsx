// src/pages/SearchPage.jsx
import React, { useState, useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { lensClient } from "../lib/lens";
import { fetchPosts, fetchAccounts } from "@lens-protocol/client/actions";
import useLensPosts from "../hooks/useLensPosts";
import useLensViolations from "../hooks/useLensViolations";
import { useLensAuth } from "../context/LensAuthContext";
// ДОДАНО: SearchPage взагалі не перевіряв санкції/бан — жоден з
// результатів пошуку (пости/скарги/запити на допомогу) не фільтрувався.
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";
import Layout from "../components/Layout";
import useUserInfo from "../hooks/useUserInfo";
import {
  Search,
  X,
  Filter,
  User,
  FileText,
  AlertCircle,
  Globe,
  ChevronRight,
} from "lucide-react";

const APP_ID = import.meta.env.VITE_LENS_APP_ADDRESS;

// ─── Avatar URI resolver (lens:// / ar:// / ipfs:// → https://) ──────────────
// The same helper as in useLensPosts.js / useLensHelpRequests.js —
// duplicated here following the same approach used in the other hook
// files in this project (each file keeps its own copy, there's no shared
// utils module for this yet).
const resolveLensPicture = (picture) => {
  if (!picture) return null;
  if (typeof picture === "object") {
    picture =
      picture?.optimized?.uri || picture?.raw?.uri || picture?.uri || null;
    if (!picture) return null;
  }
  if (picture.startsWith("lens://"))
    return `https://api.grove.storage/${picture.replace("lens://", "")}`;
  if (picture.startsWith("ar://"))
    return `https://arweave.net/${picture.replace("ar://", "")}`;
  if (picture.startsWith("ipfs://"))
    return `https://ipfs.io/ipfs/${picture.replace("ipfs://", "")}`;
  return picture;
};

const attrVal = (attributes, key) =>
  attributes?.find((a) => a.key === key)?.value ?? "";

// ─── Local fetch+normalize for help_request posts ───────────────────────
// IMPORTANT: useLensHelpRequests.loadRequests() puts its result into the
// hook's own React state (setRequests) rather than returning it from the
// function — so for a single atomic search request (posts+complaints+
// requests+users all in one setSearchResults) the same fetch+normalize as
// in useLensHelpRequests.js is duplicated here: the same filter
// (apps/postTypes/tags) and the same result fields. If the help_request
// tag/metadata structure changes there — sync it here too.
const normalizeHelpRequestLocal = (post) => {
  const metadata = post.metadata ?? {};
  const attributes = metadata.attributes ?? [];

  const authorAddress = post.author?.address ?? null;
  const authorUsername =
    post.author?.username?.localName ??
    post.author?.address?.slice(0, 8) ??
    "anonymous";

  const typeAttr = attrVal(attributes, "type");
  const tagsArray = metadata.tags ?? [];
  const isHelpRequest =
    typeAttr === "help_request" || tagsArray.includes("help_request");

  const content = metadata.content ?? "";

  return {
    id: post.id,
    lens_post_id: post.id,
    isHelpRequest,
    description: content,
    title: content.split("\n")[0].slice(0, 100),
    country_code:
      attrVal(attributes, "country_code") || attrVal(attributes, "countryCode"),
    status: attrVal(attributes, "status") || "active",
    created_at: typeof post.timestamp === "string" ? post.timestamp : null,
    author: {
      id: authorAddress,
      unique_name: authorUsername,
      avatar_url: resolveLensPicture(post.author?.metadata?.picture) ?? null,
      wallet_address: authorAddress,
      // ДОДАНО: потрібен для computeBanState() нижче — раніше не зберігався.
      owner_address: post.author?.owner ?? null,
    },
  };
};

// ─── Normalizing a Lens Account into the "user" shape for rendering ───────────────────
// Fields (name/bio/avatar/country) are read via the same fallback chain
// as mapAccountToProfile() in useLensProfile.js — so the data in search
// results is consistent with what the profile page shows.
//
// NOTE: unlike posts/complaints/help_requests, there's not yet an
// established pattern in the project for SEARCHING accounts by text
// (fetchAccounts + filter.searchBy.localNameQuery) — useLensProfile.js
// only uses fetchAccountsAvailable (accounts for a specific wallet) and
// fetchAccount (a single account by address); no file has done a search
// across multiple accounts by name yet. Please verify that this call
// actually returns results in your version of @lens-protocol/client.
const normalizeLensAccount = (account) => {
  const metadata = account.metadata ?? {};
  const attrs = {};
  for (const attr of metadata.attributes || []) {
    attrs[attr.key] = attr.value;
  }

  return {
    id: account.address,
    unique_name: account.username?.localName || account.address?.slice(0, 8),
    avatar_url: resolveLensPicture(metadata.picture) ?? null,
    bio: metadata.bio || "",
    country: attrs.country || attrs.countryCode || attrs.Country || "",
    // ДОДАНО: потрібен для позначки "заблокований" у списку користувачів
    // нижче — послідовно з тим, як UserProfilePage.jsx показує банер,
    // а не приховує профіль повністю.
    owner_address: account.owner || null,
  };
};

const SearchPage = () => {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { userInfo, loading: userInfoLoading } = useUserInfo();
  const { sessionClient, logout: lensLogout } = useLensAuth();
  const { getCountryPosts } = useLensPosts(sessionClient);
  const { fetchViolations } = useLensViolations();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState({
    posts: [],
    complaints: [],
    helpRequests: [],
    users: [],
  });
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("all");

  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
      authMethod: userInfo.authMethod,
    });
    setLoading(false);
  }, [userInfo, userInfoLoading, navigate]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const query = params.get("q") || "";
    setSearchQuery(query);

    if (query.trim()) {
      performSearch(query);
    }
  }, [location.search]);

  const handleLogout = async () => {
    try {
      // REMOVED: supabase.auth.signOut() — Supabase Auth is no longer
      // used. Replaced with logout() from LensAuthContext.jsx: it calls
      // sessionClient.logout() (resets the Lens session) and
      // disconnect() on the wallet (wagmi), i.e. the same thing
      // BannedScreen/SettingsPage does on logout.
      await lensLogout();
      localStorage.removeItem("lens_wallet_address");
      navigate("/");
    } catch (error) {
      console.error("Logout error:", error);
      alert(t("logout_failed") || "Failed to logout");
    }
  };

  const handleCreatePost = () => {
    navigate("/create-post");
  };

  const performSearch = async (query) => {
    if (!query.trim()) {
      setSearchResults({
        posts: [],
        complaints: [],
        helpRequests: [],
        users: [],
      });
      return;
    }

    setIsLoading(true);
    try {
      const q = query.toLowerCase();

      // ДОДАНО: modActions/shieldTotalSupply вантажимо паралельно з рештою
      // пошуку — fetchAllModActions() кешується на 30с (moderationActions.js),
      // тож повторний виклик при новому пошуковому запиті майже безкоштовний.
      const modDataPromise = Promise.all([
        fetchAllModActions(),
        fetchShieldTotalSupply(),
      ]).catch((err) => {
        console.warn(
          "⚠️ Не вдалося завантажити дані модерації для пошуку:",
          err.message,
        );
        return [[], 0];
      });

      // ── Posts: the entire "hrpdao" feed (all countries), query filter applied client-side ──
      const postsResult = await getCountryPosts("EARTH");
      let posts = (postsResult.success ? postsResult.posts : []).filter(
        (p) =>
          p.content?.toLowerCase().includes(q) ||
          p.country_code?.toLowerCase().includes(q),
      );

      // ── Complaints (violations): the hook already supports text search (title/description/address) ──
      const complaintsResult = await fetchViolations({ searchQuery: query });
      let complaints = complaintsResult.success
        ? complaintsResult.violations
        : [];

      // ── Help requests: the same filter as in useLensHelpRequests ──
      let helpRequests = [];
      try {
        const helpResult = await fetchPosts(lensClient, {
          filter: {
            apps: [APP_ID],
            postTypes: ["ROOT"],
            metadata: { tags: { oneOf: ["help_request"] } },
          },
        });
        if (!helpResult.isErr()) {
          helpRequests = helpResult.value.items
            .map(normalizeHelpRequestLocal)
            .filter(
              (r) =>
                r.isHelpRequest &&
                r.status === "active" &&
                (r.title?.toLowerCase().includes(q) ||
                  r.description?.toLowerCase().includes(q) ||
                  r.country_code?.toLowerCase().includes(q)),
            );
        }
      } catch (helpErr) {
        console.error("Help requests search error:", helpErr);
      }

      // ДОДАНО: фільтруємо пости/скарги/запити за санкціями (приховано
      // модератором) і за баном автора — раніше жоден з трьох типів
      // результатів пошуку не перевірявся взагалі.
      const [modActions, shieldTotalSupply] = await modDataPromise;
      const isSanctioned = (lensPostId, ownerAddress) => {
        if (computeModerationState(modActions, lensPostId).hidden) {
          return true;
        }
        if (!ownerAddress) return false;
        return computeBanState(modActions, ownerAddress, shieldTotalSupply)
          .banned;
      };

      posts = posts.filter(
        (p) => !isSanctioned(p.lens_post_id, p.author?.owner_address),
      );
      complaints = complaints.filter(
        (c) => !isSanctioned(c.lens_post_id, c.author?.owner_address),
      );
      helpRequests = helpRequests.filter(
        (r) => !isSanctioned(r.lens_post_id, r.author?.owner_address),
      );

      // ── Users: searching for a Lens Account by name/handle ──
      // Accounts are a protocol-level Lens entity, shared across the
      // entire testnet (unlike Post, there's no apps: [APP_ID] here) — so
      // fetchAccounts finds ANY account on the network, not just HRP DAO
      // members. We deliberately do NOT filter (the app already allows
      // following/messaging any Lens account, see UserProfilePage.jsx),
      // only flagging who has actually posted in HRP DAO — the same
      // approach (Promise.all over separate fetchPosts calls per account)
      // as the report count in useLensViolations.fetchViolations.
      let users = [];
      try {
        const accountsResult = await fetchAccounts(lensClient, {
          filter: { searchBy: { localNameQuery: query } },
        });
        if (!accountsResult.isErr()) {
          const rawUsers = accountsResult.value.items.map(normalizeLensAccount);

          const membershipFlags = await Promise.all(
            rawUsers.map(async (u) => {
              try {
                const r = await fetchPosts(lensClient, {
                  filter: { authors: [u.id], apps: [APP_ID] },
                });
                return r.isErr() ? false : r.value.items.length > 0;
              } catch {
                return false;
              }
            }),
          );

          users = rawUsers.map((u, i) => ({
            ...u,
            is_app_member: membershipFlags[i],
            // ДОДАНО: позначка бану — сам акаунт не приховуємо зі списку
            // користувачів (консистентно з UserProfilePage.jsx: профіль
            // лишається видимим, банер попереджає), лише позначаємо.
            is_banned: u.owner_address
              ? computeBanState(modActions, u.owner_address, shieldTotalSupply)
                  .banned
              : false,
          }));
        }
      } catch (accErr) {
        console.error("Lens accounts search error:", accErr);
      }

      setSearchResults({ posts, complaints, helpRequests, users });
    } catch (error) {
      console.error("Search error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResults({
      posts: [],
      complaints: [],
      helpRequests: [],
      users: [],
    });
    navigate("/search");
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const currentLang = i18n.language;

    let locale = "en-US";
    if (currentLang.startsWith("uk")) locale = "uk-UA";
    else if (currentLang.startsWith("es")) locale = "es-ES";
    else if (currentLang.startsWith("fr")) locale = "fr-FR";
    else if (currentLang.startsWith("de")) locale = "de-DE";
    else if (currentLang.startsWith("zh")) locale = "zh-CN";
    else if (currentLang.startsWith("ru")) locale = "ru-RU";
    else if (currentLang.startsWith("ja")) locale = "ja-JP";

    return date.toLocaleDateString(locale, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  const getResultCount = () => {
    switch (activeTab) {
      case "posts":
        return searchResults.posts.length;
      case "complaints":
        return searchResults.complaints.length;
      case "help":
        return searchResults.helpRequests.length;
      case "users":
        return searchResults.users.length;
      default:
        return (
          searchResults.posts.length +
          searchResults.complaints.length +
          searchResults.helpRequests.length +
          searchResults.users.length
        );
    }
  };

  const renderResults = () => {
    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="w-8 h-8 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin mb-4" />
          <p className="text-[14px] text-slate-600 dark:text-white/40">
            {t("searching")}...
          </p>
        </div>
      );
    }

    if (!searchQuery.trim()) {
      return (
        <div className="text-center py-20">
          <Search className="w-16 h-16 text-slate-300 dark:text-white/[0.07] mx-auto mb-4" />
          <h3 className="font-cinzel text-[16px] font-medium text-slate-700 dark:text-white/45 mb-2">
            {t("search_placeholder")}
          </h3>
          <p className="text-[14px] text-slate-600 dark:text-white/40">
            {t("enter_search_query")}
          </p>
        </div>
      );
    }

    if (getResultCount() === 0) {
      return (
        <div className="text-center py-20">
          <AlertCircle className="w-16 h-16 text-slate-300 dark:text-white/[0.07] mx-auto mb-4" />
          <h3 className="font-cinzel text-[16px] font-medium text-slate-700 dark:text-white/45 mb-2">
            {t("no_results_found")}
          </h3>
          <p className="text-[14px] text-slate-600 dark:text-white/40">
            {t("try_different_keywords")}
          </p>
        </div>
      );
    }

    return (
      <>
        {activeTab === "all" && (
          <div className="space-y-8">
            {searchResults.posts.length > 0 && (
              <div>
                <h3 className="font-cinzel text-[11px] text-slate-600 dark:text-white/40 tracking-[0.1em] uppercase mb-4 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-slate-600 dark:text-white/40" />
                  {t("posts")} ({searchResults.posts.length})
                </h3>
                <div className="grid gap-3">
                  {searchResults.posts.map((post) => {
                    const author = post.author;
                    return (
                      <div
                        key={post.id}
                        className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-4 hover:border-slate-400 dark:hover:border-white/[0.13] hover:bg-slate-50 dark:hover:bg-[#001026] transition-all cursor-pointer"
                        onClick={() => navigate(`/post/${post.id}`)}
                      >
                        <div className="flex items-start gap-3">
                          <img
                            src={author?.avatar_url || "/default-avatar.png"}
                            alt={author?.unique_name}
                            className="w-9 h-9 rounded-full object-cover border border-slate-300 dark:border-white/[0.06]"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex justify-between items-start gap-2 mb-1.5">
                              <h4 className="text-[14px] font-medium text-slate-900 dark:text-white/70 truncate">
                                {author?.unique_name || t("anonymous")}
                              </h4>
                              <span className="text-[11px] text-slate-600 dark:text-white/40 flex-shrink-0">
                                {formatDate(post.created_at)}
                              </span>
                            </div>
                            <p className="text-[14px] text-slate-700 dark:text-white/45 line-clamp-2 leading-relaxed">
                              {post.content}
                            </p>
                            {post.country_code &&
                              post.country_code !== "EARTH" && (
                                <div className="flex items-center gap-1 mt-2 text-[11px] text-slate-600 dark:text-white/40">
                                  <Globe className="w-3 h-3" />
                                  {post.country_code}
                                </div>
                              )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {searchResults.complaints.length > 0 && (
              <div>
                <h3 className="font-cinzel text-[11px] text-slate-600 dark:text-white/40 tracking-[0.1em] uppercase mb-4 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-slate-600 dark:text-white/40" />
                  {t("complaints")} ({searchResults.complaints.length})
                </h3>
                <div className="grid gap-3">
                  {searchResults.complaints.map((complaint) => (
                    <div
                      key={complaint.id}
                      className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-4 hover:border-slate-400 dark:hover:border-white/[0.13] hover:bg-slate-50 dark:hover:bg-[#001026] transition-all cursor-pointer"
                      onClick={() => navigate(`/complaints/${complaint.id}`)}
                    >
                      <h4 className="text-[16px] font-medium text-slate-900 dark:text-white/65 mb-1.5 line-clamp-1">
                        {complaint.title}
                      </h4>
                      <p className="text-[14px] text-slate-600 dark:text-white/40 line-clamp-2 leading-relaxed mb-3">
                        {complaint.violation_description ||
                          complaint.description}
                      </p>
                      <div className="flex justify-between items-center text-[11px]">
                        <div className="flex items-center gap-3">
                          <span className="flex items-center gap-1 text-slate-600 dark:text-white/40">
                            <User className="w-3 h-3" />
                            {complaint.author?.unique_name || t("anonymous")}
                          </span>
                          {complaint.country_code && (
                            <span className="flex items-center gap-1 text-slate-600 dark:text-white/40">
                              <Globe className="w-3 h-3" />
                              {complaint.country_code}
                            </span>
                          )}
                        </div>
                        <span className="text-slate-600 dark:text-white/40">
                          {formatDate(complaint.created_at)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {searchResults.helpRequests.length > 0 && (
              <div>
                <h3 className="font-cinzel text-[11px] text-slate-600 dark:text-white/40 tracking-[0.1em] uppercase mb-4 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-slate-600 dark:text-white/40" />
                  {t("help_requests")} ({searchResults.helpRequests.length})
                </h3>
                <div className="grid gap-3">
                  {searchResults.helpRequests.map((request) => (
                    <div
                      key={request.id}
                      className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-4 hover:border-slate-400 dark:hover:border-white/[0.13] hover:bg-slate-50 dark:hover:bg-[#001026] transition-all cursor-pointer"
                      onClick={() => navigate(`/help/${request.id}`)}
                    >
                      <h4 className="text-[16px] font-medium text-slate-900 dark:text-white/65 mb-1.5 line-clamp-1">
                        {request.title}
                      </h4>
                      <p className="text-[14px] text-slate-600 dark:text-white/40 line-clamp-2 leading-relaxed mb-3">
                        {request.description}
                      </p>
                      <div className="flex justify-between items-center text-[11px]">
                        <div className="flex items-center gap-3">
                          <span className="flex items-center gap-1 text-slate-600 dark:text-white/40">
                            <User className="w-3 h-3" />
                            {request.author?.unique_name || t("anonymous")}
                          </span>
                          {request.country_code && (
                            <span className="flex items-center gap-1 text-slate-600 dark:text-white/40">
                              <Globe className="w-3 h-3" />
                              {request.country_code}
                            </span>
                          )}
                        </div>
                        <span className="text-slate-600 dark:text-white/40">
                          {formatDate(request.created_at)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {searchResults.users.length > 0 && (
              <div>
                <h3 className="font-cinzel text-[11px] text-slate-600 dark:text-white/40 tracking-[0.1em] uppercase mb-4 flex items-center gap-2">
                  <User className="w-4 h-4 text-slate-600 dark:text-white/40" />
                  {t("users")} ({searchResults.users.length})
                </h3>
                <div className="grid gap-3">
                  {searchResults.users.map((user) => (
                    <div
                      key={user.id}
                      className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-4 hover:border-slate-400 dark:hover:border-white/[0.13] hover:bg-slate-50 dark:hover:bg-[#001026] transition-all cursor-pointer"
                      onClick={() => navigate(`/user/${user.id}`)}
                    >
                      <div className="flex items-center gap-3">
                        <img
                          src={user.avatar_url || "/default-avatar.png"}
                          alt={user.unique_name}
                          className="w-11 h-11 rounded-full object-cover border border-slate-300 dark:border-white/[0.06]"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h4 className="text-[16px] font-medium text-slate-900 dark:text-white/70 truncate">
                              {user.unique_name}
                            </h4>
                            {user.is_app_member && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-300 dark:border-emerald-700/30 text-emerald-700 dark:text-emerald-400/80 whitespace-nowrap">
                                {t("hrp_member") || "HRP DAO"}
                              </span>
                            )}
                          </div>
                          {user.bio && (
                            <p className="text-[14px] text-slate-600 dark:text-white/40 mt-0.5 line-clamp-1">
                              {user.bio}
                            </p>
                          )}
                          {user.country && (
                            <div className="flex items-center gap-1 mt-1 text-[11px] text-slate-600 dark:text-white/40">
                              <Globe className="w-3 h-3" />
                              {user.country}
                            </div>
                          )}
                        </div>
                        <ChevronRight className="w-4 h-4 text-slate-500 dark:text-white/40" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab !== "all" && (
          <div className="space-y-3">
            {searchResults[activeTab]?.map((item) => {
              if (activeTab === "posts") {
                const author = item.author;
                return (
                  <div
                    key={item.id}
                    className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-4 hover:border-slate-400 dark:hover:border-white/[0.13] hover:bg-slate-50 dark:hover:bg-[#001026] transition-all cursor-pointer"
                    onClick={() => navigate(`/post/${item.id}`)}
                  >
                    <div className="flex items-start gap-3">
                      <img
                        src={author?.avatar_url || "/default-avatar.png"}
                        alt={author?.unique_name}
                        className="w-9 h-9 rounded-full object-cover border border-slate-300 dark:border-white/[0.06]"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex justify-between items-start gap-2 mb-1.5">
                          <h4 className="text-[14px] font-medium text-slate-900 dark:text-white/70 truncate">
                            {author?.unique_name || t("anonymous")}
                          </h4>
                          <span className="text-[11px] text-slate-600 dark:text-white/40 flex-shrink-0">
                            {formatDate(item.created_at)}
                          </span>
                        </div>
                        <p className="text-[14px] text-slate-700 dark:text-white/45 line-clamp-2 leading-relaxed">
                          {item.content}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              }

              if (activeTab === "users") {
                return (
                  <div
                    key={item.id}
                    className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-4 hover:border-slate-400 dark:hover:border-white/[0.13] hover:bg-slate-50 dark:hover:bg-[#001026] transition-all cursor-pointer"
                    onClick={() => navigate(`/user/${item.id}`)}
                  >
                    <div className="flex items-center gap-3">
                      <img
                        src={item.avatar_url || "/default-avatar.png"}
                        alt={item.unique_name}
                        className="w-11 h-11 rounded-full object-cover border border-slate-300 dark:border-white/[0.06]"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <h4 className="text-[16px] font-medium text-slate-900 dark:text-white/70 truncate">
                            {item.unique_name}
                          </h4>
                          {item.is_app_member && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-300 dark:border-emerald-700/30 text-emerald-700 dark:text-emerald-400/80 whitespace-nowrap">
                              {t("hrp_member") || "HRP DAO"}
                            </span>
                          )}
                          {item.is_banned && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-50 dark:bg-red-500/[0.08] border border-red-300 dark:border-red-500/25 text-red-700 dark:text-red-400/80 whitespace-nowrap">
                              {t("banned") || "Заблоковано"}
                            </span>
                          )}
                        </div>
                        {item.bio && (
                          <p className="text-[14px] text-slate-600 dark:text-white/40 mt-0.5 line-clamp-1">
                            {item.bio}
                          </p>
                        )}
                        {item.country && (
                          <div className="flex items-center gap-1 mt-1 text-[11px] text-slate-600 dark:text-white/40">
                            <Globe className="w-3 h-3" />
                            {item.country}
                          </div>
                        )}
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-500 dark:text-white/40" />
                    </div>
                  </div>
                );
              }

              return (
                <div
                  key={item.id}
                  className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-4 hover:border-slate-400 dark:hover:border-white/[0.13] hover:bg-slate-50 dark:hover:bg-[#001026] transition-all cursor-pointer"
                  onClick={() =>
                    navigate(
                      activeTab === "complaints"
                        ? `/complaints/${item.id}`
                        : `/help/${item.id}`,
                    )
                  }
                >
                  <h4 className="text-[16px] font-medium text-slate-900 dark:text-white/65 mb-1.5 line-clamp-1">
                    {item.title}
                  </h4>
                  <p className="text-[14px] text-slate-600 dark:text-white/40 line-clamp-2 leading-relaxed mb-3">
                    {item.violation_description || item.description}
                  </p>
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="text-slate-600 dark:text-white/40">
                      {item.author?.unique_name || t("anonymous")}
                    </span>
                    <span className="text-slate-600 dark:text-white/40">
                      {formatDate(item.created_at)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  };

  const tabs = [
    { id: "all", label: t("all") },
    { id: "posts", label: t("posts") },
    { id: "complaints", label: t("complaints") },
    { id: "help", label: t("help_requests") },
    { id: "users", label: t("users") },
  ];

  return (
    <Layout
      userProfile={userProfile}
      onLogout={handleLogout}
      loading={loading}
      error={error}
      walletAddress={userInfo?.wallet_address}
      onCreatePost={handleCreatePost}
    >
      <div>
        <div className="sticky top-0 z-40 bg-white dark:bg-[#000d1f] border-b border-slate-300 dark:border-white/[0.06]">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
            <div className="flex items-center gap-3">
              <button
                onClick={() => navigate(-1)}
                className="p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors"
              >
                <X className="w-4 h-4 text-slate-600 dark:text-white/40" />
              </button>

              <form onSubmit={handleSearchSubmit} className="flex-1">
                <div className="relative">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t("search_placeholder")}
                    className="w-full h-[42px] pl-11 pr-10 bg-slate-50 dark:bg-white/[0.04] border border-slate-300 dark:border-white/[0.08] text-slate-900 dark:text-white/70 placeholder-slate-400 dark:placeholder-white/[0.18] rounded-xl focus:outline-none focus:border-blue-500/35 focus:bg-white dark:focus:bg-white/[0.06] transition-all text-[16px]"
                    autoFocus
                  />
                  <Search className="absolute left-3.5 top-1/2 transform -translate-y-1/2 w-4 h-4 text-slate-600 dark:text-white/40" />
                  {searchQuery && (
                    <button
                      type="button"
                      onClick={clearSearch}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-colors"
                    >
                      <X className="w-3.5 h-3.5 text-slate-600 dark:text-white/40" />
                    </button>
                  )}
                </div>
              </form>
            </div>

            <div className="mt-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 overflow-x-auto pb-1.5">
                  {tabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`px-4 py-1.5 rounded-full whitespace-nowrap transition-all text-[14px] font-medium ${
                        activeTab === tab.id
                          ? "bg-blue-600/20 text-blue-400/80 border border-blue-500/20"
                          : "text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/60 hover:bg-slate-100 dark:hover:bg-white/[0.04] border border-transparent"
                      }`}
                    >
                      {tab.label}
                      {tab.id !== "all" &&
                        searchResults[tab.id]?.length > 0 && (
                          <span className="ml-1.5 text-[11px] opacity-60">
                            ({searchResults[tab.id].length})
                          </span>
                        )}
                    </button>
                  ))}
                </div>

                <button
                  className="p-2 rounded-lg border border-slate-300 dark:border-white/[0.06] hover:bg-white/[0.04] transition-colors"
                  title={t("filters")}
                >
                  <Filter className="w-4 h-4 text-slate-600 dark:text-white/40" />
                </button>
              </div>

              {searchQuery.trim() && (
                <div className="mt-3 text-[14px] text-slate-600 dark:text-white/40">
                  {isLoading ? (
                    <span>{t("searching")}...</span>
                  ) : (
                    <span>
                      {t("found")}{" "}
                      <span className="text-slate-600 dark:text-white/40">
                        {getResultCount()}
                      </span>{" "}
                      {t("results_for")} "
                      <span className="text-slate-600 dark:text-white/40">
                        {searchQuery}
                      </span>
                      "
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          {renderResults()}
        </div>
      </div>
    </Layout>
  );
};

export default SearchPage;
