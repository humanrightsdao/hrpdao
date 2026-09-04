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
  const [loadingComments, setLoadingComments] = useState(false);
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
      // (MOD_ACTION_TAG) навмисно приховані з треду — інакше показуються
      // користувачам як "звичайний" коментар з сирим JSON.
      const visibleItems = items.filter(
        (c) =>
          !isReportComment(c.metadata?.content) &&
          !isModActionComment(c.metadata?.content),
      );

      const normalized = visibleItems.map((c) => ({
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
      }));

      normalized.sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at),
      );
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

  return {
    comments,
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
