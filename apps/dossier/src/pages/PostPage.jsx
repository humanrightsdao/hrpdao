// src/pages/PostPage.jsx
// ✅ FULLY on Lens — no Supabase requests at all
import React, { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, EyeOff, ShieldAlert, Eye } from "lucide-react";
import Layout from "../components/Layout";
import CreatePostModal from "../components/CreatePostModal";
import PostCard from "../components/PostCard";
import ReportModal from "../components/ReportModal";
// REMOVED: import useUserInfo from "../hooks/useUserInfo";
// useUserInfo() still makes a service Supabase request under the hood
// (lens_users by id/role) — but this page needs neither id nor role at
// all, it only uses identity fields already available directly in
// lensProfile. useLensProfile() is 0 requests to Supabase, pure Lens.
import { useCountry } from "../hooks/useCountry";
import useLensPosts from "../hooks/useLensPosts";
import { useLensProfile } from "../hooks/useLensProfile";
// ADDED: without sessionClient from the auth context, useLensPosts()
// could never perform any authorized action (comment, reaction, repost,
// bookmark, deletion) — requireSessionClient() inside the hook always
// threw "Lens session not found", even when the session had been
// restored and was valid (LensAuthContext restored it from localStorage).
// Check the import path below — it should point to the same file that
// logs "✅ Lens session restored from storage" (LensAuthContext.jsx).
import { useLensAuth } from "../context/LensAuthContext";
import { useLensDAO } from "../hooks/useLensDAO";
import { useTipJar } from "../hooks/useTipJar";
import TipButton from "../components/TipButton";
// ADDED: a shared comments hook/component, extracted out of this same
// file (HelpRequestPage.jsx/ComplaintDetailsPage.jsx already use it).
// Here we just plug it in instead of our own copy of the same logic.
import useLensComments from "../hooks/useLensComments";
import CommentsSection from "../components/CommentsSection";
// ADDED: without this, moderation actions (blur/hide/critical hide) were
// only tallied inside ModerationQueue.jsx — on the post's own page there
// was no effect at all, even though the action had been published
// successfully. Without separate hook/component files — all the tallying
// and UI is right here.
import {
  fetchAllModActions,
  computeModerationState,
} from "../utils/moderationActions";
// ADDED: reports - needed for auto-quarantine (the same approach
// already used in CountryFeed.jsx/ViolationsListPage.jsx/SupportPage.jsx/ModerationQueue.jsx).
import { fetchAllReportComments } from "../utils/postReports";
// ADDED: the shared publishing limit (1/min, 10/hr, 20/day) - comments
// here (both the quick one and the full one in CommentsSection) count
// against the same counter as posts.
import { checkPostRateLimit } from "../utils/postRateLimit";

