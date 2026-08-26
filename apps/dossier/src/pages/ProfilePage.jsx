// src/pages/ProfilePage.jsx
import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Edit,
  Globe,
  Wallet,
  Camera,
  Scale,
  TrendingUp,
  Shield,
  MessageSquare,
  Copy,
  Check,
} from "lucide-react";
import { useCountry } from "../hooks/useCountry";
import useUserInfo from "../hooks/useUserInfo";
import ProfileEditModal from "../components/ProfileEditModal";
import Layout from "../components/Layout";
import CountryFeed from "../components/CountryFeed";
import CreatePostModal from "../components/CreatePostModal";
import { useLensAuth } from "../context/LensAuthContext";
import {
  saveCountryRating,
  cleanupDuplicateRatingPosts,
  fetchAllMyRatingPosts,
} from "../lib/countryRatings";
// ADDED: a lightweight hook for exact followers/following counts
// (fetchAccountStats) — the same principle already used in FollowingPage.jsx.
import { useLensFollowCounts } from "../hooks/useLensFollowing";

const ProfilePage = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const {
    userInfo,
    loading: userLoading,
    error: userError,
    loadUserInfo,
  } = useUserInfo();
  const { getTranslatedCountryName } = useCountry(i18n.language);
  const { sessionClient, getWalletClient } = useLensAuth();

  // ADDED: exact following/followers counts for the badge under the
  // country name. lensAccountAddress is the Lens Smart Account (not the
  // wallet), the same address that can actually be followed.
  const { followers: followersCount, following: followingCount } =
    useLensFollowCounts(userInfo?.lensAccountAddress);

  const displayName = userInfo?.name || userInfo?.uniqueName;
  const displayHandle = userInfo?.uniqueName ? `@${userInfo.uniqueName}` : null;

  const [showEditModal, setShowEditModal] = useState(false);
  const [countryRatings, setCountryRatings] = useState(null);
  const [ratingsLoading, setRatingsLoading] = useState(false);
  const [ratingsError, setRatingsError] = useState("");
  const [isSavingRating, setIsSavingRating] = useState(false);
  const [activeRating, setActiveRating] = useState({
    human_rights: 0,
    economic_freedom: 0,
    political_freedom: 0,
    freedom_of_speech: 0,
  });
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);
  const [lensAddressCopied, setLensAddressCopied] = useState(false);

  // ADDED (race condition fix): a cached ID for one's own rating post,
  // so saveRating can immediately call editPost() without a repeated
  // (racy) lookup via fetchMyRatingPost() on every click. activeRatingRef
  // is a mirror of activeRating that updates SYNCHRONOUSLY (unlike React
  // state, which is batched), so several rapid clicks in a row get merged
  // into the correct final object instead of overwriting each other's
  // values. saveQueueRef is a promise queue: it guarantees that
  // saveCountryRating() calls execute strictly one after another, never
  // in parallel — this is the main safeguard against duplicate posts
  // (see the explanation near saveCountryRating in
  // src/lib/countryRatings.js).
  const ratingPostIdRef = useRef(null);
  const activeRatingRef = useRef({
    human_rights: 0,
    economic_freedom: 0,
    political_freedom: 0,
    freedom_of_speech: 0,
  });
  const saveQueueRef = useRef(Promise.resolve());

  // ADDED: if an account has already accumulated duplicate rating posts
  // (e.g. from before this race condition fix) — show a one-time cleanup
  // button instead of silently leaving "ghost posts" that skew the
  // country average.
  const [duplicateRatingCount, setDuplicateRatingCount] = useState(0);
  const [cleaningDuplicates, setCleaningDuplicates] = useState(false);

  // REPLACED WITH LENS: previously read from the Supabase country_ratings
  // table by (user_id, country_code). Now it's a single own Lens post
  // tagged "country_rating" (not tied to the country via a separate
  // query field — the country itself is part of the post, see
  // src/lib/countryRatings.js). If the user hasn't rated their CURRENT
  // country yet — either the post doesn't exist, or it's left over from a
  // previous country (in which case ProfileEditModal.jsx should have
  // deleted it when the country changed — but just in case, we verify
  // countryCode below rather than trusting blindly).
  const loadCountryRatings = async () => {
    if (!userInfo?.country || userInfo.country === "EARTH") {
      setCountryRatings(null);
      setActiveRating({
        human_rights: 0,
        economic_freedom: 0,
        political_freedom: 0,
        freedom_of_speech: 0,
      });
      activeRatingRef.current = {
        human_rights: 0,
        economic_freedom: 0,
        political_freedom: 0,
        freedom_of_speech: 0,
      };
      ratingPostIdRef.current = null;
      setDuplicateRatingCount(0);
      return;
    }
    setRatingsLoading(true);
    setRatingsError("");
    try {
      // ADDED: count ALL of the account's rating posts (not just the
      // first one), to detect duplicates from the race condition (see
      // src/lib/countryRatings.js) and show the cleanup button.
      const allMine = await fetchAllMyRatingPosts(userInfo.lensAccountAddress);
      setDuplicateRatingCount(Math.max(0, allMine.length - 1));

      const myPost = allMine[0] || null;
      const attrs = myPost?.metadata?.attributes || [];
      const get = (key) => {
        const a = attrs.find((x) => x.key === key);
        return a ? Number(a.value) : 0;
      };
      const postedCountry = attrs.find((a) => a.key === "countryCode")?.value;

      // The post exists, but for a DIFFERENT country (e.g. ProfileEditModal
      // hasn't managed to delete it yet when the country changed) — we
      // don't show these numbers as "my current rating", we treat it as
      // if the user hasn't rated the new country yet.
      if (myPost && postedCountry === userInfo.country) {
        setCountryRatings(myPost);
        ratingPostIdRef.current = myPost.id;
        const loaded = {
          human_rights: get("human_rights"),
          economic_freedom: get("economic_freedom"),
          political_freedom: get("political_freedom"),
          freedom_of_speech: get("freedom_of_speech"),
        };
        setActiveRating(loaded);
        activeRatingRef.current = loaded;
      } else {
        setCountryRatings(null);
        ratingPostIdRef.current = null;
        const empty = {
          human_rights: 0,
          economic_freedom: 0,
          political_freedom: 0,
          freedom_of_speech: 0,
        };
        setActiveRating(empty);
        activeRatingRef.current = empty;
      }
    } catch (error) {
      console.error("Error loading country ratings:", error);
      setRatingsError(t("ratings_load_error") || "Error loading ratings");
    } finally {
      setRatingsLoading(false);
    }
  };

  // REPLACED WITH LENS: previously an insert/update in Supabase. Now
  // every change to a single slider still writes ALL 4 values together
  // (a Lens post can't be partially updated — only the entire contentUri
  // replaced), so we take the current activeRating and only swap in the
  // field that changed before sending.
  // FIXED (race condition): previously every click on a slider
  // immediately fired off a separate async saveCountryRating() — several
  // rapid clicks (e.g. setting 10 on all 4 categories) fired parallel
  // calls that could simultaneously "fail to see" the already-created
  // post and create several duplicates (see the detailed comment near
  // saveCountryRating in src/lib/countryRatings.js). Now:
  // 1) the value is merged into activeRatingRef.current immediately
  //    (synchronously, without waiting for a React re-render) — the next
  //    click sees the freshest state, not a stale snapshot from the
  //    previous render;
  // 2) the actual network call is placed into saveQueueRef — a promise
  //    queue that performs saves STRICTLY one after another, never in parallel.
  const saveRating = (ratingType, value) => {
    if (!userInfo?.country || userInfo.country === "EARTH") return;
    if (!sessionClient) {
      setRatingsError(t("ratings_save_error") || "No active Lens session");
      return;
    }

    const previousValue = activeRatingRef.current[ratingType];
    const nextRatings = { ...activeRatingRef.current, [ratingType]: value };
    activeRatingRef.current = nextRatings;
    setActiveRating(nextRatings);
    setIsSavingRating(true);

    saveQueueRef.current = saveQueueRef.current
      .then(async () => {
        const walletClient = await getWalletClient();
        const result = await saveCountryRating({
          sessionClient,
          walletClient,
          accountAddress: userInfo.lensAccountAddress,
          countryCode: userInfo.country,
          ratings: nextRatings,
          knownPostId: ratingPostIdRef.current,
        });

        if (!result.success) throw new Error(result.error);

        // Cache the ID — once the post is created for the first time,
        // all subsequent saves will go through editPost() on that same post.
        if (result.postId) ratingPostIdRef.current = result.postId;

        setCountryRatings({ ...(countryRatings || {}), ...nextRatings });
      })
      .catch((error) => {
        console.error("Error saving rating:", error);
        // Only roll back if this field still holds the value WE just
        // set (so as not to overwrite a later click from the user that
        // has already moved further along the queue).
        if (activeRatingRef.current[ratingType] === value) {
          const rolledBack = {
            ...activeRatingRef.current,
            [ratingType]: previousValue,
          };
          activeRatingRef.current = rolledBack;
          setActiveRating(rolledBack);
        }
        setRatingsError(t("ratings_save_error") || "Error saving rating");
        setTimeout(() => setRatingsError(""), 3000);
      })
      .finally(() => {
        setIsSavingRating(false);
      });
  };

  useEffect(() => {
    if (userInfo && !userLoading) loadCountryRatings();
  }, [userInfo, userLoading]);

  // ADDED: a one-time cleanup of "ghost posts" — duplicate rating posts
  // that could have accumulated from the race condition BEFORE this fix
  // (see src/lib/countryRatings.js). Keeps the newest post, deletes the
  // rest, and immediately reloads the ratings.
  const handleCleanupDuplicates = async () => {
    if (!sessionClient) {
      setRatingsError(t("ratings_save_error") || "No active Lens session");
      return;
    }
    setCleaningDuplicates(true);
    try {
      const walletClient = await getWalletClient();
      const result = await cleanupDuplicateRatingPosts({
        sessionClient,
        walletClient,
        accountAddress: userInfo.lensAccountAddress,
      });
      if (!result.success) throw new Error(result.error);
      ratingPostIdRef.current = result.kept;
      await loadCountryRatings();
    } catch (error) {
      console.error("Error cleaning up duplicate rating posts:", error);
      setRatingsError(
        t("ratings_cleanup_error") || "Failed to remove duplicates",
      );
      setTimeout(() => setRatingsError(""), 3000);
    } finally {
      setCleaningDuplicates(false);
    }
  };

  const handleCopyLensAddress = async () => {
    if (!userInfo?.lensAccountAddress) return;
    try {
      await navigator.clipboard.writeText(userInfo.lensAccountAddress);
      setLensAddressCopied(true);
      setTimeout(() => setLensAddressCopied(false), 2000);
    } catch (err) {
      console.error("Copy address error", err);
    }
  };


  // ── Adaptive theme helpers — fonts synced with SettingsPage ────
  // 3 font sizes: 16px body text · 14px mono/meta · 11px label
  const cardBg = "bg-white dark:bg-[#000d1f]";
  const cardBorder = "border border-slate-300 dark:border-white/[0.07]";
  const bodyText = "text-slate-900 dark:text-white/60";
  const subText = "text-slate-600 dark:text-white/45";
  const labelText =
    "text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40";
  const inlineBg =
    "bg-slate-100 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.07]";
  const divider = "bg-slate-300 dark:bg-white/[0.05]";
  // ───────────────────────────────────────────────────────────────────

  const RatingLine = ({
    title,
    icon: Icon,
    ratingType,
    value,
    onRatingChange,
  }) => {
    const handleClick = (e) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(100, (x / rect.width) * 100));
      onRatingChange(ratingType, Math.ceil(percent / 10));
    };
    return (
      <div className="flex items-center gap-3">
        <div
          className={`w-7 h-7 rounded-lg ${inlineBg} flex items-center justify-center flex-shrink-0`}
        >
          <Icon className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400/50" />
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-[14px] ${subText} mb-1.5`}>{title}</div>
          <div
            className="relative h-6 flex items-center cursor-pointer group"
            onClick={handleClick}
          >
            <div className="w-full h-[3.5px] bg-slate-300 dark:bg-white/[0.07] rounded-full relative">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-700 dark:from-blue-900 to-blue-500 transition-all duration-150"
                style={{ width: `${value * 10}%` }}
              />
            </div>
            {value > 0 && (
              <div
                className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2
                  w-[13px] h-[13px] rounded-full bg-blue-500 dark:bg-blue-400
                  border-2 border-white dark:border-[#000d1f]
                  shadow-[0_0_0_2px_rgba(59,127,212,0.3)]
                  transition-all duration-150"
                style={{ left: `${value * 10}%` }}
              />
            )}
          </div>
        </div>
        <span
          className={`text-[14px] font-medium w-[40px] text-right flex-shrink-0 ${value > 0 ? "text-slate-600 dark:text-white/45" : "text-slate-500 dark:text-white/40"}`}
        >
          {value > 0 ? `${value} / 10` : "— / 10"}
        </span>
      </div>
    );
  };

  const RatingDisplay = () => {
    const ratings = [
      {
        type: "human_rights",
        title: t("human_rights_level") || "Human rights level",
        icon: Shield,
        value: activeRating.human_rights,
      },
      {
        type: "economic_freedom",
        title: t("economic_freedom_level") || "Economic freedom level",
        icon: TrendingUp,
        value: activeRating.economic_freedom,
      },
      {
        type: "political_freedom",
        title: t("political_freedom_level") || "Political freedom level",
        icon: Scale,
        value: activeRating.political_freedom,
      },
      {
        type: "freedom_of_speech",
        title: t("freedom_of_speech_level") || "Freedom of speech level",
        icon: MessageSquare,
        value: activeRating.freedom_of_speech,
      },
    ];
    return (
      <div className={`${cardBg} ${cardBorder} rounded-xl p-5`}>
        <p className="font-cinzel text-[11px] text-slate-500 dark:text-white/40 tracking-[0.1em] uppercase mb-5">
          {t("country_ratings") || "Country rating"}
          {userInfo?.country && userInfo.country !== "EARTH" && (
            <span className="ml-2 text-slate-800 dark:text-blue-400/40">
              · {getTranslatedCountryName(userInfo.country)}
            </span>
          )}
        </p>
        <div className="space-y-5">
          {ratings.map((rating) => (
            <div key={rating.type}>
              <RatingLine
                title={rating.title}
                icon={rating.icon}
                ratingType={rating.type}
                value={rating.value}
                onRatingChange={saveRating}
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  const handleCreatePost = () => setShowCreatePostModal(true);
  const handleCloseCreatePostModal = () => setShowCreatePostModal(false);

  if (showCreatePostModal && userInfo) {
    return (
      <Layout
        userProfile={userInfo}
        walletAddress={userInfo?.walletAddress}
        onLogout={() => {
          localStorage.removeItem("token");
          localStorage.removeItem("web3_wallet_address");
          window.location.href = "/";
        }}
        loading={userLoading}
        error={userError}
        onCreatePost={handleCreatePost}
      >
        <CreatePostModal
          onClose={handleCloseCreatePostModal}
          userCountry={userInfo?.country || "EARTH"}
        />
      </Layout>
    );
  }

  if (showEditModal) {
    return (
      <Layout
        userProfile={userInfo}
        walletAddress={userInfo?.walletAddress}
        onLogout={() => {
          localStorage.removeItem("token");
          localStorage.removeItem("web3_wallet_address");
          window.location.href = "/";
        }}
        loading={userLoading}
        error={userError}
        onCreatePost={handleCreatePost}
      >
        <div className="min-h-[calc(100vh-3rem)] flex items-center justify-center p-2">
          <div className="w-full max-w-2xl">
            <ProfileEditModal
              userInfo={userInfo}
              onClose={() => setShowEditModal(false)}
              onSaved={() => loadUserInfo(true)}
            />
          </div>
        </div>
      </Layout>
    );
  }

  if (userLoading) {
    return (
      <Layout
        userProfile={userInfo}
        walletAddress={userInfo?.walletAddress}
        onLogout={() => {}}
        loading={true}
        onCreatePost={handleCreatePost}
      >
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-9 h-9 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
        </div>
      </Layout>
    );
  }

  if (userError) {
    return (
      <Layout
        userProfile={userInfo}
        walletAddress={userInfo?.walletAddress}
        onLogout={() => {}}
        error={userError}
        onCreatePost={handleCreatePost}
      >
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <p className="text-[14px] text-red-500 dark:text-red-400/70 mb-3.5">
              {userError}
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-3.5 py-1.5 text-[16px] bg-[#2B000A] border border-[#b41e3c]/30 text-[#e8a0b0]/70 rounded-lg hover:bg-[#3d0012] transition-colors"
            >
              {t("retry")}
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  if (!userInfo) {
    return (
      <Layout
        userProfile={null}
        walletAddress={null}
        onLogout={() => {}}
        onCreatePost={handleCreatePost}
      >
        <div className="min-h-screen flex items-center justify-center">
          <p className={`text-[16px] ${subText}`}>{t("user_not_found")}</p>
        </div>
      </Layout>
    );
  }

  const profileContent = (
    <div className="max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-slate-300 dark:border-white/[0.06]">
        <h1 className="font-cinzel text-[19px] font-medium text-slate-950 dark:text-white/85 tracking-[0.04em]">
          {t("profile")}
        </h1>
        <button
          onClick={() => setShowEditModal(true)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg
          bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35
          dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:hover:bg-[#3D0012] transition-colors
            min-w-[140px] justify-center`}
        >
          <Edit className="w-3.5 h-3.5" />
          {t("edit_profile")}
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Avatar card */}
        <div className="lg:col-span-1">
          <div
            className={`${cardBg} ${cardBorder} rounded-xl p-6 flex flex-col items-center`}
          >
            <div className="relative mb-3.5">
              <div className="relative w-[105px] h-[117px] p-[1.5px] clip-path-hexagon bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]">
                <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon">
                  {userInfo.avatarUrl ? (
                    <img
                      src={userInfo.avatarUrl}
                      alt={displayName}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        e.target.style.display = "none";
                        const fb =
                          e.target.parentElement?.querySelector(
                            ".avatar-fallback",
                          );
                        if (fb) fb.style.display = "flex";
                      }}
                    />
                  ) : null}
                  <div
                    className={`avatar-fallback w-full h-full flex items-center justify-center font-cinzel text-[33px] text-[#c8b8a2] bg-[#0d0415] ${userInfo.avatarUrl ? "hidden" : "flex"}`}
                  >
                    {displayName?.[0]?.toUpperCase() || "U"}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setShowEditModal(true)}
                className="absolute bottom-0.5 right-0.5 w-[26px] h-[26px] rounded-full
                  bg-[#2B000A] border border-[#b41e3c]/40 flex items-center justify-center
                  hover:bg-[#3d0012] transition-colors z-10"
              >
                <Camera className="w-3 h-3 text-[#e8a0b0]/70" />
              </button>
            </div>

            <h2 className={`text-[16px] font-medium ${bodyText} mb-0.5`}>
              {displayName}
            </h2>
            {displayHandle && (
              <p className={`text-[14px] ${subText} mb-2.5`}>{displayHandle}</p>
            )}
            <span className="inline-flex items-center gap-1.5 text-[13px] px-2.5 py-1 rounded-[5px] bg-blue-100 dark:bg-blue-900/15 border border-blue-300/50 dark:border-blue-700/20 text-blue-800 dark:text-blue-400/65">
              <Globe className="w-3 h-3" />
              {getTranslatedCountryName(userInfo.country) || t("earth")}
            </span>
          </div>

          {/* ADDED: a separate card with the following/followers stats —
              pulled out from the avatar card into its own block right
              beneath it (the same cardBg/cardBorder as all the other
              cards on the page), so as not to mix "profile" badges
              (name/handle/country) with the follow-graph stats. */}
          {userInfo.lensAccountAddress && (
            <button
              onClick={() =>
                navigate(`/following/${userInfo.lensAccountAddress}`)
              }
              className={`w-full mt-3.5 ${cardBg} ${cardBorder} rounded-xl py-3.5
                flex items-center justify-center gap-0 hover:border-slate-400
                dark:hover:border-white/[0.14] transition-colors group`}
            >
              <div className="flex-1 flex flex-col items-center gap-0.5 px-2">
                <span
                  className={`text-[18px] font-semibold ${bodyText} group-hover:text-blue-600 dark:group-hover:text-blue-400/80 transition-colors`}
                >
                  {followingCount ?? "—"}
                </span>
                <span className={labelText}>
                  {t("following") || "Following"}
                </span>
              </div>

              <div className={`w-px h-9 ${divider}`} />

              <div className="flex-1 flex flex-col items-center gap-0.5 px-2">
                <span
                  className={`text-[18px] font-semibold ${bodyText} group-hover:text-blue-600 dark:group-hover:text-blue-400/80 transition-colors`}
                >
                  {followersCount ?? "—"}
                </span>
                <span className={labelText}>
                  {t("followers") || "Followers"}
                </span>
              </div>
            </button>
          )}
        </div>

        {/* Info card */}
        <div className="lg:col-span-2 space-y-3.5">
          <div className={`${cardBg} ${cardBorder} rounded-xl p-5`}>
            {/* Lens Account */}
            {userInfo.lensAccountAddress && (
              <div className="mb-3.5">
                <div
                  className={`flex items-center gap-1.5 text-[11px] uppercase tracking-[0.1em] font-medium ${subText} mb-1.5`}
                >
                  <Wallet className="w-3 h-3" />
                  {t("lens_account") || "Lens Account"}
                </div>
                <div
                  className={`flex items-center gap-1.5 ${inlineBg} rounded-lg px-3.5 py-2.5`}
                >
                  <p className="text-[14px] font-mono text-blue-700 dark:text-blue-400/60 break-all leading-relaxed flex-1 min-w-0">
                    {userInfo.lensAccountAddress}
                  </p>
                  <button
                    onClick={handleCopyLensAddress}
                    title={t("copy") || "Copy"}
                    className="flex-shrink-0 p-1.5 rounded-md hover:bg-slate-200 dark:hover:bg-white/[0.08] transition-colors"
                  >
                    {lensAddressCopied ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400/70" />
                    ) : (
                      <Copy className="w-3.5 h-3.5 text-slate-500 dark:text-white/40" />
                    )}
                  </button>
                </div>
              </div>
            )}

            {/* About Me */}
            <div>
              <div
                className={`text-[11px] uppercase tracking-[0.1em] font-medium ${subText} mb-1.5`}
              >
                {t("about_me")}
              </div>
              <div
                className={`text-[14px] ${bodyText} ${inlineBg} rounded-lg px-3.5 py-3 min-h-[61px] leading-relaxed whitespace-pre-line`}
              >
                {userInfo.bio || (
                  <span className="text-slate-500 dark:text-white/40">
                    {t("no_bio_provided")}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className={`my-6 h-px ${divider}`} />

      {/* Ratings */}
      <div className="mt-9 mb-9">
        {ratingsError && (
          <div className="mb-3.5 p-2.5 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg text-center">
            <p className="text-[14px] text-red-600 dark:text-red-400/80">
              {ratingsError}
            </p>
          </div>
        )}
        {duplicateRatingCount > 0 && (
          <div className="mb-3.5 p-3 bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 rounded-lg flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[13px] text-amber-700 dark:text-amber-400/90">
              {t("duplicate_ratings_found", { count: duplicateRatingCount }) ||
                `Found ${duplicateRatingCount} extra rating posts (they can skew the country average). We recommend cleaning them up.`}
            </p>
            <button
              onClick={handleCleanupDuplicates}
              disabled={cleaningDuplicates}
              className="px-3 py-1.5 rounded-lg bg-amber-500/90 hover:bg-amber-500 text-white text-[13px] font-medium disabled:opacity-60 flex-shrink-0"
            >
              {cleaningDuplicates
                ? t("cleaning") || "Cleaning up..."
                : t("cleanup_duplicates") || "Clean up duplicates"}
            </button>
          </div>
        )}
        {ratingsLoading ? (
          <div className={`${cardBg} ${cardBorder} rounded-xl p-5`}>
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3.5 mb-5 last:mb-0">
                <div className="w-7 h-7 rounded-lg bg-slate-100 dark:bg-white/[0.03] animate-pulse flex-shrink-0" />
                <div className="flex-1 h-[3.5px] bg-slate-100 dark:bg-white/[0.04] rounded animate-pulse" />
                <div className="w-9 h-3.5 bg-slate-100 dark:bg-white/[0.03] rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : !userInfo.country || userInfo.country === "EARTH" ? (
          <div className={`${cardBg} ${cardBorder} rounded-xl p-7 text-center`}>
            <Globe className="w-12 h-12 text-slate-300 dark:text-white/[0.07] mx-auto mb-3.5" />
            <p className={`text-[16px] ${subText} mb-1`}>
              {t("no_country_selected") || "No country selected"}
            </p>
            <p className={`text-[14px] ${subText} mb-4.5 opacity-70`}>
              {t("select_country_to_rate")}
            </p>
          </div>
        ) : (
          <div className="space-y-3.5">
            <RatingDisplay />
            {isSavingRating && (
              <div className="flex items-center justify-center gap-2.5 py-1">
                <div className="w-3.5 h-3.5 rounded-full border border-blue-400/50 border-t-transparent animate-spin" />
                <span className={`text-[14px] ${subText}`}>
                  {t("saving") || "Saving..."}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className={`h-px ${divider} my-6`} />

      {/* Posts */}
      <div>
        <div className="flex items-center justify-between mb-5">
          <p className="font-cinzel text-[11px] text-slate-500 dark:text-white/40 tracking-[0.1em] uppercase">
            {t("my_posts") || "My posts"}
          </p>
          <span className={`text-[14px] ${subText} opacity-70`}>
            {t("all_my_posts") || "All posts from all countries"}
          </span>
        </div>
        <CountryFeed
          walletAddress={userInfo.lensAccountAddress}
          countryCode={null}
          filterByCountry={false}
        />
      </div>
    </div>
  );

  return (
    <Layout
      userProfile={userInfo}
      walletAddress={userInfo?.walletAddress}
      onLogout={() => {
        localStorage.removeItem("token");
        localStorage.removeItem("web3_wallet_address");
        window.location.href = "/";
      }}
      loading={userLoading}
      error={userError}
      onCreatePost={handleCreatePost}
    >
      <div className="py-2.5 px-0 lg:px-1">{profileContent}</div>
    </Layout>
  );
};

export default ProfilePage;
