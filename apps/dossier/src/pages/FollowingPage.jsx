// src/pages/FollowingPage.jsx
import React, { useState, useEffect, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useWalletClient } from "wagmi";
import {
  ArrowLeft,
  Users,
  UserCheck,
  Rss,
  ShieldAlert,
  HelpCircle,
  MapPin,
  Calendar,
  Globe,
} from "lucide-react";
import Layout from "../components/Layout";
import PostCard from "../components/PostCard";
import useUserInfo from "../hooks/useUserInfo";
import {
  useLensFollowingList,
  useLensFollowersList,
} from "../hooks/useLensFollowing";
import { useLensTimeline } from "../hooks/useLensTimeline";
import { useLensAuth } from "../context/LensAuthContext";
import useLensPosts from "../hooks/useLensPosts";
// NOTE: "Violations" and "Help" tabs — the same hooks already used and
// verified on ViolationsListPage.jsx / SupportPage.jsx. Here they're
// just filtered by the following list, without duplicating the
// loading/normalization logic.
import useLensViolations from "../hooks/useLensViolations";
import { useLensHelpRequests } from "../hooks/useLensHelpRequests";
import { getSeverityInfo } from "../config/violationTypes";
import { useLensProfile, useLensPublicProfile } from "../hooks/useLensProfile";
import { useLensDAO } from "../hooks/useLensDAO";
import { useCountry } from "../hooks/useCountry";
import TipButton from "../components/TipButton";
import ReportModal from "../components/ReportModal";
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";