const PostPage = () => {
  const { t, i18n } = useTranslation();
  const { postId } = useParams();
  const navigate = useNavigate();
  // The wallet address logged into Lens (the same convention used in
  // useUserInfo.js/CreatePostModal.jsx) — this is where lensProfile comes from.
  const lensWalletAddress = localStorage.getItem("lens_wallet_address");
  const { profile: lensProfile, loading: userLoading } =
    useLensProfile(lensWalletAddress);
  const { getTranslatedCountryName } = useCountry(i18n.language);
  // FIXED: previously useLensPosts() was called WITHOUT arguments —
  // sessionClient inside the hook was always null, so
  // requireSessionClient() always threw "Lens session not found. Please
  // login again.", even for a genuinely logged-in user. This is exactly
  // the cause of the error with comments and (the same cause) — the
  // "Truth"/"False" reactions, bookmarks, reposts, deletion — they all go
  // through requireSessionClient().
  const { sessionClient, getWalletClient, address: connectedAddress } =
    useLensAuth();
  // CHANGED (embedded wallet): previously read useWalletClient()
  // directly and passed the raw value into useLensPosts/useLensComments —
  // duplicating the "frozen closure" hazard LensAuthContext.getWalletClient()
  // already solves once, app-wide. getWalletClient (the function
  // itself, destructured above from useLensAuth()) is forwarded
  // through instead, and resolved fresh at write-time. Anywhere this
  // file previously read walletClient?.account?.address just for the
  // connected EOA address, it now uses connectedAddress (also from
  // useLensAuth(), no async resolution needed).
  const {
    createLensComment,
    deleteLensPost,
    addLensReaction,
    removeLensReaction,
    getLensPost,
    bookmarkLensPost,
    undoBookmarkLensPost,
  } = useLensPosts(sessionClient, getWalletClient);
  // ADDED: the same convention as in HelpRequestPage.jsx/ViolationDetailsPage.jsx -
  // the Lens Account address (the smart-contract account that actually
  // signs posts/comments), NOT the EOA wallet. Needed for
  // checkPostRateLimit() below - fetchPostsByAuthor counts specifically by
  // this address.
  const myAccountAddress =
    localStorage.getItem("lens_account_address") ||
    lensProfile?.address ||
    connectedAddress ||
    lensWalletAddress ||
    null;
  const tipJar = useTipJar();
  // ADDED: the same useLensDAO() used by CountryFeed.jsx and
  // FollowingPage.jsx for the "Report" functionality — the DAO wallet,
  // Shield/Senate SBT check (resolveSanctionTarget/proposeSanction), and
  // shieldInfo.totalSupply for computing the author's ban state.
  const dao = useLensDAO();

  // ── Helpers ──────────────────────────────────────────────────────────────
  const getAuthorWalletAddress = (p) =>
    p?.lens_users?.wallet_address || p?.author?.wallet_address || null;

  const isOwnWallet = (address) => {
    const myAddress = connectedAddress;
    return (
      !!address &&
      !!myAddress &&
      address.toLowerCase() === myAddress.toLowerCase()
    );
  };

  const getAuthorName = (item, fallback = "Anonymous") =>
    item?.lens_users?.name ||
    item?.lens_users?.unique_name ||
    item?.author?.unique_name ||
    item?.users?.unique_name ||
    fallback;

  // ADDED: a separate handle (@username) for the second name — shown
  // ALWAYS alongside name (if present), the same pattern as on the
  // profile page: name primary, @username second, muted.
  const getAuthorHandle = (item) => {
    const uname =
      item?.lens_users?.unique_name ||
      item?.author?.unique_name ||
      item?.users?.unique_name ||
      null;
    return uname ? `@${uname}` : null;
  };

  const getAuthorAvatar = (item) =>
    item?.lens_users?.avatar_url ||
    item?.author?.avatar_url ||
    item?.users?.avatar_url ||
    null;

  // FIXED: previously returned "" for EARTH/missing country — hence an
  // empty blue badge next to the name for those who hadn't specified a
  // location. Now explicitly "Planet Earth".
  const getCountryDisplayName = (countryCode) => {
    if (!countryCode || countryCode === "EARTH") {
      return t("earth") || "Planet Earth";
    }
    return getTranslatedCountryName(countryCode) || countryCode;
  };

  // ── State ─────────────────────────────────────────────────────────────────
  const [post, setPost] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // ADDED: separate states for a report on the post and a report on a
  // comment — the same ReportModal.jsx component, which is simply fed
  // either the post itself or a "post-like" object built from a comment
  // (in ReportModal there's no difference between a post and a comment —
  // both are a Lens Post, a comment just has commentOn filled in).
  const [reportModalPost, setReportModalPost] = useState(null);
  const [reportModalComment, setReportModalComment] = useState(null);
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);
  const [isSaved, setIsSaved] = useState(false);
  const [savingPost, setSavingPost] = useState(false);

  // ADDED: the shared comments hook (the same one used on
  // HelpRequestPage.jsx/ComplaintDetailsPage.jsx) instead of our own copy
  // of loadComments/handleComment/handleDeleteComment/
  // handleCommentReaction, which used to live directly in this file.
  // Placed AFTER the post state declaration above — otherwise
  // post?.lens_post_id here would reference the variable before its
  // initialization (TDZ, "Cannot access 'post' before initialization").
  const {
    comments,
    postingComment,
    postComment,
    deleteComment,
    reactToComment,
    isCommentOwner,
  } = useLensComments(
    post?.lens_post_id,
    sessionClient,
    lensProfile,
    getWalletClient,
    connectedAddress,
  );

  // ADDED: a wrapper over postComment with the shared publishing limit -
  // applied both to the quick comment on PostCard (onCommentSubmit below)
  // and to the full field in CommentsSection - both simply call the same
  // postComment(), so it's enough to wrap it once here.
  const postCommentWithLimit = async (text, mediaFiles) => {
    const rateCheck = await checkPostRateLimit(myAccountAddress, text);
    if (!rateCheck.allowed) {
      alert(rateCheck.reason);
      return;
    }
    return postComment(text, mediaFiles);
  };

  // ── Moderation state (blur/hide/critical) ────────────────────────────
  // CHANGED: previously a separate useModerationState.js hook — now right
  // here. ⚠️ fetchAllModActions() scans ALL of the app's posts (the same
  // approach already used by ModerationQueue.jsx/postReports.js — there's
  // no separate backend/index here, so the state is computed on the fly
  // from the full action log every time the page is opened).
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
    if (!post?.lens_post_id) return;
    (async () => {
      try {
        const [actions, reportsList] = await Promise.all([
          fetchAllModActions(),
          fetchAllReportComments(),
        ]);
        if (!cancelled) {
          setModState(
            computeModerationState(actions, post.lens_post_id, {
              reports: reportsList,
            }),
          );
        }
      } catch (err) {
        console.warn("⚠️ Could not load moderation state:", err.message);
        // Fail-safe: a network error shouldn't by itself either blur or
        // reveal the content.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [post?.lens_post_id]);

  // ── Load post ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!userLoading) {
      loadPost();
    }
  }, [postId, userLoading]);

  const loadPost = async () => {
    setLoading(true);
    setError("");

    try {
      const lensResult = await getLensPost(postId);

      if (!lensResult.success || !lensResult.post) {
        throw new Error(lensResult.error || "Post not found");
      }

      const lensPost = lensResult.post;

      // Adapt the normalized Lens post to the component's format
      const adaptedPost = {
        id: lensPost.id,
        lens_post_id: lensPost.lens_post_id || lensPost.id,
        lens_user_id: lensPost.author?.id || null,
        user_id: null,

        content: lensPost.content,
        media_urls: lensPost.media_urls || [],
        media_types: lensPost.media_types || [],
        country_code: lensPost.country_code,
        h3_index: lensPost.h3_index,

        created_at: lensPost.created_at,
        updated_at: lensPost.updated_at,
        last_edited_at: null,

        // ADDED: if not null — this entry is actually a comment on
        // comment_on_id, not a standalone post (see useLensPosts.js
        // normalizeLensPost). Used for the banner below.
        comment_on_id: lensPost.comment_on_id || null,

        view_count: 0,
        share_count: lensPost.reposts_count || 0,

        // Lens doesn't have users/lens_users nested — we build it from author
        users: null,
        lens_users: {
          id: lensPost.author?.id || null,
          // ADDED: name — a separate display name from Lens metadata, as
          // opposed to unique_name (that's the handle/username).
          // Previously there was no name field here at all — author.name
          // (if useLensPosts returns it) went nowhere, so there was
          // nothing to show as the second name. If useLensPosts.js does
          // NOT return author.name — this will simply be null, and the
          // second line won't be shown.
          name: lensPost.author?.name || null,
          unique_name: lensPost.author?.unique_name || "Anonymous",
          avatar_url: lensPost.author?.avatar_url || null,
          country: lensPost.country_code || null,
          wallet_address: lensPost.author?.wallet_address || null,
        },

        // Counters from the API + correction in case the testnet hasn't indexed our reaction
        truth_count: (() => {
          const apiVal = lensPost.truth_count || 0;
          const stored = localStorage.getItem(
            `lens_reaction_${lensPost.lens_post_id || lensPost.id}`,
          );
          return stored === "truth" && apiVal === 0 ? 1 : apiVal;
        })(),
        false_count: (() => {
          const apiVal = lensPost.false_count || 0;
          const stored = localStorage.getItem(
            `lens_reaction_${lensPost.lens_post_id || lensPost.id}`,
          );
          return stored === "false" && apiVal === 0 ? 1 : apiVal;
        })(),
        my_reaction: lensPost.my_reaction || null,

        // Bookmark — taken from Lens operations
        is_bookmarked: lensPost.is_bookmarked || false,
      };

      setPost(adaptedPost);
      setIsSaved(adaptedPost.is_bookmarked);
    } catch (err) {
      console.error("❌ Error loading post:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // ── isOwner ───────────────────────────────────────────────────────────────
  // FIXED: previously compared against userInfo.id — which is a Supabase
  // UUID (from lens_users), whereas post.lens_user_id/comment.author.id
  // is the author's Lens address. Two different formats could never
  // match, so this condition was dead code — only the second one (wallet
  // comparison) saved it. Now we compare address with address.
  const isOwner =
    lensProfile &&
    post &&
    (post.lens_user_id === lensProfile.address ||
      post.lens_users?.wallet_address?.toLowerCase() ===
        connectedAddress?.toLowerCase());

  // ── Reactions on post ─────────────────────────────────────────────────────
  const handleReaction = async (reactionType) => {
    if (!lensProfile) {
      alert(t("login_to_react") || "Please log in to react");
      return;
    }
    if (!post?.lens_post_id) return;

    const lensPostId = post.lens_post_id;
    const prevReaction = post.my_reaction;
    const isToggleOff = prevReaction === reactionType;
    const nextReaction = isToggleOff ? null : reactionType;
    const oppositeType = reactionType === "truth" ? "false" : "truth";

    // Computes the new counter state from the current post
    const computeNext = (base, reaction) => {
      let truth = base.truth_count || 0;
      let falseCount = base.false_count || 0;
      if (base.my_reaction === "truth") truth = Math.max(0, truth - 1);
      if (base.my_reaction === "false")
        falseCount = Math.max(0, falseCount - 1);
      if (reaction === "truth") truth += 1;
      if (reaction === "false") falseCount += 1;
      return { truth, falseCount };
    };

    // Optimistic UI update
    const { truth, falseCount } = computeNext(post, nextReaction);
    setPost((prev) => ({
      ...prev,
      my_reaction: nextReaction,
      truth_count: truth,
      false_count: falseCount,
    }));

    let clearedStrayPrev = false;
    try {
      // FIXED: the same issue that was found and fixed in
      // CountryFeed.jsx/FollowingPage.jsx — the "defensive cleanup" of the
      // opposite reaction used to be called UNCONDITIONALLY on every
      // click, even when prevReaction === null (the first vote on the
      // post, the opposite reaction didn't exist yet). The Lens testnet,
      // as it turns out, counts undoing a nonexistent reaction as a real
      // opposite reaction. Now cleanup only happens on an actual switch
      // (prevReaction === oppositeType).
      if (prevReaction === oppositeType) {
        const cleanupResult = await removeLensReaction(
          lensPostId,
          oppositeType,
        );
        clearedStrayPrev = cleanupResult.success;
      }

      if (isToggleOff) {
        await removeLensReaction(lensPostId, reactionType);
        localStorage.removeItem(`lens_reaction_${lensPostId}`);
      } else {
        const result = await addLensReaction(lensPostId, reactionType);
        if (!result.success) {
          throw new Error(result.error || "Reaction failed");
        }
        localStorage.setItem(`lens_reaction_${lensPostId}`, reactionType);
      }
    } catch (err) {
      console.error("❌ Error handling reaction:", err);
      // Rollback to the previous state
      const rollbackReaction = clearedStrayPrev ? null : prevReaction;
      const { truth: rt, falseCount: rf } = computeNext(post, rollbackReaction);
      setPost((prev) => ({
        ...prev,
        my_reaction: rollbackReaction,
        truth_count: rt,
        false_count: rf,
      }));
    }
  };

  // ── Post comment ──────────────────────────────────────────────────────────
  // ── Delete comment ────────────────────────────────────────────────────────
  // ── Delete post ───────────────────────────────────────────────────────────
  const handleDeletePost = async () => {
    if (
      !window.confirm(
        t("confirm_delete_post") ||
          "Are you sure you want to delete this post?",
      )
    )
      return;

    if (!post?.lens_post_id) return;

    try {
      const result = await deleteLensPost(post.lens_post_id);
      if (!result.success) {
        throw new Error(result.error || "Delete failed");
      }
      alert(t("post_deleted") || "Post deleted");
      navigate(-1);
    } catch (err) {
      console.error("❌ Error deleting post:", err);
      alert(t("delete_error") || "Error deleting post");
    }
  };

  // ── Report post ───────────────────────────────────────────────────────────
  // CHANGED: previously there was just an alert with instructions ("Lens
  // has no native reports"). Now the same ReportModal.jsx functionality
  // used on CountryFeed.jsx/FollowingPage.jsx — a structured Lens comment
  // carrying the report + (for Shield/Senate holders) an immediate
  // on-chain sanction proposal.
  const handleReportPost = async () => {
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

  // ── Report comment ────────────────────────────────────────────────────────
  // ADDED: the same report flow, now for comments too. ReportModal
  // expects a post-like object with content/media_urls/media_types/
  // lens_post_id fields — we build it from the comment below, before
  // rendering the modal.
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

  // ── Save / Bookmark ───────────────────────────────────────────────────────
  const handleSavePost = async () => {
    if (!lensProfile) {
      alert(t("login_to_save") || "Please log in to save posts");
      return;
    }
    if (!post?.lens_post_id) return;

    try {
      setSavingPost(true);

      if (isSaved) {
        const result = await undoBookmarkLensPost(post.lens_post_id);
        if (result.success) {
          setIsSaved(false);
        }
      } else {
        const result = await bookmarkLensPost(post.lens_post_id);
        if (result.success) {
          setIsSaved(true);
        }
      }
    } catch (err) {
      console.error("❌ Error saving post:", err);
      alert(t("save_error") || "Error saving post");
    } finally {
      setSavingPost(false);
    }
  };

  // CHANGED: repost/copy link/share to social media is now entirely
  // inside <PostCard/> (SharePostModal) — this file no longer holds
  // showShareModal/copyStatus, nor its own copyToClipboard/shareToSocial.
  // The original behavior (Lens has no repost here — it just opens the
  // modal) is preserved: onShare below isn't passed to PostCard at all.

  // ── Logout ────────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    try {
      localStorage.removeItem("lens_wallet_address");
      localStorage.removeItem("lens_account_address");
      navigate("/");
    } catch (err) {
      console.error(t("logout_error"), err);
      alert(t("logout_failed"));
    }
  };

  // ── Utils ─────────────────────────────────────────────────────────────────
  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t("just_now") || "just now";
    if (diffMins < 60) return `${diffMins} ${t("minutes_ago") || "min ago"}`;
    if (diffHours < 24) return `${diffHours} ${t("hours_ago") || "hours ago"}`;
    if (diffDays < 7) return `${diffDays} ${t("days_ago") || "days ago"}`;
    return date.toLocaleDateString();
  };

  // ── userProfile for Layout ────────────────────────────────────────────────
  // FIXED: previously built from userInfo (Supabase-style fields + email,
  // which simply doesn't exist on a Lens account). Now from lensProfile,
  // with the same field names Layout expects (uniqueName, avatarUrl,
  // lensAccountAddress) — the same convention used in ProfilePage.
  const userProfile = lensProfile
    ? {
        uniqueName: lensProfile.localName,
        name: lensProfile.name,
        avatarUrl: lensProfile.avatar,
        bio: lensProfile.bio,
        country: lensProfile.country,
        lensAccountAddress: lensProfile.address,
        walletAddress: lensWalletAddress,
        hasCompletedOnboarding: lensProfile.hasCompletedOnboarding ?? true,
      }
    : null;

  // ── Render guards ─────────────────────────────────────────────────────────
  if (userLoading) {
    return (
      <Layout userProfile={null} loading={true}>
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500" />
        </div>
      </Layout>
    );
  }

  if (loading) {
    return (
      <Layout userProfile={userProfile} loading={false}>
        <div className="flex justify-center items-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500" />
        </div>
      </Layout>
    );
  }

  if (error || !post) {
    return (
      <Layout userProfile={userProfile} loading={false}>
        <div className="text-center py-12 text-red-600 dark:text-red-400">
          <p>{error || t("post_not_found") || "Post not found"}</p>
          <button
            onClick={() => navigate(-1)}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-full hover:bg-blue-700"
          >
            {t("go_back") || "Back"}
          </button>
        </div>
      </Layout>
    );
  }

  const reactionCounts = {
    truth: post.truth_count || 0,
    false: post.false_count || 0,
  };

  // ── Main render ───────────────────────────────────────────────────────────
  return (
    <Layout
      userProfile={userProfile}
      onLogout={handleLogout}
      loading={loading}
      error={error}
      onCreatePost={() => setShowCreatePostModal(true)}
    >
      <div className="h-full">
        {showCreatePostModal ? (
          <div className="h-full">
            <CreatePostModal
              onClose={() => setShowCreatePostModal(false)}
              userCountry={lensProfile?.country || "EARTH"}
            />
          </div>
        ) : (
          <div className="max-w-4xl mx-auto h-full space-y-4">
            {/* Back button */}
            <button
              onClick={() => navigate(-1)}
              className="inline-flex items-center gap-2 text-[12px] text-slate-600 dark:text-white/40 hover:text-slate-600 dark:hover:text-white/60 transition-colors mb-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {t("back") || "Back"}
            </button>

            {/* ADDED: if the opened entry is actually a comment (not a
                standalone post) — a banner linking to the parent entry.
                We don't make a separate page for comments (a comment in
                Lens v3 is itself a Post, so showing it via this same
                PostPage.jsx is fully correct) — we just add context on
                where it came from, so the connection isn't lost. */}
            {post.comment_on_id && (
              <button
                onClick={() => navigate(`/post/${post.comment_on_id}`)}
                className="w-full flex items-center gap-2 px-3 py-2 text-[12px] text-blue-600 dark:text-blue-400/75 bg-blue-50 dark:bg-blue-500/[0.06] border border-blue-200 dark:border-blue-500/20 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-500/[0.1] transition-colors text-left"
              >
                💬{" "}
                {t("this_is_a_comment_reply_to") ||
                  "This is a comment — view the entry it was written on"}{" "}
                →
              </button>
            )}

            {/* Post card — a shared component, the same one used on
                CountryFeed.jsx/FollowingPage.jsx. Extracted into a
                variable so it can be shown below either normally, or
                blurred/hidden — without duplicating the JSX itself. */}
            {(() => {
              const mainContentNode = (
                <PostCard
                  post={{
                    id: post.id,
                    content: post.content,
                    createdAt: post.created_at,
                    editedAt: post.last_edited_at,
                    author: {
                      address: getAuthorWalletAddress(post),
                      name: getAuthorName(post, t("anonymous")),
                      handle: getAuthorHandle(post),
                      avatar: getAuthorAvatar(post),
                    },
                    media: (post.media_urls || []).map((url, index) => ({
                      url,
                      type: post.media_types?.[index] || "document",
                    })),
                    commentCount: comments.length,
                    shareCount: post.share_count,
                  }}
                  countryBadge={
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/25 border border-blue-300/50 dark:border-blue-700/20 text-blue-700 dark:text-blue-400/65 flex-shrink-0">
                      {getCountryDisplayName(post.lens_users?.country)}
                    </span>
                  }
                  reaction={{
                    truth: reactionCounts.truth,
                    false: reactionCounts.false,
                    mine: post.my_reaction || null,
                  }}
                  isOwner={isOwner}
                  isSaved={isSaved}
                  isSaving={savingPost}
                  tipButton={
                    // FIX: previously the "Support" button was hidden only
                    // by isOwnWallet() — a comparison against the wallet
                    // address from wagmi (walletClient?.account?.address),
                    // which may not match lens_users.wallet_address
                    // (different format/load timing) even for one's own
                    // post. Added !isOwner — the same reliable Lens
                    // address match already used to check the delete/edit
                    // menu above. Now the user can't tip themselves, as it
                    // should be (this already worked on
                    // CountryPage/CountryFeed.jsx
                    // it worked correctly there, since the button is tied specifically to isOwner).
                    getAuthorWalletAddress(post) &&
                    !isOwner &&
                    !isOwnWallet(getAuthorWalletAddress(post)) ? (
                      <TipButton
                        author={{
                          wallet_address: getAuthorWalletAddress(post),
                        }}
                        lensPostId={post.lens_post_id || post.id}
                        tipJar={tipJar}
                      />
                    ) : null
                  }
                  onReaction={handleReaction}
                  onSave={handleSavePost}
                  // CHANGED: Lens has no repost here — PostCard simply
                  // opens the share modal after a click (onShare?.() —
                  // no-op), the same way the old handleSharePost did.
                  onDelete={handleDeletePost}
                  onReport={handleReportPost}
                  onAuthorClick={() =>
                    navigate(`/user/${post.lens_user_id || post.user_id}`)
                  }
                  // FIX: PostCard calls onCommentSubmit(text, mediaFiles)
                  // — previously the second argument was dropped here
                  // ((text) => postComment(text)), so emoji and text from
                  // the inline comment field were sent, but attached media
                  // files weren't (silently lost at this layer).
                  onCommentSubmit={(text, mediaFiles) =>
                    postCommentWithLimit(text, mediaFiles)
                  }
                  onCommentIconClick={() =>
                    document
                      .getElementById("comments-section")
                      ?.scrollIntoView({ behavior: "smooth" })
                  }
                  // FIX: on PostPage there's already a full
                  // <CommentsSection/> below the card — the inline
                  // single-line comment field in the card itself is no
                  // longer needed here and duplicated it.
                  // showQuickComment=false hides this field; by default
                  // (true) it remains in the feed on
                  // CountryPage/CountryFeed.jsx.
                  showQuickComment={false}
                  // ADDED: this card IS the full post here — without this,
                  // it clamped text/media the same way the feed preview
                  // does, so opening the full post still showed a
                  // truncated card with its own "Дивитись повністю"
                  // button pointing at the page the user is already on.
                  disablePreview
                />
              );

              // ── Hidden (hide/critical_hide) — stricter than blur:
              // we don't show the content at all, only the reason.
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

              // ── Blurred (blur) — can be locally revealed.
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

            {/* Comments section — a shared component, the same one used
                on HelpRequestPage.jsx/ComplaintDetailsPage.jsx. */}
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

      {/* ADDED: report on the post — the same ReportModal.jsx used on
          CountryFeed.jsx/FollowingPage.jsx. */}
      {reportModalPost && (
        <ReportModal
          post={reportModalPost}
          authorAddress={getAuthorWalletAddress(reportModalPost)}
          authorCandidates={[
            getAuthorWalletAddress(reportModalPost),
            reportModalPost.author?.owner_address,
          ].filter(Boolean)}
          createLensComment={createLensComment}
          sessionClient={sessionClient}
          countryCode={lensProfile?.country || "EARTH"}
          dao={dao}
          onClose={() => setReportModalPost(null)}
        />
      )}

      {/* ADDED: report on a comment — the same ReportModal.jsx, fed a
          "post-like" object built from the comment (for ReportModal a
          comment is just another Lens Post). */}
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

export default PostPage;
