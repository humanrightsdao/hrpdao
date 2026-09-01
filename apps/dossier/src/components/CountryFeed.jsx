// src/components/CountryFeed.jsx
import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Globe } from "lucide-react";
import { useCountry } from "../hooks/useCountry";
import useLensPosts from "../hooks/useLensPosts";
import { useLensAuth } from "../context/LensAuthContext";
import TipButton from "./TipButton";
import PostCard from "./PostCard";
import { useLensProfile } from "../hooks/useLensProfile";
import { useLensDAO } from "../hooks/useLensDAO";
import ReportModal from "./ReportModal";
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";
// ADDED: reports (postReports.js) - needed for auto-quarantine
// (computeModerationState(..., { reports })) - the same spike in reports
// over a short window that ModerationQueue.jsx already shows to
// moderators is now also applied immediately as a temporary blur in the feed itself.
import { fetchAllReportComments } from "../utils/postReports";
// ADDED: the shared publishing limit (1/min, 10/hr, 20/day - a single
// counter for posts and comments) - checkPostRateLimit() reads the
// author's actual history directly from Lens, not localStorage (see the
// comment in that file itself for the reasons).
import { checkPostRateLimit } from "../utils/postRateLimit";

// CHANGED: the post card is now the shared <PostCard/> (src/components/
// PostCard.jsx), the same one used by FollowingPage.jsx. All of the
// card's markup/functionality (reactions, comments, bookmarking,
// reposting, tips, menu, media, moderation blur) has been extracted
// there once, instead of being duplicated. This file is now responsible
// only for: fetching posts (getCountryPosts/getUserPosts, with
// H3/country/user support), computing derived state
// (reactions/bookmarks/moderation), and normalizing a post into the
// shape PostCard expects.
const CountryFeed = ({
  countryCode,
  filterByCountry = false,
  userId = null,
  walletAddress = null,
  h3Cell = null,
  // ADDED: an array of GRID_RESOLUTION (level 3) H3 cells — this is
  // what actually filters the feed on the backend. One element = the
  // old behavior (a hexagon selected directly at level 3). Several
  // elements = a selected coarser hexagon (level 0/1/2) converted into
  // its level-3 child cells (see CountryPage.jsx). If provided — it
  // takes priority over the legacy h3Cell.
  h3Cells = null,
  filterByH3 = false,
}) => {
  const { t, i18n } = useTranslation();
  // See the analogous comment in CountryPage.jsx: i18next returns the
  // key itself for a missing translation, so the usual `t(key) || fallback` doesn't work.
  const tf = (key, fallback) => {
    const val = t(key);
    return val && val !== key ? val : fallback;
  };

  // ADDED: a user without a specified location has neither an h3 index
  // nor a "real" country (the sentinel "EARTH" is used / the field is
  // absent) — such a post physically cannot belong to any hexagon.
  // However, the backend (getLensCountryPosts) for some reason still
  // returns these posts in any h3Cell-filtered request — so we remove
  // them here, client-side, whenever hexagon filtering is active. The
  // logic is identical to getAuthorCountry further down (the same set of
  // fields), extracted separately so it's available inside loadPosts.
  const postHasNoLocation = (post) => {
    const country =
      post.users?.country ||
      post.lens_users?.country ||
      post.author?.country ||
      post.country_code ||
      null;
    return !country || country === "EARTH";
  };
  const navigate = useNavigate();
  const lensWalletAddress = localStorage.getItem("lens_wallet_address");
  const { profile: lensProfile } = useLensProfile(lensWalletAddress);
  const {
    sessionClient,
    sessionRestoring,
    getWalletClient,
    address: connectedAddress,
  } = useLensAuth();
  const { getTranslatedCountryName } = useCountry(i18n.language);
  const dao = useLensDAO();
  const [reportModalPost, setReportModalPost] = useState(null);
  const [posts, setPosts] = useState([]);
  // ADDED: guards handleReaction() against double-clicks — a reaction
  // is a real API round-trip (possibly two calls: clear-opposite +
  // add/remove), not an instant local update, so without this a fast
  // double-click could dispatch the same reaction twice concurrently.
  const [reactingPostIds, setReactingPostIds] = useState(new Set());
  // FIXED: the state Set above is gated by setReactingPostIds(), which
  // is async/batched — two clicks landing in the same tick (a real
  // fast double-click, a duplicate touch-tap event, etc.) can BOTH
  // read the OLD Set before either update lands, so both slip past the
  // "already in flight" check and fire the Lens mutation concurrently
  // (this is consistent with a single click producing multiple
  // reaction records on the same post). reactingPostIdsRef is a plain
  // mutable Set that's checked AND marked in the same synchronous
  // statement, so there's no window for a second call to sneak through
  // — it's the real gate now; the state copy above is left in place
  // only in case a future UI (e.g. a spinner on the button) wants to
  // read it.
  const reactingPostIdsRef = useRef(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  // FIXED: previously the pagination cursor wasn't stored at all — all
  // three branches below (getUserPosts/getCountryPosts with H3/
  // getCountryPosts without H3) always passed `null` as the second
  // argument, so "Load more" kept re-fetching the same first page of the
  // Lens feed instead of the next one. lensResult.nextCursor is now
  // stored here and passed into the next loadPosts() call.
  const [cursor, setCursor] = useState(null);
  // ADDED: a token for the current feed request. Filtering by a coarse
  // hexagon (level 0/1/2) can take several seconds (dozens of parallel
  // requests across child cells) — if the user manages to change the
  // level/hexagon during that time, the old "slow" request shouldn't
  // overwrite an already more current result. The token is incremented
  // at the start of every loadPosts(), and the result is applied only if
  // the token is still the freshest one.
  const h3FetchTokenRef = useRef(0);
  const [sharing, setSharing] = useState({});
  const [savedStatuses, setSavedStatuses] = useState({});
  const [savingPosts, setSavingPosts] = useState({});
  // ADDED: the moderation action log (blur/hide/critical/ban) from
  // utils/moderationActions.js - the same Lens-native pattern as the
  // reports. Loaded once on mount; CountryFeed computes each post's/
  // author's current state from it during render (computeModerationState/
  // computeBanState), the same way ModerationQueue.jsx computes it for itself.
  const [modActions, setModActions] = useState([]);
  // ADDED: totalSupply() of the Shield SBT directly from the blockchain
  // via fetchShieldTotalSupply() — unlike dao.shieldInfo?.totalSupply,
  // which is only populated AFTER dao.connect()/silentConnect(). A
  // regular CountryFeed visitor doesn't connect a wallet just to scroll
  // the feed, so dao.shieldInfo was always empty → totalEligibleVoters in
  // computeBanState() below was always 0 → the quorum was always 0% →
  // banned was always false, regardless of the actual number of ban
  // votes. Because of this, banned authors were never actually hidden.
  const [shieldTotalSupply, setShieldTotalSupply] = useState(0);
  // ADDED: reports on posts (not just moderation actions) - needed
  // separately for auto-quarantine (findAutoQuarantineTrigger inside
  // computeModerationState). The same Lens-native list already read by
  // ModerationQueue.jsx for the queue.
  const [reports, setReports] = useState([]);
  // Posts the user has chosen to reveal despite the blur - only within
  // this browser session, ephemeral, doesn't affect what others see.
  const [revealedBlurred, setRevealedBlurred] = useState(new Set());
  // ADDED: while modActions/shieldTotalSupply hasn't loaded yet, the
  // feed's first render happened WITHOUT the ban filter — a banned
  // author briefly appeared, then disappeared once the data finished
  // loading. modReady keeps the feed in a loading state until sanctions
  // have been computed at least once.
  const [modReady, setModReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchAllModActions(),
      fetchAllReportComments(),
      fetchShieldTotalSupply(),
    ])
      .then(([actions, reportsList, supply]) => {
        if (!cancelled) {
          setModActions(actions);
          setReports(reportsList);
          setShieldTotalSupply(supply);
        }
      })
      .catch((err) => {
        console.warn(
          "⚠️ Failed to load moderation/report data:",
          err.message,
        );
      })
      .finally(() => {
        if (!cancelled) setModReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // CHANGED (embedded wallet): previously read useWalletClient()
  // directly (see history in git blame) and passed the raw value into
  // useLensPosts — duplicating the same "frozen closure" hazard
  // LensAuthContext.getWalletClient() already solves once, app-wide.
  // getWalletClient (destructured from useLensAuth() above, alongside
  // sessionClient) is the function itself; useLensPosts now resolves
  // the actual client fresh at write-time, correctly, for the embedded
  // wallet, a linked external wallet, or WalletConnect alike.
  const {
    createLensComment,
    deleteLensPost,
    getCountryPosts: getLensCountryPosts,
    getUserPosts: getLensUserPosts,
    bookmarkLensPost,
    undoBookmarkLensPost,
    repostLensPost,
    addLensReaction,
    removeLensReaction,
    getLensPost,
  } = useLensPosts(sessionClient, getWalletClient);

  // ADDED: normalize h3Cells/h3Cell into a single list of cells for
  // filtering. h3Cells (an array) takes priority; h3Cell (legacy, a
  // single cell) remains for compatibility with older calls to the component.
  const effectiveH3Cells =
    filterByH3 && h3Cells && h3Cells.length
      ? h3Cells
      : filterByH3 && h3Cell
        ? [h3Cell]
        : null;
  // A stable primitive key for useEffect — the effectiveH3Cells array
  // is recreated on every render, so comparison must be by content, not
  // by reference identity.
  const h3CellsKey = effectiveH3Cells ? effectiveH3Cells.join(",") : "";

  const getCountryDisplayName = (countryCode) => {
    if (!countryCode || countryCode === "EARTH") {
      return t("earth") || "Planet Earth";
    }
    const translated = getTranslatedCountryName(countryCode);
    return translated || countryCode;
  };

  useEffect(() => {
    if (sessionRestoring) return;

    setPage(0);
    setPosts([]);
    setCursor(null);
    loadPosts(true);
  }, [
    countryCode,
    filterByCountry,
    userId,
    walletAddress,
    h3CellsKey,
    filterByH3,
    sessionRestoring,
    sessionClient,
  ]);

  // FIXED (root cause of "Правда" duplicating onto "Неправда"): this used
  // to be withStoredReactionFallback(), which unconditionally overwrote
  // my_reaction with whatever was in localStorage (`lens_reaction_<id>`)
  // — even fudging truth_count/false_count up by one to match. Once that
  // localStorage value drifted from the real Lens backend (e.g. from an
  // earlier reaction attempt that looked like it succeeded locally but
  // never actually landed server-side while the wallet-connection bugs
  // were still present), the app believed the user had an opposite
  // reaction that didn't really exist. The "switch reactions" cleanup
  // logic in handleReaction() below then called undoReaction() on that
  // phantom reaction — and Lens's API does not treat that as a safe
  // no-op; it can register the reaction instead of clearing it. That's
  // exactly how clicking "Правда" bumped "Неправда" too. my_reaction now
  // comes straight from Lens's own operations.hasUpvoted/hasDownvoted
  // (set in normalizeLensPost, useLensPosts.js) — the real, authoritative
  // record — so there's nothing left here to override it with.

  const loadPosts = async (resetPage = false) => {
    // A new request always "preempts" any previous still-pending slow
    // (multi-cell) request — see the comment on h3FetchTokenRef.
    const myFetchToken = ++h3FetchTokenRef.current;
    try {
      setLoading(true);
      const currentCursor = resetPage ? null : cursor;

      const isEvmAddress = (addr) =>
        typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr);

      const effectiveWalletAddress =
        (isEvmAddress(walletAddress) && walletAddress) ||
        (isEvmAddress(userId) && userId) ||
        null;

      if (userId || walletAddress) {
        if (!effectiveWalletAddress) {
          console.warn(
            "⚠️ CountryFeed: could not determine an EVM address for the user post filter. " +
              "Pass a walletAddress prop with the profile's real wallet address (not the Supabase userId).",
            { userId, walletAddress },
          );
          setPosts([]);
          setHasMore(false);
          setError("");
          setLoading(false);
          return;
        }

        const lensResult = await getLensUserPosts(
          effectiveWalletAddress,
          currentCursor,
        );

        if (!lensResult.success)
          throw new Error(lensResult.error || "Lens fetch failed");

        const updatedPosts = resetPage
          ? lensResult.posts
          : [...posts, ...lensResult.posts];

        setPosts(updatedPosts);
        setHasMore(lensResult.hasMore);
        setCursor(lensResult.nextCursor || null);
        setError("");
        setLoading(false);
        return;
      }

      if (effectiveH3Cells && effectiveH3Cells.length > 0) {
        // FIXED: the Lens GraphQL API allows a MAXIMUM of 10 values in
        // tags.oneOf at a time (confirmed in practice — longer arrays
        // produce a GraphQL validation error). So we split
        // effectiveH3Cells into chunks of 10 and, if there's more than
        // one chunk, fire them ALL AT ONCE in parallel (Promise.all) —
        // rather than in sequential "waves" as in the previous version —
        // so the total time is closer to a single round-trip, rather
        // than the sum of several.
        const CHUNK_SIZE = 10;
        const chunks = [];
        for (let i = 0; i < effectiveH3Cells.length; i += CHUNK_SIZE) {
          chunks.push(effectiveH3Cells.slice(i, i + CHUNK_SIZE));
        }

        if (chunks.length === 1) {
          // The most common case: level 3 (1 cell), level 2 (up to 7),
          // or generally ≤10 child cells — a single request, regular
          // cursor pagination works as usual.
          const lensResult = await getLensCountryPosts(
            filterByCountry ? countryCode : "EARTH",
            currentCursor,
            chunks[0],
          );

          if (h3FetchTokenRef.current !== myFetchToken) return;

          if (!lensResult.success)
            throw new Error(lensResult.error || "Lens fetch failed");

          // ADDED: remove posts without a location — see the comment on
          // postHasNoLocation() above.
          const filteredPagePosts = lensResult.posts.filter(
            (p) => !postHasNoLocation(p),
          );

          const updatedPosts = resetPage
            ? filteredPagePosts
            : [...posts, ...filteredPagePosts];

          setPosts(updatedPosts);
          setHasMore(lensResult.hasMore);
          setCursor(lensResult.nextCursor || null);
          setError("");
          setLoading(false);
          return;
        }

        // Several chunks (level 0/1 with a large number of child cells)
        // — no single cursor can correctly mark a position across
        // several independent requests at once, so pagination here is
        // simplified: the first "page" from EACH chunk, merged and
        // sorted by date; the "Load more" button isn't shown. For
        // precise pagination — level 2/3.
        const chunkResults = await Promise.all(
          chunks.map((chunk) =>
            getLensCountryPosts(
              filterByCountry ? countryCode : "EARTH",
              null,
              chunk,
            ).catch((err) => {
              console.error("❌ Error loading posts for H3 chunk:", chunk, err);
              return { success: false };
            }),
          ),
        );

        if (h3FetchTokenRef.current !== myFetchToken) return;

        let anyFailed = false;
        const allPosts = [];
        chunkResults.forEach((result) => {
          if (result?.success) {
            allPosts.push(...result.posts);
          } else {
            anyFailed = true;
          }
        });

        const dedupedPosts = Array.from(
          new Map(
            allPosts.filter((p) => !postHasNoLocation(p)).map((p) => [p.id, p]),
          ).values(),
        ).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

        setPosts(dedupedPosts);
        setHasMore(false);
        setCursor(null);
        setError(
          anyFailed
            ? tf(
                "some_hexagons_failed",
                "Some parts of the selected hexagon could not be loaded",
              )
            : "",
        );
        setLoading(false);
        return;
      }

      if (filterByH3 && !effectiveH3Cells) {
        // ADDED: filterByH3 is on, but there are no cells to filter by
        // (e.g. CountryPage deliberately turned off feed filtering for a
        // too-coarse level — see MAX_HEX_FEED_CELLS). We show the
        // regular country/planet feed with no hexagon filter.
      }

      const lensResult = await getLensCountryPosts(
        filterByCountry ? countryCode : "EARTH",
        currentCursor,
      );

      if (!lensResult.success)
        throw new Error(lensResult.error || "Lens fetch failed");

      const updatedPosts = resetPage
        ? lensResult.posts
        : [...posts, ...lensResult.posts];

      setPosts(updatedPosts);
      setHasMore(lensResult.hasMore);
      setCursor(lensResult.nextCursor || null);
      setError("");
    } catch (error) {
      console.error("❌ Error loading posts:", error);
      setError(error.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSavePost = async (postId) => {
    try {
      setSavingPosts((prev) => ({ ...prev, [postId]: true }));

      const post = posts.find((p) => p.id === postId);
      const lensId = post?.lens_post_id;
      const currentlySaved = savedStatuses[postId];

      if (lensId) {
        const result = currentlySaved
          ? await undoBookmarkLensPost(lensId)
          : await bookmarkLensPost(lensId);

        if (result.success) {
          const newStatus = !currentlySaved;
          setSavedStatuses((prev) => ({ ...prev, [postId]: newStatus }));
        }
      } else {
        alert(
          t("save_not_supported") || "Bookmarking isn't supported for this post",
        );
      }
    } catch (error) {
      console.error("❌ Error in handleSavePost:", error);
    } finally {
      setSavingPosts((prev) => ({ ...prev, [postId]: false }));
    }
  };

  // CHANGED: no longer manages the share modal — PostCard itself shows
  // it after calling onShare (regardless of the repost's success, as before).
  const handleSharePost = async (postId) => {
    try {
      setSharing((prev) => ({ ...prev, [postId]: true }));

      const post = posts.find((p) => p.id === postId);
      const lensId = post?.lens_post_id;

      if (lensId) {
        await repostLensPost(lensId);
      }
    } catch (error) {
      console.error("❌ Error sharing post:", error);
    } finally {
      setSharing((prev) => ({ ...prev, [postId]: false }));
    }
  };

  const handleReaction = async (postId, reactionType) => {
    if (sessionRestoring) return;

    const activeAccountAddress = localStorage.getItem("lens_account_address");
    if (!sessionClient || !activeAccountAddress) {
      alert(t("login_to_react") || "Please log in to react");
      return;
    }

    const snapshot = posts.find((p) => p.id === postId);
    if (!snapshot?.lens_post_id) return;
    // FIXED: was `if (reactingPostIds.has(postId)) return;` — reading
    // React state here left a real race window (see the comment on
    // reactingPostIdsRef above). Checking-and-marking the ref in one
    // synchronous step means a second call arriving before this one
    // has finished is rejected immediately, every time.
    if (reactingPostIdsRef.current.has(postId)) return;
    reactingPostIdsRef.current.add(postId);

    const lensPostId = snapshot.lens_post_id;
    // FIXED (root cause of "Правда" duplicating onto "Неправда"): the
    // previous version computed the next counts itself (+1/-1) and
    // decided whether to clean up the opposite reaction from a LOCAL
    // guess (my_reaction from the last render, or — before that —
    // straight from localStorage). Either source can disagree with
    // what Lens actually has on record, and calling undoReaction() on a
    // reaction that doesn't really exist there is not a safe no-op — it
    // can register that reaction instead of clearing it. There is now
    // NO client-side math and NO localStorage anywhere in this flow:
    // we call Lens's API based on the post's current my_reaction (itself
    // last set from Lens's own operations.hasUpvoted/hasDownvoted), and
    // once the call succeeds we refetch that exact post from Lens and
    // replace it wholesale — the screen always shows exactly what Lens
    // has, never a locally computed approximation.
    const prevReaction = snapshot.my_reaction || null;
    const isTogglingOff = prevReaction === reactionType;
    const oppositeType = reactionType === "truth" ? "false" : "truth";

    setReactingPostIds((prev) => new Set(prev).add(postId));

    try {
      if (isTogglingOff) {
        const result = await removeLensReaction(lensPostId, reactionType);
        if (!result.success) throw new Error(result.error);
      } else {
        // Only clear the opposite reaction when it's really there,
        // per Lens itself (prevReaction), not a guess.
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

      const fresh = await getLensPost(lensPostId);
      if (fresh.success) {
        setPosts((prev) =>
          prev.map((p) => (p.id === postId ? { ...p, ...fresh.post } : p)),
        );
      }
    } catch (err) {
      console.error("❌ Error handling reaction:", err);
      alert(
        (t("reaction_save_error") || "Failed to save the reaction") +
          ": " +
          err.message,
      );
    } finally {
      reactingPostIdsRef.current.delete(postId);
      setReactingPostIds((prev) => {
        const next = new Set(prev);
        next.delete(postId);
        return next;
      });
    }
  };

  // FIX: handleComment previously accepted only (postId, content) and
  // had an early `if (!content?.trim()) return;` — so a comment with
  // ONLY an image (no text) from the quick field in PostCard.jsx was
  // silently dropped before any request was even made (no console logs),
  // and the attached file never reached createLensComment.
  const handleComment = async (postId, content, mediaFiles = []) => {
    if (!content?.trim() && mediaFiles.length === 0) return;

    const post = posts.find((p) => p.id === postId);
    if (!post?.lens_post_id) {
      console.warn(
        "⚠️ handleComment: the post has no lens_post_id, commenting is impossible",
      );
      return;
    }

    // ADDED: the shared publishing limit - a comment counts against the
    // same counter as regular posts/violations/help requests.
    const myAddressForLimit =
      localStorage.getItem("lens_account_address") ||
      lensProfile?.address ||
      connectedAddress ||
      lensWalletAddress ||
      null;
    const rateCheck = await checkPostRateLimit(myAddressForLimit, content);
    if (!rateCheck.allowed) {
      alert(rateCheck.reason);
      return;
    }

    try {
      const lensResult = await createLensComment({
        content: content?.trim() || "",
        commentOn: post.lens_post_id,
        countryCode: lensProfile?.country || "EARTH",
        mediaFiles,
      });

      if (!lensResult.success) {
        throw new Error(
          lensResult.error || "Failed to publish the comment on Lens",
        );
      }

      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? { ...p, comments_count: getCommentCount(p) + 1 }
            : p,
        ),
      );
    } catch (error) {
      console.error("❌ Error adding comment:", error);
      alert(
        (t("comment_save_error") || "Failed to add the comment") +
          ": " +
          error.message,
      );
    }
  };

  const handleDeletePost = async (postId) => {
    if (
      !window.confirm(
        t("confirm_delete_post") ||
          "Are you sure you want to delete this post?",
      )
    ) {
      return;
    }

    try {
      const post = posts.find((p) => p.id === postId);
      if (!post?.lens_post_id) {
        throw new Error("The post has no lens_post_id — deletion is impossible");
      }

      const result = await deleteLensPost(post.lens_post_id);
      if (!result.success) {
        throw new Error(result.error || "Failed to delete the post on Lens");
      }

      setPosts((prev) => prev.filter((p) => p.id !== postId));
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

  const getReactionCounts = (post) => ({
    truth: post.truth_count || 0,
    false: post.false_count || 0,
  });

  const getCommentCount = (post) =>
    post.comments_count ??
    post.comment_count ??
    post.stats?.comments ??
    post.post_comments?.length ??
    0;

  const getAuthorWalletAddress = (post) =>
    post.lens_user_id ||
    post.lens_users?.wallet_address ||
    post.author?.wallet_address ||
    post.users?.wallet_address ||
    null;

  const isOwnWallet = (address) => {
    if (!address) return false;
    const lowerAddr = address.toLowerCase();
    const lensAccountAddr = localStorage.getItem("lens_account_address");
    const candidates = [
      lensAccountAddr,
      lensProfile?.address,
      connectedAddress,
      lensWalletAddress,
    ];
    return candidates.some((c) => c && c.toLowerCase() === lowerAddr);
  };

  const getAuthorName = (post, fallback = t("anonymous")) =>
    post.author?.name ||
    post.lens_users?.name ||
    post.users?.name ||
    post.users?.unique_name ||
    post.lens_users?.unique_name ||
    post.author?.unique_name ||
    fallback;

  const getAuthorHandle = (post) => {
    const uname =
      post.users?.unique_name ||
      post.lens_users?.unique_name ||
      post.author?.unique_name ||
      null;
    return uname ? `@${uname}` : null;
  };

  const getAuthorAvatar = (post) =>
    post.users?.avatar_url ||
    post.author?.avatar_url ||
    post.lens_users?.avatar_url ||
    null;

  const getAuthorCountry = (post) =>
    post.users?.country ||
    post.lens_users?.country ||
    post.author?.country ||
    post.country_code ||
    null;

  if ((loading && page === 0) || !modReady) {
    return (
      <div className="flex justify-center items-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 text-red-600 dark:text-red-400">
        <p>{error}</p>
        <button
          onClick={() => loadPosts(true)}
          className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-full hover:bg-blue-700"
        >
          {t("retry") || "Try again"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {posts.length === 0 ? (
        <div
          className="flex flex-col items-center py-12
          bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.06] rounded-xl"
        >
          <Globe className="w-10 h-10 text-slate-300 dark:text-white/[0.08] mb-3" />
          <h3 className="font-cinzel text-[13px] text-slate-600 dark:text-white/20 mb-1">
            {t("no_posts_yet") || "No posts yet"}
          </h3>
          <p className="text-[12px] text-slate-500 dark:text-white/[0.12]">
            {t("be_first_to_post") || "Be the first to post!"}
          </p>
        </div>
      ) : (
        posts.map((post) => {
          const reactionCounts = getReactionCounts(post);

          const myWalletAddress =
            localStorage.getItem("lens_account_address") ||
            lensProfile?.address ||
            connectedAddress ||
            lensWalletAddress ||
            null;

          const isOwner =
            !!myWalletAddress &&
            !!post &&
            ((!!post.lens_user_id &&
              post.lens_user_id.toLowerCase() ===
                myWalletAddress.toLowerCase()) ||
              getAuthorWalletAddress(post)?.toLowerCase() ===
                myWalletAddress.toLowerCase());

          const isSaved = savedStatuses[post.id];
          const isSaving = savingPosts[post.id];

          // ADDED: applying moderation actions (moderationActions.js).
          // Hidden posts (a regular "hide" OR an unconfirmed "critical")
          // aren't rendered at all - the same computeModerationState
          // already used by ModerationQueue.jsx now computes it here too.
          const modState = computeModerationState(
            modActions,
            post.lens_post_id,
            { reports },
          );

          // ADDED: posts by authors whose account has been banned by
          // vote (no Shield/Council SBT - DisciplineModule doesn't apply)
          // are also not rendered.
          const banState = computeBanState(
            modActions,
            post.author?.owner_address,
            shieldTotalSupply,
          );

          if (modState.hidden || banState.banned) return null;

          const isBlurred = modState.blurred && !revealedBlurred.has(post.id);

          const authorAddress = getAuthorWalletAddress(post);

          const cardPost = {
            id: post.id,
            content: post.content,
            createdAt: post.created_at,
            editedAt: post.last_edited_at,
            author: {
              address: authorAddress,
              name: getAuthorName(post),
              handle: getAuthorHandle(post),
              avatar: getAuthorAvatar(post),
            },
            media: (post.media_urls || []).map((url, index) => ({
              url,
              type: post.media_types?.[index] || "document",
            })),
            commentCount: getCommentCount(post),
            shareCount: post.share_count,
          };

          return (
            <PostCard
              key={post.id}
              post={cardPost}
              countryBadge={
                <span
                  className="text-[11px] px-1.5 py-0.5 rounded
                  bg-blue-100 dark:bg-blue-900/25 border border-blue-300/50 dark:border-blue-700/20 text-blue-700 dark:text-blue-400/65
                  flex-shrink-0"
                >
                  {getCountryDisplayName(getAuthorCountry(post))}
                </span>
              }
              reaction={{
                truth: reactionCounts.truth,
                false: reactionCounts.false,
                mine: post.my_reaction || null,
              }}
              isOwner={isOwner}
              isSaved={isSaved}
              isSaving={isSaving}
              isSharing={sharing[post.id]}
              tipButton={
                authorAddress && !isOwnWallet(authorAddress) ? (
                  <TipButton
                    author={{ wallet_address: authorAddress }}
                    lensPostId={post.lens_post_id || post.id}
                  />
                ) : null
              }
              isBlurred={isBlurred}
              onRevealBlurred={() =>
                setRevealedBlurred((prev) => new Set(prev).add(post.id))
              }
              onReaction={(type) => handleReaction(post.id, type)}
              onSave={() => handleSavePost(post.id)}
              onShare={() => handleSharePost(post.id)}
              onDelete={() => handleDeletePost(post.id)}
              onReport={() => handleReportPost(post)}
              onAuthorClick={() =>
                navigate(`/user/${post.lens_user_id || post.user_id}`)
              }
              onCommentSubmit={(text, mediaFiles) =>
                handleComment(post.id, text, mediaFiles)
              }
              onCommentIconClick={() => navigate(`/post/${post.id}`)}
              onOpenPost={() => navigate(`/post/${post.id}`)}
            />
          );
        })
      )}

      {hasMore && posts.length > 0 && (
        <div className="text-center py-3">
          <button
            onClick={() => {
              setPage(page + 1);
              loadPosts();
            }}
            disabled={loading}
            className="px-5 py-2 text-[12px] font-medium
              bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.08] text-slate-600 dark:text-white/40
              rounded-lg hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65
              disabled:opacity-40 transition-all"
          >
            {loading
              ? t("loading") || "Loading..."
              : t("load_more") || "Load more"}
          </button>
        </div>
      )}

      {reportModalPost && (
        <ReportModal
          post={reportModalPost}
          authorAddress={getAuthorWalletAddress(reportModalPost)}
          authorCandidates={[
            reportModalPost.author?.owner_address,
            reportModalPost.author?.wallet_address,
            reportModalPost.lens_users?.wallet_address,
            reportModalPost.users?.wallet_address,
          ].filter(Boolean)}
          createLensComment={createLensComment}
          sessionClient={sessionClient}
          countryCode={lensProfile?.country || "EARTH"}
          dao={dao}
          onClose={() => setReportModalPost(null)}
        />
      )}
    </div>
  );
};

export default CountryFeed;