// "Following feed" page — a feed of posts from the accounts the user
// follows (via fetchTimeline), plus the Following/Followers lists
// themselves (via fetchFollowing/fetchFollowers).
//
// By default it shows the logged-in user's OWN feed — the same
// convention as lens_account_address in localStorage, already used by
// useLensProfile.js and UserProfilePage.jsx.
//
// The post card is the shared <PostCard/> (src/components/PostCard.jsx),
// the same one used by CountryFeed.jsx. All card markup/functionality
// (reactions, comments, saving, reposting, tips, menu, media,
// moderation blur) lives there once, so the same logic isn't duplicated
// and maintained in two files. This page is only responsible for:
// fetching posts (useLensTimeline), computing derived state
// (reactions/saved/moderation), and normalizing a post into the shape
// PostCard expects.
const FollowingPage = () => {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { userInfo, loading: userLoading, error: userError } = useUserInfo();

  // Optional :userId route param — lets you view the following/followers
  // of ANY profile, not just your own. If the param is absent, fall back
  // to the active Lens Account.
  const { userId } = useParams();
  const activeLensAccountAddress =
    typeof window !== "undefined"
      ? localStorage.getItem("lens_account_address")
      : null;
  const accountAddress = userId || activeLensAccountAddress;

  // Fixed: fetchTimeline requires an authenticated session — sessionClient
  // comes from the same LensAuthContext already used by CountryFeed.jsx,
  // not from the public PublicClient.
  // FIXED: missing getWalletClient — see ViolationsListPage.jsx/
  // SupportPage.jsx for the identical bug and full explanation.
  const { sessionClient, sessionRestoring, getWalletClient } = useLensAuth();

  const lensWalletAddress =
    typeof window !== "undefined"
      ? localStorage.getItem("lens_wallet_address")
      : null;
  const { profile: lensProfile } = useLensProfile(lensWalletAddress);
  const { getTranslatedCountryName } = useCountry(i18n.language);
  const dao = useLensDAO();
  const { data: walletClient } = useWalletClient();
  const {
    createLensComment,
    deleteLensPost,
    bookmarkLensPost,
    undoBookmarkLensPost,
    repostLensPost,
    addLensReaction,
    removeLensReaction,
    getLensPostConfirmed,
  } = useLensPosts(sessionClient, getWalletClient);

  const [activeTab, setActiveTab] = useState("following");

  const {
    posts,
    loading: feedLoading,
    loadingMore: feedLoadingMore,
    hasMore: feedHasMore,
    loadMore: loadMoreFeed,
    error: feedError,
  } = useLensTimeline(accountAddress, sessionClient);

  const {
    items: following,
    loading: followingLoading,
    loadingMore: followingLoadingMore,
    hasMore: followingHasMore,
    loadMore: loadMoreFollowing,
  } = useLensFollowingList(accountAddress);

  const {
    items: followers,
    loading: followersLoading,
    loadingMore: followersLoadingMore,
    hasMore: followersHasMore,
    loadMore: loadMoreFollowers,
  } = useLensFollowersList(accountAddress);

  // Following addresses — used below to filter violations and help
  // requests (neither hook can filter by author list on the Lens-request
  // side, so we filter client-side the same way fetchViolations already
  // filters by countryCode).
  // NOTE: if followingHasMore is still true (the following list is only
  // partially loaded), the filter only applies to what's already
  // loaded — an acceptable tradeoff so the page doesn't have to force a
  // full following-list load on entry.
  const followingAddresses = new Set(
    following.map((f) => f.address?.toLowerCase()).filter(Boolean),
  );

  // "Violations" tab — the same useLensViolations used on
  // ViolationsListPage.jsx. Loaded lazily (only when the tab is opened
  // for the first time), the result is filtered by followingAddresses.
  const { fetchViolations, loading: violationsLoading } = useLensViolations();
  const [violations, setViolations] = useState([]);
  const [violationsLoaded, setViolationsLoaded] = useState(false);

  // "Help" tab — useLensHelpRequests, same as on SupportPage.jsx.
  const {
    requests: helpRequests,
    loading: helpRequestsLoading,
    loadRequests,
  } = useLensHelpRequests();
  const [helpRequestsLoaded, setHelpRequestsLoaded] = useState(false);

  useEffect(() => {
    if (activeTab === "violations" && !violationsLoaded && accountAddress) {
      setViolationsLoaded(true);
      fetchViolations().then((res) => {
        if (res.success) setViolations(res.violations);
      });
    }
    if (activeTab === "help" && !helpRequestsLoaded && accountAddress) {
      setHelpRequestsLoaded(true);
      loadRequests();
    }
  }, [activeTab, violationsLoaded, helpRequestsLoaded, accountAddress]);

  // Moderation-action log, same pattern as in CountryFeed.jsx.
  // IMPORTANT: declared BEFORE followingViolations/followingHelpRequests
  // below, because those computations read modActions right away during
  // render — declaring it after (as it was before) makes JS throw
  // "Cannot access 'modActions' before initialization" (TDZ for const).
  const [modActions, setModActions] = useState([]);
  const [revealedBlurred, setRevealedBlurred] = useState(new Set());

  // Shield SBT totalSupply() is read directly from the blockchain via
  // fetchShieldTotalSupply() (moderationActions.js), NOT via
  // dao.shieldInfo?.totalSupply — the latter is only populated AFTER
  // dao.connect()/silentConnect(), which nothing on FollowingPage calls
  // explicitly (unlike ModerationQueue.jsx, where the moderator is
  // already connected in order to vote). Without this,
  // computeBanState() always got totalEligibleVoters=0 → quorumPct
  // always 0 → banned always false, meaning banned authors were NEVER
  // hidden here regardless of the actual vote count.
  const [shieldTotalSupply, setShieldTotalSupply] = useState(0);
  // Until modActions/shieldTotalSupply have loaded, the first render of
  // the feed/Violations-Help tabs happened WITHOUT the ban filter — a
  // banned author would flash briefly before disappearing. modReady
  // keeps the lists in a loading state until sanctions have been
  // computed at least once.
  const [modReady, setModReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAllModActions(), fetchShieldTotalSupply()])
      .then(([actions, supply]) => {
        if (!cancelled) {
          setModActions(actions);
          setShieldTotalSupply(supply);
        }
      })
      .catch((err) => {
        console.warn("⚠️ Failed to load moderation actions:", err.message);
      })
      .finally(() => {
        if (!cancelled) setModReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const followingViolations = violations
    .filter((v) =>
      followingAddresses.has(v.author?.wallet_address?.toLowerCase()),
    )
    // Hidden/sanctioned violation posts and posts from banned authors
    // shouldn't show up here either — previously these tabs weren't
    // checked against modActions at all (the same log that already
    // filters the "Feed" tab).
    .filter((v) => {
      const modState = computeModerationState(modActions, v.lens_post_id);
      if (modState.hidden) return false;
      if (v.author?.owner_address) {
        const banState = computeBanState(
          modActions,
          v.author.owner_address,
          shieldTotalSupply,
        );
        if (banState.banned) return false;
      }
      return true;
    });
  const followingHelpRequests = helpRequests
    .filter((r) =>
      followingAddresses.has(r.author?.wallet_address?.toLowerCase()),
    )
    .filter((r) => {
      const modState = computeModerationState(modActions, r.lens_post_id);
      if (modState.hidden) return false;
      if (r.author?.owner_address) {
        const banState = computeBanState(
          modActions,
          r.author.owner_address,
          shieldTotalSupply,
        );
        if (banState.banned) return false;
      }
      return true;
    });

  // Local overlay of derived post state for the following feed.
  // useLensTimeline manages the posts array itself (it's not local page
  // state like in CountryFeed), so reactions/saved/deleted are tracked
  // separately and layered on top of the hook's data at render time.
  const [reportModalPost, setReportModalPost] = useState(null);
  const [sharing, setSharing] = useState({});
  const [savedStatuses, setSavedStatuses] = useState({});
  const [savingPosts, setSavingPosts] = useState({});
  const [reactionOverrides, setReactionOverrides] = useState({});
  // ADDED: guards handleReaction() against double-clicks while an API
  // round-trip is in flight (same fix as CountryFeed.jsx/PostPage.jsx).
  const [reactingPostIds, setReactingPostIds] = useState(new Set());
  // FIXED: reactingPostIds above is React state — setReactingPostIds()
  // is async/batched, so two clicks landing in the same tick can both
  // read the old Set before either update lands, letting both through
  // to fire the Lens mutation concurrently. reactingPostIdsRef is a
  // plain mutable Set checked AND marked in the same synchronous
  // statement, closing that window; the state copy above is kept only
  // in case the UI wants to read it later.
  const reactingPostIdsRef = useRef(new Set());
  const [commentCountDeltas, setCommentCountDeltas] = useState({});
  const [deletedPostIds, setDeletedPostIds] = useState(new Set());

  // --- Helpers for the following-feed post (adapting useLensTimeline
  // fields into the shape PostCard expects) ---

  const getAuthorWalletAddress = (post) => post.author?.address || null;

  const getCountryDisplayName = (countryCode) => {
    if (!countryCode || countryCode === "EARTH") {
      return t("earth") || "Planet Earth";
    }
    const translated = getTranslatedCountryName(countryCode);
    return translated || countryCode;
  };

  const isOwnWallet = (address) => {
    if (!address) return false;
    const lowerAddr = address.toLowerCase();
    const lensAccountAddr = localStorage.getItem("lens_account_address");
    const candidates = [
      lensAccountAddr,
      lensProfile?.address,
      walletClient?.account?.address,
      lensWalletAddress,
    ];
    return candidates.some((c) => c && c.toLowerCase() === lowerAddr);
  };

  const getMediaItems = (post) => {
    if (Array.isArray(post.media_urls)) {
      return post.media_urls.map((url, i) => ({
        url,
        type: post.media_types?.[i] || "image",
      }));
    }
    if (Array.isArray(post.media)) {
      return post.media.map((m) =>
        typeof m === "string"
          ? { url: m, type: "image" }
          : { url: m.url, type: m.type || "image" },
      );
    }
    return [];
  };

  const getCommentCount = (post) => {
    const base = post.stats?.comments ?? 0;
    return base + (commentCountDeltas[post.id] || 0);
  };

  const getReactionCounts = (post) => {
    const override = reactionOverrides[post.id];
    if (override) return { truth: override.truth, false: override.false };

    const truth = post.stats?.upvotes ?? post.truth_count ?? 0;
    const falseCount = post.stats?.downvotes ?? post.false_count ?? 0;

    return { truth, false: falseCount };
  };

  const getMyReaction = (post) => {
    const override = reactionOverrides[post.id];
    if (override) return override.my_reaction;
    if (post.operations?.hasUpvoted) return "truth";
    if (post.operations?.hasDownvoted) return "false";
    return null;
  };

  // --- Post actions (reactions, comments, saving, reposting, deleting) ---

  const handleReaction = async (post, reactionType) => {
    if (sessionRestoring) return;

    const activeAccountAddress = localStorage.getItem("lens_account_address");
    if (!sessionClient || !activeAccountAddress) {
      alert(t("login_to_react") || "Please log in to react");
      return;
    }
    if (reactingPostIdsRef.current.has(post.id)) return; // already in flight

    const lensPostId = post.id;
    // FIXED (root cause of "Правда" duplicating onto "Неправда"): same
    // fix as CountryFeed.jsx/PostPage.jsx — no local +1/-1 counter math
    // and no localStorage anywhere in this flow. Lens is asked based on
    // the post's current reaction (from Lens's own
    // operations.hasUpvoted/hasDownvoted), and once the call succeeds
    // the post is refetched from Lens; reactionOverrides now holds that
    // real, server-confirmed state — never a locally computed guess.
    const prevReaction = getMyReaction(post);
    const isTogglingOff = prevReaction === reactionType;
    const oppositeType = reactionType === "truth" ? "false" : "truth";

    // FIXED: marking the ref synchronously (not just the state Set via
    // setReactingPostIds below) is what actually closes the race — see
    // the comment on reactingPostIdsRef above.
    reactingPostIdsRef.current.add(post.id);
    setReactingPostIds((prev) => new Set(prev).add(post.id));

    try {
      if (isTogglingOff) {
        const result = await removeLensReaction(lensPostId, reactionType);
        if (!result.success) throw new Error(result.error);
      } else {
        if (prevReaction === oppositeType) {
          const cleanupResult = await removeLensReaction(
            lensPostId,
            oppositeType,
          );
          if (!cleanupResult.success) {
            console.warn(
              "⚠️ Failed to clear the opposite reaction:",
              cleanupResult.error,
            );
          }
        }
        const result = await addLensReaction(lensPostId, reactionType);
        if (!result.success) throw new Error(result.error);
      }

      // ДОДАНО: getLensPostConfirmed замість голого getLensPost — коротка
      // повторна перевірка, якщо сервер ще не встиг застосувати обидва
      // виклики вище до цього рефетчу.
      const expectedReaction = isTogglingOff ? null : reactionType;
      const fresh = await getLensPostConfirmed(lensPostId, expectedReaction);
      if (fresh.success) {
        setReactionOverrides((prev) => ({
          ...prev,
          [post.id]: {
            truth: fresh.post.truth_count,
            false: fresh.post.false_count,
            my_reaction: fresh.post.my_reaction,
          },
        }));
      }
    } catch (err) {
      console.error("❌ Error handling reaction:", err);
      alert(
        (t("reaction_save_error") || "Failed to save reaction") +
          ": " +
          err.message,
      );
    } finally {
      reactingPostIdsRef.current.delete(post.id);
      setReactingPostIds((prev) => {
        const next = new Set(prev);
        next.delete(post.id);
        return next;
      });
    }
  };

  const handleComment = async (post, content) => {
    if (!content?.trim()) return;

    try {
      const lensResult = await createLensComment({
        content: content.trim(),
        commentOn: post.id,
        countryCode: lensProfile?.country || "EARTH",
      });

      if (!lensResult.success) {
        throw new Error(
          lensResult.error || "Failed to publish comment on Lens",
        );
      }

      setCommentCountDeltas((prev) => ({
        ...prev,
        [post.id]: (prev[post.id] || 0) + 1,
      }));
    } catch (error) {
      console.error("❌ Error adding comment:", error);
      alert(
        (t("comment_save_error") || "Failed to add comment") +
          ": " +
          error.message,
      );
    }
  };

  const handleSavePost = async (post) => {
    try {
      setSavingPosts((prev) => ({ ...prev, [post.id]: true }));
      const currentlySaved = savedStatuses[post.id];

      const result = currentlySaved
        ? await undoBookmarkLensPost(post.id)
        : await bookmarkLensPost(post.id);

      if (result.success) {
        setSavedStatuses((prev) => ({ ...prev, [post.id]: !currentlySaved }));
      }
    } catch (error) {
      console.error("❌ Error in handleSavePost:", error);
    } finally {
      setSavingPosts((prev) => ({ ...prev, [post.id]: false }));
    }
  };

  // No longer manages the share modal — PostCard shows it itself after
  // onShare is called (as before, regardless of whether the repost
  // succeeded).
  const handleSharePost = async (post) => {
    try {
      setSharing((prev) => ({ ...prev, [post.id]: true }));
      await repostLensPost(post.id);
    } catch (error) {
      console.error("❌ Error sharing post:", error);
    } finally {
      setSharing((prev) => ({ ...prev, [post.id]: false }));
    }
  };

  const handleDeletePost = async (post) => {
    if (
      !window.confirm(
        t("confirm_delete_post") ||
          "Are you sure you want to delete this post?",
      )
    ) {
      return;
    }

    try {
      const result = await deleteLensPost(post.id);
      if (!result.success) {
        throw new Error(result.error || "Failed to delete post on Lens");
      }
      setDeletedPostIds((prev) => new Set(prev).add(post.id));
    } catch (error) {
      console.error("❌ Error deleting post:", error);
      alert(error.message);
    }
  };

  const handleReportPost = async (post) => {
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
    setReportModalPost(post);
  };

  const tabs = [
    { key: "following", label: t("following") || "Following", icon: UserCheck },
    { key: "followers", label: t("followers") || "Followers", icon: Users },
    {
      key: "feed",
      label: t("following_feed") || "Following feed",
      icon: Rss,
    },
    {
      key: "violations",
      label: t("violations") || "Violations",
      icon: ShieldAlert,
    },
    {
      key: "help",
      label: t("help_requests") || "Help",
      icon: HelpCircle,
    },
  ];

  const visiblePosts = posts.filter((p) => !deletedPostIds.has(p.id));

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
      onCreatePost={() => {}}
    >
      <div>
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-[16px] text-slate-600 dark:text-white/40
            hover:text-slate-900 dark:hover:text-white/60 transition-colors mb-4"
        >
          <ArrowLeft className="w-3 h-3" />
          {t("back") || "Back"}
        </button>

        {!accountAddress ? (
          <div className="text-center py-12 text-slate-600 dark:text-white/40 text-[14px]">
            {t("login_required") ||
              "You need to log in to view this page"}
          </div>
        ) : (
          <>
            {/* Tab switcher — wraps onto a second line on narrow/mobile
                screens instead of overflowing off-screen. A horizontal
                scroll strip was tried first, but with the scrollbar
                hidden there was no visible/discoverable way to reach the
                last tabs on a screen without touch (mouse-only, no
                trackpad) — wrapping guarantees every tab is always
                visible without requiring any gesture. */}
            <div className="flex flex-wrap items-center gap-x-1 gap-y-1.5 mb-4 pb-1 border-b border-slate-300 dark:border-white/[0.07]">
              {tabs.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveTab(key)}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 sm:py-2 text-[13px] sm:text-[14px] whitespace-nowrap
                    rounded-lg sm:rounded-none border sm:border-0 sm:border-b-2 transition-colors sm:-mb-px ${
                      activeTab === key
                        ? "bg-blue-50 border-blue-300 dark:bg-blue-500/10 dark:border-blue-400/40 sm:bg-transparent sm:dark:bg-transparent sm:border-blue-500 sm:dark:border-blue-400/70 text-slate-950 dark:text-white/85"
                        : "border-transparent text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/60"
                    }`}
                >
                  <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                  {label}
                </button>
              ))}
            </div>

            {/* Tab: feed of posts from followed accounts (fetchTimeline) */}
            {activeTab === "feed" && (
              <div>
                {sessionRestoring ? (
                  <div className="flex justify-center py-12">
                    <div className="w-8 h-8 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
                  </div>
                ) : !sessionClient ? (
                  <div className="text-center py-12 text-[14px] text-slate-600 dark:text-white/40">
                    {t("timeline_login_required") ||
                      "Log in to your Lens account to see your following feed"}
                  </div>
                ) : feedLoading || !modReady ? (
                  <div className="flex justify-center py-12">
                    <div className="w-8 h-8 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
                  </div>
                ) : feedError ? (
                  <div className="text-center py-8 text-[14px] text-slate-700 dark:text-white/45">
                    {feedError}
                  </div>
                ) : visiblePosts.length === 0 ? (
                  <div className="text-center py-12 text-[14px] text-slate-600 dark:text-white/40">
                    {t("following_feed_empty") ||
                      "Posts from people you follow will show up here"}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {visiblePosts.map((post) => {
                      const reactionCounts = getReactionCounts(post);
                      const myReaction = getMyReaction(post);
                      const isSaved = savedStatuses[post.id];
                      const isSaving = savingPosts[post.id];

                      const myWalletAddress =
                        localStorage.getItem("lens_account_address") ||
                        lensProfile?.address ||
                        walletClient?.account?.address ||
                        lensWalletAddress ||
                        null;

                      const authorAddress = getAuthorWalletAddress(post);
                      const isOwner =
                        !!myWalletAddress &&
                        !!authorAddress &&
                        authorAddress.toLowerCase() ===
                          myWalletAddress.toLowerCase();

                      const modState = computeModerationState(
                        modActions,
                        post.id,
                      );
                      const banState = computeBanState(
                        modActions,
                        // Fixed: owner (EOA), not post.author?.address
                        // (Lens Account) — otherwise ban votes never
                        // matched and a banned author still showed up in
                        // the following feed.
                        post.author?.owner,
                        shieldTotalSupply,
                      );

                      if (modState.hidden || banState.banned) return null;

                      const isBlurred =
                        modState.blurred && !revealedBlurred.has(post.id);

                      const cardPost = {
                        id: post.id,
                        content: post.content,
                        createdAt: post.createdAt,
                        author: {
                          address: authorAddress,
                          name:
                            post.author?.name ||
                            post.author?.handle ||
                            t("anonymous") ||
                            "Anonymous",
                          handle:
                            post.author?.handle &&
                            post.author.handle !== post.author?.name
                              ? post.author.handle
                              : null,
                          avatar: post.author?.avatar || null,
                        },
                        media: getMediaItems(post),
                        commentCount: getCommentCount(post),
                      };

                      return (
                        <PostCard
                          key={post.id}
                          post={cardPost}
                          countryBadge={
                            authorAddress ? (
                              <AuthorCountryBadge
                                address={authorAddress}
                                getCountryDisplayName={getCountryDisplayName}
                              />
                            ) : null
                          }
                          reaction={{
                            truth: reactionCounts.truth,
                            false: reactionCounts.false,
                            mine: myReaction,
                          }}
                          isOwner={isOwner}
                          isSaved={isSaved}
                          isSaving={isSaving}
                          isSharing={sharing[post.id]}
                          tipButton={
                            authorAddress && !isOwnWallet(authorAddress) ? (
                              <TipButton
                                author={{ wallet_address: authorAddress }}
                                lensPostId={post.id}
                              />
                            ) : null
                          }
                          isBlurred={isBlurred}
                          onRevealBlurred={() =>
                            setRevealedBlurred((prev) =>
                              new Set(prev).add(post.id),
                            )
                          }
                          onReaction={(type) => handleReaction(post, type)}
                          onSave={() => handleSavePost(post)}
                          onShare={() => handleSharePost(post)}
                          onDelete={() => handleDeletePost(post)}
                          onReport={() => handleReportPost(post)}
                          onAuthorClick={() =>
                            authorAddress && navigate(`/user/${authorAddress}`)
                          }
                          onCommentSubmit={(text) => handleComment(post, text)}
                          onCommentIconClick={() =>
                            navigate(`/post/${post.id}`)
                          }
                          onOpenPost={() => navigate(`/post/${post.id}`)}
                        />
                      );
                    })}

                    {feedHasMore && (
                      <div className="text-center py-3">
                        <button
                          onClick={loadMoreFeed}
                          disabled={feedLoadingMore}
                          className="px-5 py-2 text-[12px] font-medium
                            bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.08] text-slate-600 dark:text-white/40
                            rounded-lg hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65
                            disabled:opacity-40 transition-all"
                        >
                          {feedLoadingMore
                            ? t("loading") || "Loading..."
                            : t("load_more") || "Load more"}
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {reportModalPost && (
                  <ReportModal
                    post={reportModalPost}
                    authorAddress={getAuthorWalletAddress(reportModalPost)}
                    authorCandidates={[
                      getAuthorWalletAddress(reportModalPost),
                    ].filter(Boolean)}
                    createLensComment={createLensComment}
                    sessionClient={sessionClient}
                    countryCode={lensProfile?.country || "EARTH"}
                    dao={dao}
                    onClose={() => setReportModalPost(null)}
                  />
                )}
              </div>
            )}

            {/* Tab: violations from people you follow */}
            {activeTab === "violations" && (
              <ViolationsTabList
                loading={violationsLoading || !modReady}
                items={followingViolations}
                emptyLabel={
                  t("following_violations_empty") ||
                  "People you follow haven't posted any violations yet"
                }
                onItemClick={(id) => navigate(`/violations/${id}`)}
                getCountryDisplayName={getCountryDisplayName}
                t={t}
              />
            )}

            {/* Tab: help requests from people you follow */}
            {activeTab === "help" && (
              <HelpRequestsTabList
                loading={helpRequestsLoading || !modReady}
                items={followingHelpRequests}
                emptyLabel={
                  t("following_help_requests_empty") ||
                  "People you follow haven't posted any help requests yet"
                }
                onItemClick={(id) => navigate(`/help/${id}`)}
                t={t}
              />
            )}

            {/* Tab: following list */}
            {activeTab === "following" && (
              <UserList
                items={following}
                loading={followingLoading}
                loadingMore={followingLoadingMore}
                hasMore={followingHasMore}
                onLoadMore={loadMoreFollowing}
                emptyLabel={
                  t("following_empty") || "Not following anyone yet"
                }
                onUserClick={(address) => navigate(`/user/${address}`)}
                getCountryDisplayName={getCountryDisplayName}
                t={t}
              />
            )}

            {/* Tab: followers list */}
            {activeTab === "followers" && (
              <UserList
                items={followers}
                loading={followersLoading}
                loadingMore={followersLoadingMore}
                hasMore={followersHasMore}
                onLoadMore={loadMoreFollowers}
                emptyLabel={t("followers_empty") || "No followers yet"}
                onUserClick={(address) => navigate(`/user/${address}`)}
                getCountryDisplayName={getCountryDisplayName}
                t={t}
              />
            )}
          </>
        )}
      </div>
    </Layout>
  );
};

// Shared list component for the "Following"/"Followers" tabs.
const UserList = ({
  items,
  loading,
  loadingMore,
  hasMore,
  onLoadMore,
  emptyLabel,
  onUserClick,
  getCountryDisplayName,
  t,
}) => {
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-[14px] text-slate-600 dark:text-white/40">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((user) => (
        <div
          key={user.address}
          onClick={() => onUserClick(user.address)}
          className="flex items-center gap-3 bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07]
            rounded-xl p-3 cursor-pointer hover:border-slate-400 dark:hover:border-white/[0.15] transition-colors"
        >
          <div className="w-10 h-10 rounded-full overflow-hidden bg-[#0d0415] flex items-center justify-center flex-shrink-0">
            {user.avatar ? (
              <img
                src={user.avatar}
                alt={user.name || user.handle}
                className="w-full h-full object-cover"
              />
            ) : (
              <span className="font-cinzel text-[16px] text-[#c8b8a2]">
                {(user.name || user.handle || "U")[0]?.toUpperCase()}
              </span>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <p className="text-[14px] text-slate-900 dark:text-white/85 truncate">
                {user.name || user.handle || "—"}
              </p>
              {user.handle && user.name && (
                <span className="text-[12px] text-slate-600 dark:text-white/40 truncate">
                  {user.handle}
                </span>
              )}
              {user.address && (
                <AuthorCountryBadge
                  address={user.address}
                  getCountryDisplayName={getCountryDisplayName}
                />
              )}
            </div>
          </div>
        </div>
      ))}

      {hasMore && (
        <button
          onClick={onLoadMore}
          disabled={loadingMore}
          className="w-full py-2.5 text-[14px] text-slate-600 dark:text-white/50
            hover:text-slate-900 dark:hover:text-white/70 transition-colors disabled:opacity-50"
        >
          {loadingMore
            ? t("loading") || "Loading..."
            : t("load_more") || "Load more"}
        </button>
      )}
    </div>
  );
};

// Compact row card for the "Violations" tab on FollowingPage. It doesn't
// repeat the full ViolationsListPage.jsx markup (moderation/report/
// pagination aren't needed here — just a short list linking to details),
// but uses the same normalized fields from useLensViolations (title,
// severity_level, country_code, created_at).
const ViolationsTabList = ({
  loading,
  items,
  emptyLabel,
  onItemClick,
  getCountryDisplayName,
  t,
}) => {
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-[14px] text-slate-600 dark:text-white/40">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((violation) => {
        const severity = getSeverityInfo?.(violation.severity_level) || null;
        return (
          <div
            key={violation.id}
            onClick={() => onItemClick(violation.id)}
            className="flex items-start gap-3 bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07]
              rounded-xl p-3 cursor-pointer hover:border-slate-400 dark:hover:border-white/[0.15] transition-colors"
          >
            <div className="min-w-0 flex-1">
              <p className="text-[14px] text-slate-900 dark:text-white/85 truncate">
                {violation.title || t("violation") || "Violation"}
              </p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                {/* Country of the violation — the field that matters most
                    for this tab (same badge style as ViolationsListPage/
                    SupportPage). */}
                {violation.country_code && (
                  <span
                    className="text-[11px] px-1.5 py-0.5 rounded
                    bg-blue-100 dark:bg-blue-900/25 border border-blue-300/50 dark:border-blue-700/20 text-blue-700 dark:text-blue-400/65
                    flex items-center gap-1"
                  >
                    <Globe className="w-2.5 h-2.5" />
                    {getCountryDisplayName
                      ? getCountryDisplayName(violation.country_code)
                      : violation.country_code}
                  </span>
                )}
                {severity && (
                  <span
                    className="text-[11px] px-1.5 py-0.5 rounded"
                    style={{
                      color: severity.color,
                      backgroundColor: severity.bgColor,
                    }}
                  >
                    {severity.label}
                  </span>
                )}
                {violation.city && (
                  <span className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-white/40">
                    <MapPin className="w-3 h-3" />
                    {violation.city}
                  </span>
                )}
                {violation.created_at && (
                  <span className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-white/40">
                    <Calendar className="w-3 h-3" />
                    {new Date(violation.created_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// Compact row card for the "Help" tab — same approach, data from
// useLensHelpRequests (description/help_types/status).
const HelpRequestsTabList = ({ loading, items, emptyLabel, onItemClick, t }) => {
  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-[14px] text-slate-600 dark:text-white/40">
        {emptyLabel}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {items.map((request) => {
        // ФІКС: useLensHelpRequests нормалізує автора як
        // { name?, unique_name, avatar_url, wallet_address,
        // owner_address } (див. normalizeHelpRequest) — поля
        // author.handle НЕ існує, тому воно завжди було undefined і
        // ім'я ніколи не показувалось.
        // За проханням користувача показуємо саме @unique_name
        // (стабільний, не редагований хендл), а не editable "name" —
        // останній лишається лише як запасний варіант, якщо хендла
        // немає.
        const author = request.author;
        const authorHandle = author?.unique_name
          ? `@${author.unique_name}`
          : null;
        const authorDisplay = authorHandle || author?.name || null;

        return (
          <div
            key={request.id}
            onClick={() => onItemClick(request.id)}
            className="flex items-start gap-3 bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07]
              rounded-xl p-3 cursor-pointer hover:border-slate-400 dark:hover:border-white/[0.15] transition-colors"
          >
            <div className="min-w-0 flex-1">
              {authorDisplay && (
                <p className="text-[12px] text-slate-600 dark:text-white/45 truncate mb-0.5">
                  {authorDisplay}
                </p>
              )}
              <p className="text-[14px] text-slate-900 dark:text-white/85 truncate">
                {request.title || t("help_request") || "Help request"}
              </p>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
              {(request.help_types || []).slice(0, 2).map((ht) => (
                <span
                  key={ht}
                  className="text-[11px] px-1.5 py-0.5 rounded
                    bg-amber-100 dark:bg-amber-900/20 border border-amber-300/50 dark:border-amber-700/20 text-amber-700 dark:text-amber-400/70"
                >
                  {ht}
                </span>
              ))}
              {request.created_at && (
                <span className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-white/40">
                  <Calendar className="w-3 h-3" />
                  {new Date(request.created_at).toLocaleDateString()}
                </span>
              )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
};

// Author country badge — following the CountryFeed.jsx example.
// useLensTimeline doesn't return country directly on the post, so it's
// fetched separately via useLensPublicProfile — the same hook
// UserProfilePage.jsx uses for its own profile.
const AuthorCountryBadge = ({ address, getCountryDisplayName }) => {
  const { profile } = useLensPublicProfile(address);

  if (!profile?.country) return null;

  return (
    <span
      className="text-[11px] px-1.5 py-0.5 rounded
      bg-blue-100 dark:bg-blue-900/25 border border-blue-300/50 dark:border-blue-700/20 text-blue-700 dark:text-blue-400/65
      flex-shrink-0"
    >
      {getCountryDisplayName(profile.country)}
    </span>
  );
};

export default FollowingPage;
