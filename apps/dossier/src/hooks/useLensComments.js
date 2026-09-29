// src/hooks/useLensComments.js
//
// Узагальнений хук коментарів для БУДЬ-ЯКОГО Lens Post (звичайний пост,
// help_request, complaint — усі вони для Lens Protocol один і той самий
// тип Post, тож fetchPostReferences/createLensComment/реакції працюють
// однаково незалежно від "домену" сторінки).
//
// Витягнуто й узагальнено з PostPage.jsx (loadComments/handleComment/
// handleDeleteComment/handleCommentReaction) — там ця логіка була
// прив'язана до post.lens_post_id зі стейту сторінки, тут — параметр
// хука, тому хук можна підключити з будь-якої сторінки без дублювання.
//
// Використання:
//   const {
//     comments, postingComment,
//     postComment, deleteComment, reactToComment, isCommentOwner,
//   } = useLensComments(lensPostId, sessionClient, lensProfile, getWalletClient, walletAddress);
//
//   // postComment(text, mediaFiles?) — mediaFiles: File[] (як у
//   // createLensPost), необов'язковий, за замовчуванням [].
//   postComment("Привіт!", [imageFile]);

import { useState, useEffect, useCallback } from "react";
import useLensPosts, { extractMediaUrls } from "./useLensPosts";
// ДОДАНО: скарги (ReportModal.jsx) публікуються як звичайний Lens-коментар
// з міткою REPORT_TAG у content (postReports.js) — навмисно, щоб не
// потребувати змін у смартконтракті. Але їх треба ховати зі звичайного
// треду (для цього й існує ця мітка), інакше вони показуються як
// "звичайний" коментар з сирим JSON — саме це зараз і відбувається.
import { isReportComment } from "../utils/postReports";
// ДОДАНО: дії модерації (блюр/приховати/критичне приховування/бан-голос,
// moderationActions.js) публікуються тим самим способом, що й скарги —
// звичайний Lens-коментар з міткою-префіксом у content. Їх теж треба
// ховати з видимого треду.
import { isModActionComment } from "../utils/moderationActions";
import { sanitizeCount } from "../utils/sanitizeCount";

// ── Helpers (ідентичні до PostPage.jsx) ─────────────────────────────────────

const resolveAuthorPicture = (picture) => {
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

const extractCountryFromMeta = (metadata) => {
  const attr = metadata?.attributes?.find((a) => a.key === "countryCode");
  return attr?.value || null;
};

// ── Shared normalization ────────────────────────────────────────────────────
// ADDED: moved out of loadComments() so the same mapping is used for both
// visible comments and the hidden ones (loadHiddenComments()).

// ADDED: the address of THIS app — same env var the login flow uses
// (LensAuthContext.jsx) and the user counter (useUserStats.js).
const OUR_APP_ADDRESS = (import.meta.env.VITE_LENS_APP_ADDRESS || "")
  .toString()
  .toLowerCase();

// ADDED: true when the comment was posted through a different Lens app.
// Primary signal: Post.app.address (set by Lens from the authenticated
// session's app, so it can't be faked in metadata). Fallback when Lens
// returns no app: the metadata attribute app="hrpdao" that
// createLensComment() writes for comments made in this app.
const isFromExternalApp = (c) => {
  if (!OUR_APP_ADDRESS) return false; // can't tell — don't label anything
  const address = c.app?.address?.toLowerCase();
  if (address) return address !== OUR_APP_ADDRESS;
  const appAttr = c.metadata?.attributes?.find((a) => a.key === "app")?.value;
  return appAttr !== "hrpdao";
};

const normalizeComment = (c) => ({
  id: c.id,
  lens_comment_id: c.id,
  content: c.metadata?.content || "",
  // ДОДАНО: медіафайли, прикріплені до коментаря — коментар у Lens
  // v3 це теж Post, тож ту саму структуру метаданих (ImageMetadata/
  // VideoMetadata/attachments), яку CountryFeed.jsx вже вміє
  // показувати для постів, парсимо тим самим extractMediaUrls()
  // з useLensPosts.js.
  media_urls: extractMediaUrls(c.metadata).map((m) => m.url),
  media_types: extractMediaUrls(c.metadata).map((m) => m.type),
  created_at: c.timestamp,
  updated_at: c.timestamp,
  // ADDED: which Lens app the comment was posted through. Lens is an
  // open protocol — anyone can comment from ANY Lens client, not only
  // from this app — so CommentsSection uses is_external_app to mark
  // such comments (see isFromExternalApp above).
  app_address: c.app?.address || null,
  is_external_app: isFromExternalApp(c),
  author: {
    id: c.author?.address,
    name: c.author?.metadata?.name || null,
    unique_name:
      c.author?.username?.localName || c.author?.address?.slice(0, 8),
    avatar_url: resolveAuthorPicture(c.author?.metadata?.picture),
    country: extractCountryFromMeta(c.metadata),
    wallet_address: c.author?.address,
    // ФІКС: раніше тут не було owner взагалі — тому "authorCandidates"
    // для скарги на коментар (ReportModal.jsx) фактично містив ОДНУ
    // адресу двічі (Lens Account-смартконтракт), а не справжню EOA-
    // адресу, якою реально мінтили Shield/Senate SBT (той самий
    // owner_address, що вже є в normalizeLensPost() useLensPosts.js).
    // Це й спричиняло хибне "не Shield/Senate" для коментарів.
    owner_address: c.author?.owner || null,
  },
  // ФІКС: sanitizeCount() захищає від пошкоджених значень з Lens
  // API/індексатора (той самий баг, що й для постів — див.
  // utils/sanitizeCount.js).
  truth_count: sanitizeCount(c.stats?.upvotes),
  false_count: sanitizeCount(c.stats?.downvotes),
  // FIXED: same bug/fix as normalizeLensPost (useLensPosts.js) —
  // my_reaction now comes from Lens's own real
  // operations.hasUpvoted/hasDownvoted instead of localStorage,
  // which could drift from what's actually on the Lens backend and
  // trigger the "Правда duplicates onto Неправда" bug via the
  // defensive-cleanup undoReaction() call below.
  my_reaction: c.operations?.hasUpvoted
    ? "truth"
    : c.operations?.hasDownvoted
      ? "false"
      : null,
});

// Filters out report / moderation-log comments, normalizes, newest first.
const mapVisibleComments = (items) =>
  items
    .filter(
      (c) =>
        !isReportComment(c.metadata?.content) &&
        !isModActionComment(c.metadata?.content),
    )
    .map(normalizeComment)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

export default function useLensComments(
  lensPostId,
  sessionClient,
  lensProfile,
  getWalletClient,
  walletAddress,
) {
  // CHANGED (embedded wallet): this hook's 4th param is now the
  // getWalletClient FUNCTION (from useLensAuth()), forwarded straight
  // into useLensPosts — which resolves the actual client fresh at
  // write-time instead of relying on a value each caller had to source
  // itself via its own useWalletClient() (the same "frozen closure"
  // hazard LensAuthContext.getWalletClient() already solves once,
  // app-wide). A 5th param, walletAddress, was added for the identity
  // checks below (isCommentOwner / optimistic author info) that
  // previously read walletClient?.account?.address directly — callers
  // should pass useLensAuth().address for that (already available,
  // no async resolution needed).
  const {
    createLensComment,
    deleteLensPost,
    addLensReaction,
    removeLensReaction,
    getLensPostConfirmed,
  } = useLensPosts(sessionClient, getWalletClient);

  const [comments, setComments] = useState([]);
  // ADDED: comments the post's author has hidden (Lens hideReply). Lens
  // omits them from the default (VISIBLE) query, so they're loaded on
  // demand via loadHiddenComments() — only the post's author needs them.
  const [hiddenComments, setHiddenComments] = useState([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [loadingHidden, setLoadingHidden] = useState(false);
  const [postingComment, setPostingComment] = useState(false);

  // ── Load comments from Lens (= пости з commentOn) ─────────────────────────
  // ВИПРАВЛЕНО (як і в PostPage.jsx): Lens GraphQL API не має "commentOn" у
  // PostsFilter — коментарі отримуємо через fetchPostReferences з
  // referenceTypes: [PostReferenceType.CommentOn].
  const loadComments = useCallback(async () => {
    if (!lensPostId) return;
    setLoadingComments(true);
    try {
      const { lensClient } = await import("../lib/lens");
      const { fetchPostReferences } =
        await import("@lens-protocol/client/actions");
      const { postId: mkPostId, PostReferenceType } =
        await import("@lens-protocol/client");

      const client = sessionClient || lensClient;

      const result = await fetchPostReferences(client, {
        referencedPost: mkPostId(lensPostId),
        referenceTypes: [PostReferenceType.CommentOn],
      });

      if (result.isErr()) {
        console.warn("⚠️ Error loading Lens comments:", result.error.message);
        setComments([]);
        return;
      }

      const { items } = result.value;

      // ФІКС: коментарі-скарги (REPORT_TAG) і коментарі-лог дій модерації
      // (MOD_ACTION_TAG) навмисно приховані з треду — фільтрація й
      // нормалізація тепер у mapVisibleComments() вище.
      const normalized = mapVisibleComments(items);
      setComments(normalized);
    } catch (err) {
      console.warn("⚠️ Could not load Lens comments:", err.message);
      setComments([]);
    } finally {
      setLoadingComments(false);
    }
  }, [lensPostId, sessionClient]);

  useEffect(() => {
    loadComments();
  }, [loadComments]);

  // ── isCommentOwner ─────────────────────────────────────────────────────────
  const isCommentOwner = useCallback(
    (comment) =>
      !!lensProfile &&
      (comment.author?.id === lensProfile.address ||
        comment.author?.wallet_address?.toLowerCase() ===
          walletAddress?.toLowerCase()),
    [lensProfile, walletAddress],
  );

  // ── Post comment ───────────────────────────────────────────────────────────
  const postComment = useCallback(
    // ЗМІНЕНО: postComment тепер приймає другий аргумент mediaFiles —
    // масив File-об'єктів (як mediaFiles у createLensPost/
    // CreatePostModal.jsx), щоб коментарі теж могли нести зображення/
    // відео/файли, а не лише текст.
    async (content, mediaFiles = []) => {
      if (!content?.trim() && mediaFiles.length === 0) {
        return { success: false };
      }
      if (!lensProfile) return { success: false, error: "not_logged_in" };
      if (!lensPostId) return { success: false, error: "no_post" };

      setPostingComment(true);
      try {
        const result = await createLensComment({
          content: content.trim(),
          commentOn: lensPostId,
          countryCode: lensProfile?.country || "EARTH",
          mediaFiles,
        });

        if (!result.success) {
          throw new Error(result.error || "Failed to post comment");
        }

        // ДОДАНО: миттєве прев'ю прикріплених файлів в оптимістичному
        // коментарі — через object URL, так само як CreatePostModal.jsx
        // показує локальні File до підтвердження публікації. Після
        // наступного loadComments() ці blob: URL заміняться на реальні
        // Grove-посилання з extractMediaUrls().
        const newComment = {
          id: result.lensId || `tmp_${Date.now()}`,
          lens_comment_id: result.lensId,
          content: content.trim(),
          media_urls: mediaFiles.map((f) => URL.createObjectURL(f)),
          media_types: mediaFiles.map((f) =>
            f.type.startsWith("image/")
              ? "image"
              : f.type.startsWith("video/")
                ? "video"
                : "file",
          ),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          author: {
            id: lensProfile.address,
            name: lensProfile.name || null,
            unique_name: lensProfile.localName,
            avatar_url: lensProfile.avatar,
            country: lensProfile.country,
            wallet_address: walletAddress || lensProfile.address,
          },
          truth_count: 0,
          false_count: 0,
          my_reaction: null,
        };

        setComments((prev) => [newComment, ...prev]);
        return { success: true };
      } catch (err) {
        console.error("❌ Error posting comment:", err);
        return { success: false, error: err.message };
      } finally {
        setPostingComment(false);
      }
    },
    [createLensComment, lensPostId, lensProfile, walletAddress],
  );

  // ── Delete comment ────────────────────────────────────────────────────────
  const deleteComment = useCallback(
    async (commentId) => {
      const comment = comments.find((c) => c.id === commentId);
      if (!comment?.lens_comment_id) {
        console.warn("⚠️ No lens_comment_id, cannot delete");
        return { success: false };
      }
      try {
        const result = await deleteLensPost(comment.lens_comment_id);
        if (!result.success) {
          throw new Error(result.error || "Delete failed");
        }
        setComments((prev) => prev.filter((c) => c.id !== commentId));
        return { success: true };
      } catch (err) {
        console.error("❌ Error deleting comment:", err);
        return { success: false, error: err.message };
      }
    },
    [comments, deleteLensPost],
  );

  // ── React to comment (truth/false) ────────────────────────────────────────
  const reactToComment = useCallback(
    async (commentId, reactionType) => {
      if (!lensProfile) return { success: false, error: "not_logged_in" };

      const comment = comments.find((c) => c.id === commentId);
      if (!comment?.lens_comment_id) return { success: false };

      const lensCommentId = comment.lens_comment_id;
      // FIXED: same fix as CountryFeed.jsx/PostPage.jsx/FollowingPage.jsx
      // — no local +1/-1 counter math and no localStorage anywhere in
      // this flow. A comment is a Post in Lens v3 too, so the same
      // getLensPost() refetch applies: after the API call succeeds, pull
      // the real, server-confirmed truth_count/false_count/my_reaction
      // and replace the comment's fields wholesale.
      const prevReaction = comment.my_reaction;
      const isToggleOff = prevReaction === reactionType;
      const oppositeType = reactionType === "truth" ? "false" : "truth";

      try {
        if (isToggleOff) {
          const result = await removeLensReaction(
            lensCommentId,
            reactionType,
          );
          if (!result.success) throw new Error(result.error);
        } else {
          if (prevReaction === oppositeType) {
            const cleanupResult = await removeLensReaction(
              lensCommentId,
              oppositeType,
            );
            if (!cleanupResult.success) {
              console.warn(
                "⚠️ Failed to clear the opposite reaction:",
                cleanupResult.error,
              );
            }
          }
          const result = await addLensReaction(lensCommentId, reactionType);
          if (!result.success) throw new Error(result.error);
        }

        // ДОДАНО: getLensPostConfirmed замість голого getLensPost — та
        // сама підстраховка, що й для реакцій на пости (CountryFeed.jsx/
        // PostPage.jsx/FollowingPage.jsx): коротка повторна перевірка,
        // якщо сервер ще не встиг застосувати обидва виклики вище до
        // цього рефетчу.
        const expectedReaction = isToggleOff ? null : reactionType;
        const fresh = await getLensPostConfirmed(
          lensCommentId,
          expectedReaction,
        );
        if (fresh.success) {
          setComments((prev) =>
            prev.map((c) =>
              c.id === commentId
                ? {
                    ...c,
                    my_reaction: fresh.post.my_reaction,
                    truth_count: fresh.post.truth_count,
                    false_count: fresh.post.false_count,
                  }
                : c,
            ),
          );
        }
        return { success: true };
      } catch (err) {
        console.error("❌ Error handling comment reaction:", err);
        return { success: false, error: err.message };
      }
    },
    [
      comments,
      lensProfile,
      addLensReaction,
      removeLensReaction,
      getLensPostConfirmed,
    ],
  );

  // ── Hide / unhide (post author only) ──────────────────────────────────────
  // ADDED: Lens hideReply/unhideReply. Off-chain calls made with the
  // session client (no transaction, no gas). Lens only accepts them from
  // the author of the post that was replied to — the pages decide
  // whether to show the control (canModerateComments), and Lens rejects
  // anyone else server-side, so the error is passed back to the UI.
  const hideComment = useCallback(
    async (commentId) => {
      const comment = comments.find((c) => c.id === commentId);
      if (!comment?.lens_comment_id) return { success: false };
      if (!sessionClient) return { success: false, error: "not_logged_in" };
      try {
        const { hideReply } = await import("@lens-protocol/client/actions");
        const { postId: mkPostId } = await import("@lens-protocol/client");
        const result = await hideReply(sessionClient, {
          post: mkPostId(comment.lens_comment_id),
        });
        if (result.isErr()) throw new Error(result.error.message);
        setComments((prev) => prev.filter((c) => c.id !== commentId));
        setHiddenComments((prev) =>
          prev.some((c) => c.id === commentId) ? prev : [comment, ...prev],
        );
        return { success: true };
      } catch (err) {
        console.error("❌ Error hiding comment:", err);
        return { success: false, error: err.message };
      }
    },
    [comments, sessionClient],
  );

  const unhideComment = useCallback(
    async (commentId) => {
      const comment = hiddenComments.find((c) => c.id === commentId);
      if (!comment?.lens_comment_id) return { success: false };
      if (!sessionClient) return { success: false, error: "not_logged_in" };
      try {
        const { unhideReply } = await import("@lens-protocol/client/actions");
        const { postId: mkPostId } = await import("@lens-protocol/client");
        const result = await unhideReply(sessionClient, {
          post: mkPostId(comment.lens_comment_id),
        });
        if (result.isErr()) throw new Error(result.error.message);
        setHiddenComments((prev) => prev.filter((c) => c.id !== commentId));
        setComments((prev) =>
          [comment, ...prev.filter((c) => c.id !== commentId)].sort(
            (a, b) => new Date(b.created_at) - new Date(a.created_at),
          ),
        );
        return { success: true };
      } catch (err) {
        console.error("❌ Error restoring comment:", err);
        return { success: false, error: err.message };
      }
    },
    [hiddenComments, sessionClient],
  );

  // Loads the hidden comments (replaces the list wholesale, so it also
  // reconciles anything hidden earlier in this session).
  const loadHiddenComments = useCallback(async () => {
    if (!lensPostId || !sessionClient) return;
    setLoadingHidden(true);
    try {
      const { fetchPostReferences } = await import(
        "@lens-protocol/client/actions"
      );
      const {
        postId: mkPostId,
        PostReferenceType,
        PostVisibilityFilter,
      } = await import("@lens-protocol/client");

      const result = await fetchPostReferences(sessionClient, {
        referencedPost: mkPostId(lensPostId),
        referenceTypes: [PostReferenceType.CommentOn],
        visibilityFilter: PostVisibilityFilter.Hidden,
      });
      if (result.isErr()) {
        console.warn("⚠️ Error loading hidden comments:", result.error.message);
        return;
      }
      setHiddenComments(mapVisibleComments(result.value.items));
    } catch (err) {
      console.warn("⚠️ Could not load hidden comments:", err.message);
    } finally {
      setLoadingHidden(false);
    }
  }, [lensPostId, sessionClient]);

  return {
    comments,
    hiddenComments,
    loadingHidden,
    hideComment,
    unhideComment,
    loadHiddenComments,
    loadingComments,
    postingComment,
    loadComments,
    postComment,
    deleteComment,
    reactToComment,
    isCommentOwner,
    // ДОДАНО: сирий createLensComment з useLensPosts — потрібен напряму
    // ReportModal.jsx, який постить власний структурований коментар-скаргу
    // (REPORT_TAG), окремо від видимої стрічки коментарів.
    createLensComment,
  };
}
