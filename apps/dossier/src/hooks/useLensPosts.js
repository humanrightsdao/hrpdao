// src/hooks/useLensPosts.js
import { useState, useCallback } from "react";
import { lensClient } from "../lib/lens";
import { RATING_TAG } from "../lib/countryRatings";
import { useNostrIdentity } from "./useNostrIdentity";
import { useNostrRelay } from "./useNostrRelay";
import { buildImetaTags } from "../lib/nostrRelay";
import { uri, postId } from "@lens-protocol/client";
import { textOnly } from "@lens-protocol/metadata";
import { handleOperationWith } from "@lens-protocol/client/viem";
import { chains } from "@lens-chain/sdk/viem";
import { eip712WalletActions } from "viem/zksync";
// ДОДАНО: та сама перевірка, що вже ховає скарги (REPORT_TAG) і
// лог дій модерації (MOD_ACTION_TAG) зі звичайного треду коментарів
// у useLensComments.js. Без неї сповіщення про CommentNotification
// показують сирий службовий JSON скарги як "хтось написав коментар" —
// користувач бачить [HRDAO_REPORT]{...} замість людського тексту.
import { isReportComment } from "../utils/postReports";
import { isModActionComment } from "../utils/moderationActions";
import {
  post,
  fetchPosts,
  fetchPost,
  deletePost,
  addReaction,
  undoReaction,
  bookmarkPost,
  undoBookmarkPost,
  repost,
  fetchNotifications,
  fetchPostBookmarks,
} from "@lens-protocol/client/actions";

// Grove Storage Client для завантаження метаданих
import { StorageClient } from "@lens-chain/storage-client";

// Ініціалізуємо Grove клієнт
const storageClient = StorageClient.create();

const uploadToGrove = async (metadata) => {
  const { uri: metadataUri } = await storageClient.uploadAsJson(metadata);
  return metadataUri;
};

// ADDED (Nostr comment threading): maps lensPostId → the Nostr event
// id/pubkey that post was cross-posted as, so a later comment on that
// post can attach proper NIP-10 reply tags (e/p) instead of showing
// up as an unrelated standalone note on Nostr clients like Primal.
// LIMITATION: this is a local-only, per-browser map — there's no
// backend making it available across devices/users, so this only
// produces correct threading when commenting on a post that was ALSO
// cross-posted from this same browser. Commenting on someone else's
// post still cross-posts fine, just as a standalone note (same as
// before this fix), since we have no way to know a Nostr event id we
// were never told about.
const nostrPostMapKey = "nostr_lens_post_map";
const getNostrEventForLensPost = (lensPostId) => {
  if (!lensPostId) return null;
  try {
    const raw = localStorage.getItem(nostrPostMapKey);
    const map = raw ? JSON.parse(raw) : {};
    return map[lensPostId] || null;
  } catch {
    return null;
  }
};
const saveNostrEventForLensPost = (lensPostId, eventId, authorPubkey) => {
  if (!lensPostId || !eventId) return;
  try {
    const raw = localStorage.getItem(nostrPostMapKey);
    const map = raw ? JSON.parse(raw) : {};
    map[lensPostId] = { eventId, authorPubkey };
    localStorage.setItem(nostrPostMapKey, JSON.stringify(map));
  } catch (err) {
    console.warn("⚠️ Failed to persist Nostr post map:", err.message);
  }
};

const uploadFileToGrove = async (file) => {
  // FIXED (Nostr media): previously only `uri` (the lens://... scheme)
  // was captured here — that's correct for Lens Metadata's own
  // image/video `item` field, but Nostr clients like Primal cannot
  // resolve lens:// URIs at all, so any cross-posted note's media
  // link was silently dead. gatewayUrl is the same file's normal
  // https:// address — kept alongside uri so callers can pick the
  // right one for each destination.
  const { uri: fileUri, gatewayUrl } = await storageClient.uploadFile(file);
  return { uri: fileUri, gatewayUrl };
};

// Завантажує масив файлів у Grove і повертає масив { uri, gatewayUrl, type }
const uploadAllFilesToGrove = async (files) => {
  const results = await Promise.all(
    files.map(async (file) => {
      const { uri: fileUri, gatewayUrl } = await uploadFileToGrove(file);
      return { uri: fileUri, gatewayUrl, type: file.type };
    }),
  );
  return results;
};

// ДОДАНО: спільна побудова Lens-метаданих (текст + медіа-attachments) —
// раніше ця логіка була продубльована прямо всередині createLensPost();
// тепер її використовує і createLensComment(), щоб коментарі теж могли
// нести медіафайли. Правило те саме, що було для постів: перший
// завантажений файл стає "головним" (ImageMetadata/VideoMetadata),
// решта йдуть у attachments; якщо файл не image/video — textOnly()
// з AudioMetadata-attachments (як і раніше, для документів/аудіо).
const buildContentMetadata = async ({
  content,
  uploadedFiles,
  attributes,
  tags,
}) => {
  // ФІКС: "lens.content": String must contain at least 1 character(s) —
  // коментар/пост лише з картинкою (без тексту) приходив сюди з
  // content === "", а image()/video() з @lens-protocol/metadata
  // трактують ключ content як опціональний, АЛЕ якщо він переданий —
  // він має бути непорожнім. Тому для image/video content треба або не
  // передавати зовсім (тільки медіа), або передавати як непорожній
  // рядок (є текст-підпис).
  const trimmedContent = content?.trim() || "";
  const contentField = trimmedContent ? { content: trimmedContent } : {};

  const buildAttachments = (files) =>
    files.slice(1).map(({ uri: itemUri, type }) => {
      if (type.startsWith("image/")) {
        return { __typename: "ImageMetadata", item: itemUri, type };
      }
      if (type.startsWith("video/")) {
        return { __typename: "VideoMetadata", item: itemUri, type };
      }
      return { __typename: "AudioMetadata", item: itemUri, type };
    });

  if (uploadedFiles.length === 0) {
    // Без медіа — це "текстовий" пост/коментар, content тут обов'язковий
    // за змістом (postComment/handleSubmit і так не пускають сюди без
    // тексту й без файлів одночасно).
    return textOnly({ content: trimmedContent, attributes, tags });
  }

  if (uploadedFiles[0].type.startsWith("image/")) {
    const { image } = await import("@lens-protocol/metadata");
    const attachments = buildAttachments(uploadedFiles);
    return image({
      ...contentField,
      image: { item: uploadedFiles[0].uri, type: uploadedFiles[0].type },
      // ФІКС: Lens metadata-схема відхиляє attachments: [] з помилкою
      // "Array must contain at least 1 element(s)" — ключ треба взагалі
      // не передавати, якщо прикріплено рівно 1 файл (тоді
      // buildAttachments() = files.slice(1) = []). Раніше ключ
      // передавався завжди, тому будь-який коментар/пост з ОДНИМ
      // зображенням чи відео валився з цією ValidationError.
      ...(attachments.length > 0 ? { attachments } : {}),
      attributes,
      tags,
    });
  }

  if (uploadedFiles[0].type.startsWith("video/")) {
    const { video } = await import("@lens-protocol/metadata");
    const attachments = buildAttachments(uploadedFiles);
    return video({
      ...contentField,
      video: { item: uploadedFiles[0].uri, type: uploadedFiles[0].type },
      ...(attachments.length > 0 ? { attachments } : {}),
      attributes,
      tags,
    });
  }

  return textOnly({
    ...contentField,
    attachments: uploadedFiles.map(({ uri: itemUri, type }) => ({
      __typename: "AudioMetadata",
      item: itemUri,
      type,
    })),
    attributes,
    tags,
  });
};

// FIXED (embedded wallet): this used to fall back to window.ethereum
// directly when no walletClient was passed in — a browser-extension-only
// API that neither an embedded Privy wallet nor a WalletConnect
// connection expose, so every publish attempt without an explicit
// walletClient threw "MetaMask not found" immediately, before ever
// reaching Grove upload or the actual Lens transaction. That fallback
// path is removed entirely: the caller must supply an already-connected
// wagmi walletClient (from LensAuthContext.getWalletClient(), which
// resolves correctly for the embedded wallet, a linked external wallet,
// or WalletConnect alike).
const getViemWalletClient = async (externalWalletClient) => {
  const lensTestnetChain = chains.testnet;

  if (!externalWalletClient) {
    throw new Error("Wallet not connected");
  }

  // Make sure we're on the Lens testnet chain. switchChain is one of
  // viem's default wallet actions, included automatically on any
  // WalletClient created by wagmi — it works through whichever
  // provider is actually connected (embedded wallet, linked external
  // wallet, or WalletConnect session).
  if (externalWalletClient.chain?.id !== lensTestnetChain.id) {
    try {
      await externalWalletClient.switchChain({ id: lensTestnetChain.id });
    } catch (err) {
      throw new Error(
        "Please switch your wallet's network to Lens Testnet and try again.",
      );
    }
  }

  return externalWalletClient.extend(eip712WalletActions());
};

/**
 * Конвертує Lens picture (рядок або об'єкт) у робочий https:// URL.
 */
const resolveLensPicture = (picture) => {
  if (!picture) return null;

  if (typeof picture === "object") {
    picture =
      picture?.optimized?.uri || picture?.raw?.uri || picture?.uri || null;
    if (!picture) return null;
  }

  if (picture.startsWith("lens://")) {
    return `https://api.grove.storage/${picture.replace("lens://", "")}`;
  }
  if (picture.startsWith("ar://")) {
    return `https://arweave.net/${picture.replace("ar://", "")}`;
  }
  if (picture.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${picture.replace("ipfs://", "")}`;
  }

  return picture;
};

/**
 * Теги, що позначають окремі "типи контенту" поза звичайною стрічкою постів
 */
// ВИПРАВЛЕНО (перейменування complaints→violations): тут був старий тег
// "complaint" — саме цей список визначає, які пости ХОВАЮТЬ зі звичайної
// стрічки. Публікація порушень (ViolationsPage.jsx) і фільтр вибірки
// (useLensViolations.js) вже тегують/шукають "violation"; без цієї правки
// нові пости-порушення почали б "протікати" у звичайну стрічку постів,
// бо цей список досі шукав би неактуальний тег "complaint".
const NON_FEED_TAGS = ["violation", "help_request", RATING_TAG, "mod_action"];

const isNonFeedPost = (item) =>
  (item.metadata?.tags || []).some((tag) => NON_FEED_TAGS.includes(tag));

/**
 * Нормалізує пост з Lens API до формату
 * сумісного з поточним CountryFeed.jsx
 */
// ЕКСПОРТОВАНО (було module-private): потрібна в GovernancePage.jsx, щоб
// нормалізувати "сирий" Lens-пост, отриманий через fetchParentPost() з
// utils/postReports.js (пряме посилання пост↔пропозиція), у ту саму
// форму { content, media_urls, media_types, lens_post_id, ... }, яку вже
// повертає fetchPostsByAuthor() нижче (fallback-сканування для старих
// пропозицій без лінк-запису) — інакше довелось би рендерити прев'ю поста
// двома різними способами залежно від того, ЯКИМ шляхом його знайшли.
export const normalizeLensPost = (lensPost) => {
  const metadata = lensPost.metadata || {};
  const attributes = metadata.attributes || [];

  const countryAttr = attributes.find((a) => a.key === "countryCode");
  const categoryAttr = attributes.find((a) => a.key === "category");
  const h3IndexAttr = attributes.find((a) => a.key === "h3Index");

  // Безпечно отримуємо owner, якщо він є
  const ownerAddress = lensPost.author?.owner || null;

  return {
    id: lensPost.id,
    content: metadata.content || "",
    country_code: countryAttr?.value || "EARTH",
    category: categoryAttr?.value || "general",
    h3_index: h3IndexAttr?.value || null,
    created_at: lensPost.timestamp,
    updated_at: lensPost.timestamp,

    user_id: lensPost.author?.address,
    author: {
      id: lensPost.author?.address,
      // ВИПРАВЛЕНО: unique_name — це хендл (@art7), а не редаговане
      // "Ім'я" з профілю (metadata.name). Раніше metadata?.name стояв
      // ПЕРШИМ у фолбеку — тому щойно людина заповнювала display name,
      // саме він показувався замість @username всюди, де рендериться
      // getAuthorHandle() (CountryFeed.jsx). Особливо помітно стало
      // після анонімізації акаунту (SettingsPage): metadata.name стає
      // "Deleted" для БУДЬ-ЯКОГО деактивованого акаунту, і всі вони
      // показувались в стрічці як однаковий "@Deleted" замість
      // справжнього (незміненого) username кожного з них. Правильний
      // порядок: справжній Lens username.localName -> address як
      // останній резерв. metadata.name сюди взагалі не має потрапляти —
      // для display name є окреме поле, див. getAuthorName() у
      // CountryFeed.jsx, яке саме metadata.name і використовує.
      // ВИПРАВЛЕНО (частина 2): author раніше НЕ мав окремого поля
      // `name` узагалі — тому getAuthorName() у CountryFeed.jsx завжди
      // провалювався до author?.unique_name (post.author?.name був
      // undefined). До попереднього фіксу це випадково "працювало",
      // бо unique_name сам містив metadata.name. Тепер, коли
      // unique_name — це справжній хендл, ім'я й хендл без цього поля
      // показували б однакове значення ("art7 @art7"). Правильно:
      // name — це редаговане "Ім'я" профілю (metadata.name), з
      // фолбеком на username, якщо людина його не заповнила; unique_name
      // — виключно хендл. Разом дають очікуване "Deleted @art7" для
      // анонімізованого акаунту або "Назар @art7" для звичайного.
      name:
        lensPost.author?.metadata?.name ||
        lensPost.author?.username?.localName ||
        lensPost.author?.address?.slice(0, 8),
      unique_name:
        lensPost.author?.username?.localName ||
        lensPost.author?.address?.slice(0, 8),
      avatar_url: resolveLensPicture(lensPost.author?.metadata?.picture),
      wallet_address: lensPost.author?.address,
      owner_address: ownerAddress, // ← НОВЕ ПОЛЕ
    },

    reactions_count:
      (lensPost.stats?.upvotes || 0) + (lensPost.stats?.downvotes || 0),
    truth_count: lensPost.stats?.upvotes || 0,
    false_count: lensPost.stats?.downvotes || 0,
    my_reaction: localStorage.getItem(`lens_reaction_${lensPost.id}`) || null,
    comments_count: lensPost.stats?.comments || 0,
    reposts_count: lensPost.stats?.reposts || 0,
    bookmarks_count: lensPost.stats?.bookmarks || 0,
    is_bookmarked: lensPost.operations?.hasBookmarked || false,
    is_reposted: lensPost.operations?.hasReposted || false,

    media_urls: extractMediaUrls(metadata).map((m) => m.url),
    media_types: extractMediaUrls(metadata).map((m) => m.type),

    lens_post_id: lensPost.id,
    is_lens_post: true,

    // ДОДАНО: без тегів консюмери (напр. SanctionProposalCard у
    // GovernancePage.jsx) не могли відрізнити, чи пост-доказ санкції —
    // це violation/help_request/звичайний пост, і завжди вели на
    // /post/:id, навіть коли правильна сторінка інша (той самий клас
    // бага, що вже виправлено в ModerationQueue.jsx для черги
    // модерації — там targetKind рахується з сирого posta.metadata.tags,
    // тут те саме поле тепер доступне і після normalizeLensPost()).
    tags: metadata.tags || [],

    // ДОДАНО: у Lens v3 коментар — теж Post, тож getLensPost(id) з id
    // коментаря повертає його як звичайний "пост". comment_on_id
    // дозволяє викликаючому коду (PostPage.jsx) розпізнати цей випадок і
    // показати банер "це коментар до ..." з посиланням на батьківський
    // запис, замість того, щоб мовчки видавати коментар за самостійний
    // пост.
    comment_on_id: lensPost.commentOn?.id || null,

    app_address: lensPost.app?.address,
  };
};

/**
 * Витягує медіа URL з метаданих посту
 */
// ЕКСПОРТОВАНО (було module-private): потрібна в useLensComments.js, щоб
// показувати медіафайли, прикріплені до коментарів, тим самим способом,
// яким CountryFeed.jsx вже показує медіа звичайних постів — коментар у
// Lens v3 це теж Post з тими самими типами метаданих (ImageMetadata /
// VideoMetadata / attachments), тож повторно писати парсер сенсу нема.
export const extractMediaUrls = (metadata) => {
  if (!metadata) return [];

  const urls = [];

  if (metadata.__typename === "ImageMetadata" && metadata.image) {
    urls.push({
      type: "image",
      url: resolveLensPicture(metadata.image.item),
      mimeType: metadata.image.type,
    });
  }

  if (metadata.__typename === "VideoMetadata" && metadata.video) {
    urls.push({
      type: "video",
      url: resolveLensPicture(metadata.video.item),
      mimeType: metadata.video.type,
    });
  }

  if (metadata.attachments) {
    metadata.attachments.forEach((attachment) => {
      if (attachment.item) {
        urls.push({
          type: attachment.__typename?.toLowerCase().includes("image")
            ? "image"
            : "file",
          url: resolveLensPicture(attachment.item),
        });
      }
    });
  }

  return urls;
};

/**
 * Нормалізує сповіщення з Lens API
 */
export const normalizeLensNotification = (n) => {
  const base = { id: n.id, lensNotificationId: n.id, __typename: n.__typename };

  switch (n.__typename) {
    case "FollowNotification": {
      const followers = n.followers || [];
      return {
        ...base,
        type: "follow",
        timestamp: followers[0]?.followedAt || null,
        actors: followers.map((f) => f.account),
        post: null,
        count: followers.length || 1,
      };
    }
    case "ReactionNotification": {
      const reactors = n.reactions || [];
      const firstReactionRaw = reactors[0]?.reactions?.[0]?.reaction;
      return {
        ...base,
        type: "reaction",
        timestamp: n.post?.timestamp || null,
        actors: reactors.map((r) => r.account),
        post: n.post ? normalizeLensPost(n.post) : null,
        count: reactors.length || 1,
        reactionType:
          firstReactionRaw === "UPVOTE"
            ? "truth"
            : firstReactionRaw === "DOWNVOTE"
              ? "false"
              : null,
      };
    }
    case "CommentNotification": {
      return {
        ...base,
        type: "comment",
        timestamp: n.comment?.timestamp || null,
        actors: n.comment?.author ? [n.comment.author] : [],
        post: n.comment ? normalizeLensPost(n.comment) : null,
        count: 1,
      };
    }
    case "RepostNotification": {
      const reposters = n.reposts || [];
      return {
        ...base,
        type: "repost",
        timestamp: reposters[0]?.repostedAt || null,
        actors: reposters.map((r) => r.account),
        post: n.post ? normalizeLensPost(n.post) : null,
        count: reposters.length || 1,
      };
    }
    case "QuoteNotification": {
      return {
        ...base,
        type: "quote",
        timestamp: n.quote?.timestamp || null,
        actors: n.quote?.author ? [n.quote.author] : [],
        post: n.quote ? normalizeLensPost(n.quote) : null,
        count: 1,
      };
    }
    case "MentionNotification": {
      return {
        ...base,
        type: "mention",
        timestamp: n.post?.timestamp || null,
        actors: n.post?.author ? [n.post.author] : [],
        post: n.post ? normalizeLensPost(n.post) : null,
        count: 1,
      };
    }
    default:
      return {
        ...base,
        type: "other",
        timestamp: null,
        actors: [],
        post: null,
        count: 1,
      };
  }
};

/**
 * @param {object|null} sessionClient - активний Lens sessionClient
 */
/**
 * ДОДАНО: автономна версія getUserPosts() (нижче, всередині хука) —
 * та сама логіка (fetchPosts за authors + фільтр root-постів), але як
 * простий export, без прив'язки до loading/error React-стану хука.
 * Потрібна для GovernancePage.jsx: там резолвиться пост-доказ санкції
 * (violationPostRef) шляхом перебору постів автора й порівняння
 * keccak256(lens_post_id) з хешем на контракті — монтувати заради цього
 * весь useLensPosts() у GovernancePage сенсу не має, а onNonFeedPost/
 * normalizeLensPost тут і так модульні, не хук-скоуп функції.
 */
export async function fetchPostsByAuthor(accountAddress, cursor = null) {
  try {
    const result = await fetchPosts(lensClient, {
      filter: {
        authors: [accountAddress],
        apps: [import.meta.env.VITE_LENS_APP_ADDRESS],
      },
      ...(cursor ? { cursor } : {}),
    });

    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const { items, pageInfo } = result.value;
    const rootPostsOnly = items.filter((item) => !item.commentOn);
    const generalPostsOnly = rootPostsOnly.filter(
      (item) => !isNonFeedPost(item),
    );

    return {
      success: true,
      posts: generalPostsOnly.map(normalizeLensPost),
      nextCursor: pageInfo?.next || null,
      hasMore: !!pageInfo?.next,
    };
  } catch (err) {
    console.error("❌ Error fetching posts by author (standalone):", err);
    return { success: false, posts: [], error: err.message };
  }
}

// CHANGED (embedded wallet): the second argument used to be the raw
// wagmi walletClient VALUE, sourced by each caller via its own
// useWalletClient() — the same "frozen closure" hazard
// LensAuthContext.getWalletClient() was built to avoid (see the
// comments on walletClientRef/waitForWalletClient there). Now this
// hook accepts the getWalletClient FUNCTION itself (pass
// useLensAuth().getWalletClient straight through) and calls it fresh,
// right before each write — so callers no longer need their own
// useWalletClient() at all.
export default function useLensPosts(sessionClient = null, getWalletClient = null) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // ADDED (Nostr cross-posting): pulls its own getWalletClient/
  // sessionClient from LensAuthContext internally — same source as
  // the params above, since every caller of this hook already gets
  // both from useLensAuth() itself. Kept as a separate hook rather
  // than threading Nostr-specific state through this hook's own
  // params, so callers that don't care about Nostr don't need to
  // change anything.
  const { signEvent: signNostrEvent } = useNostrIdentity();
  const { publishToNostr } = useNostrRelay();

  const requireSessionClient = useCallback(() => {
    if (!sessionClient) {
      throw new Error("Lens session not found. Please login again.");
    }
    return sessionClient;
  }, [sessionClient]);

  /**
   * Створити новий пост в Lens блокчейні
   */
  const createLensPost = useCallback(
    async ({
      content,
      countryCode = "EARTH",
      category = "general",
      mediaFiles = [],
      h3Index = null,
    }) => {
      setLoading(true);
      setError("");

      try {
        const resolvedClient = getWalletClient ? await getWalletClient() : null;
        const walletClient = await getViemWalletClient(resolvedClient);
        const activeSessionClient = requireSessionClient();

        const uploadedFiles =
          mediaFiles.length > 0 ? await uploadAllFilesToGrove(mediaFiles) : [];

        const commonAttributes = [
          { key: "countryCode", value: countryCode, type: "String" },
          { key: "category", value: category, type: "String" },
          { key: "app", value: "hrpdao", type: "String" },
          ...(h3Index
            ? [{ key: "h3Index", value: h3Index, type: "String" }]
            : []),
        ];
        const commonTags = [
          countryCode,
          category,
          "hrpdao",
          "human_rights",
          ...(h3Index ? [h3Index] : []),
        ];

        // ЗМІНЕНО: логіка вибору textOnly()/image()/video() з
        // attachments винесена в спільний buildContentMetadata() —
        // її тепер використовує і createLensComment() нижче.
        const metadata = await buildContentMetadata({
          content,
          uploadedFiles,
          attributes: commonAttributes,
          tags: commonTags,
        });

        const metadataUri = await uploadToGrove(metadata);
        console.log("✅ Metadata uploaded to Grove:", metadataUri);

        const postResult = await post(activeSessionClient, {
          contentUri: uri(metadataUri),
        });

        if (postResult.isErr()) {
          throw new Error(postResult.error.message);
        }

        const result = await postResult.andThen(
          handleOperationWith(walletClient),
        );

        if (result.isErr()) {
          throw new Error(result.error.message);
        }

        const txHash = result.value;
        console.log("✅ Post published on Lens, txHash:", txHash);

        const txTimeout = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Transaction indexing timeout (30s)")),
            30000,
          ),
        );
        await Promise.race([
          activeSessionClient.waitForTransaction(txHash),
          txTimeout,
        ]);
        const fetchedPost = await fetchPost(lensClient, { txHash });
        const lensPostId = fetchedPost.isOk() ? fetchedPost.value?.id : null;
        console.log("✅ Lens post ID:", lensPostId);

        // ADDED: best-effort Nostr cross-post. Runs AFTER the Lens
        // post has already succeeded, and is deliberately isolated in
        // its own try/catch — a Nostr relay hiccup (or the user not
        // having derived a Nostr identity yet) must never fail or
        // roll back the Lens post, which is the primary, authoritative
        // publish target. nostrResult is included in the return value
        // so callers CAN surface it in the UI, but nothing currently
        // requires them to.
        let nostrResult = null;
        try {
          const postUrl =
            typeof window !== "undefined" && lensPostId
              ? `${window.location.origin}/post/${lensPostId}`
              : null;
          // Nostr notes are plain text with no separate "attachments"
          // structure like Lens posts have — media URLs (if any) are
          // just appended into the note body as plain links, which is
          // the normal convention most Nostr clients render as
          // embedded previews.
          const mediaLinks = uploadedFiles.map((f) => f.gatewayUrl).filter(Boolean);
          const noteContent = [content, ...mediaLinks, postUrl]
            .filter(Boolean)
            .join("\n\n");

          const nostrEvent = await signNostrEvent({
            kind: 1,
            content: noteContent,
            tags: [
              ...commonTags.map((tag) => ["t", tag]),
              ...buildImetaTags(uploadedFiles),
              ...(postUrl ? [["r", postUrl]] : []),
            ],
          });

          if (nostrEvent) {
            const relayResults = await publishToNostr(nostrEvent);
            nostrResult = {
              success: relayResults.some((r) => r.ok),
              relays: relayResults,
              eventId: nostrEvent.id,
            };
            console.log("✅ Cross-posted to Nostr:", nostrResult);
            saveNostrEventForLensPost(
              lensPostId,
              nostrEvent.id,
              nostrEvent.pubkey,
            );
          }
        } catch (nostrErr) {
          console.warn(
            "⚠️ Nostr cross-post failed (Lens post is unaffected):",
            nostrErr.message,
          );
          nostrResult = { success: false, error: nostrErr.message };
        }

        return {
          success: true,
          postId: txHash,
          lensId: lensPostId,
          nostr: nostrResult,
        };
      } catch (err) {
        console.error("❌ Error creating Lens post:", err);
        setError(err.message);
        return { success: false, error: err.message };
      } finally {
        setLoading(false);
      }
    },
    [requireSessionClient, getWalletClient],
  );

  /**
   * Створити коментар в Lens блокчейні
   */
  const createLensComment = useCallback(
    async ({ content, commentOn, countryCode = "EARTH", mediaFiles = [] }) => {
      setLoading(true);
      setError("");

      try {
        const resolvedClient = getWalletClient ? await getWalletClient() : null;
        const walletClient = await getViemWalletClient(resolvedClient);
        const activeSessionClient = requireSessionClient();

        // ДОДАНО: коментарі тепер можуть нести медіафайли (як і пости) —
        // вантажимо в Grove і будуємо ту саму структуру метаданих
        // (image()/video()/textOnly() + attachments) через спільний
        // buildContentMetadata(), який раніше використовував лише
        // createLensPost().
        const uploadedFiles =
          mediaFiles.length > 0 ? await uploadAllFilesToGrove(mediaFiles) : [];

        const metadata = await buildContentMetadata({
          content,
          uploadedFiles,
          attributes: [
            { key: "app", value: "hrpdao", type: "String" },
            { key: "countryCode", value: countryCode, type: "String" },
          ],
          tags: ["hrpdao", "comment", countryCode],
        });

        const metadataUri = await uploadToGrove(metadata);
        console.log("✅ Comment metadata uploaded:", metadataUri);

        const result = await post(activeSessionClient, {
          contentUri: uri(metadataUri),
          commentOn: {
            post: postId(commentOn),
          },
        }).andThen(handleOperationWith(walletClient));

        if (result.isErr()) {
          throw new Error(result.error.message);
        }

        const txHash = result.value;
        console.log("✅ Comment published on Lens, txHash:", txHash);

        const txTimeout = new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Transaction indexing timeout (30s)")),
            30000,
          ),
        );
        await Promise.race([
          activeSessionClient.waitForTransaction(txHash),
          txTimeout,
        ]);
        const commentResult = await fetchPost(lensClient, { txHash });
        const lensCommentId = commentResult.isOk()
          ? commentResult.value?.id
          : null;
        console.log("✅ Lens comment ID:", lensCommentId);

        // ADDED: same best-effort Nostr cross-post pattern as
        // createLensPost() above — isolated in its own try/catch so a
        // relay hiccup never fails or reverts the Lens comment, which
        // has already succeeded regardless.
        let nostrResult = null;
        try {
          const postUrl =
            typeof window !== "undefined" && lensCommentId
              ? `${window.location.origin}/post/${lensCommentId}`
              : null;
          const mediaLinks = uploadedFiles.map((f) => f.gatewayUrl).filter(Boolean);
          const noteContent = [content, ...mediaLinks, postUrl]
            .filter(Boolean)
            .join("\n\n");

          // NIP-10 reply threading: only possible if the post being
          // commented on was ITSELF cross-posted from this browser
          // (see the local map + its limitations noted above it). If
          // found, this makes the comment show up as a proper reply on
          // Nostr clients instead of an unrelated standalone note.
          const parentNostr = getNostrEventForLensPost(commentOn);
          const threadTags = parentNostr
            ? [
                ["e", parentNostr.eventId, "", "reply"],
                ...(parentNostr.authorPubkey
                  ? [["p", parentNostr.authorPubkey]]
                  : []),
              ]
            : [];

          const nostrEvent = await signNostrEvent({
            kind: 1,
            content: noteContent,
            tags: [
              ["t", "hrpdao"],
              ["t", "comment"],
              ["t", countryCode],
              ...threadTags,
              ...buildImetaTags(uploadedFiles),
              ...(postUrl ? [["r", postUrl]] : []),
            ],
          });

          if (nostrEvent) {
            const relayResults = await publishToNostr(nostrEvent);
            nostrResult = {
              success: relayResults.some((r) => r.ok),
              relays: relayResults,
              eventId: nostrEvent.id,
            };
            console.log("✅ Comment cross-posted to Nostr:", nostrResult);
          }
        } catch (nostrErr) {
          console.warn(
            "⚠️ Nostr cross-post failed for comment (Lens comment is unaffected):",
            nostrErr.message,
          );
          nostrResult = { success: false, error: nostrErr.message };
        }

        return {
          success: true,
          commentId: txHash,
          lensId: lensCommentId,
          nostr: nostrResult,
        };
      } catch (err) {
        console.error("❌ Error creating Lens comment:", err);
        setError(err.message);
        return { success: false, error: err.message };
      } finally {
        setLoading(false);
      }
    },
    [requireSessionClient, getWalletClient],
  );

  /**
   * Отримати пости по країні з Lens
   */
  const getCountryPosts = useCallback(
    async (countryCode = "EARTH", cursor = null, h3Index = null) => {
      setLoading(true);
      setError("");

      try {
        const client = sessionClient || lensClient;

        const filter = {
          apps: [import.meta.env.VITE_LENS_APP_ADDRESS],
        };

        // ДОДАНО: h3Index тепер може бути як одним рядком (як і раніше —
        // точна клітинка рівня 3), так і МАСИВОМ рядків — для фільтрації
        // по грубішому гексагону (рівень 0/1/2), який на клієнті
        // розкладається на список дочірніх клітинок рівня 3 (див.
        // getH3ChildrenAtResolution у h3Utils.js).
        // ВАЖЛИВО: Lens GraphQL API дозволяє МАКСИМУМ 10 значень у
        // tags.oneOf (перевірено на практиці — довші масиви повертають
        // помилку валідації "[String!]" value length must be <= 10).
        // Тому масив тут жорстко обрізається до 10 як останній захист;
        // фактичне розбиття на шматки по 10 і об'єднання результатів
        // робить CountryFeed.jsx (CHUNK_SIZE) — сюди має приходити вже
        // ≤10 елементів, це просто запобіжник на випадок помилки виклику.
        const MAX_TAGS_PER_QUERY = 10;
        const h3Indexes = (
          Array.isArray(h3Index)
            ? h3Index.filter(Boolean)
            : h3Index
              ? [h3Index]
              : []
        ).slice(0, MAX_TAGS_PER_QUERY);

        if (h3Indexes.length > 0) {
          filter.metadata = {
            tags: { oneOf: h3Indexes },
          };
        } else if (countryCode && countryCode !== "EARTH") {
          filter.metadata = {
            tags: { oneOf: [countryCode] },
          };
        } else {
          filter.metadata = {
            tags: { oneOf: ["hrpdao"] },
          };
        }

        const result = await fetchPosts(client, {
          filter,
          ...(cursor ? { cursor } : {}),
        });

        if (result.isErr()) {
          throw new Error(result.error.message);
        }

        const { items, pageInfo } = result.value;

        const rootPostsOnly = items.filter((item) => !item.commentOn);
        const generalPostsOnly = rootPostsOnly.filter(
          (item) => !isNonFeedPost(item),
        );

        return {
          success: true,
          posts: generalPostsOnly.map(normalizeLensPost),
          nextCursor: pageInfo?.next || null,
          hasMore: !!pageInfo?.next,
        };
      } catch (err) {
        console.error("❌ Error fetching Lens posts:", err);
        setError(err.message);
        return { success: false, posts: [], error: err.message };
      } finally {
        setLoading(false);
      }
    },
    [sessionClient],
  );

  /**
   * Отримати пости конкретного користувача
   */
  const getUserPosts = useCallback(
    async (accountAddress, cursor = null) => {
      setLoading(true);
      setError("");

      try {
        const client = sessionClient || lensClient;

        const result = await fetchPosts(client, {
          filter: {
            authors: [accountAddress],
            apps: [import.meta.env.VITE_LENS_APP_ADDRESS],
          },
          ...(cursor ? { cursor } : {}),
        });

        if (result.isErr()) {
          throw new Error(result.error.message);
        }

        const { items, pageInfo } = result.value;

        const rootPostsOnly = items.filter((item) => !item.commentOn);
        const generalPostsOnly = rootPostsOnly.filter(
          (item) => !isNonFeedPost(item),
        );

        return {
          success: true,
          posts: generalPostsOnly.map(normalizeLensPost),
          nextCursor: pageInfo?.next || null,
          hasMore: !!pageInfo?.next,
        };
      } catch (err) {
        console.error("❌ Error fetching user Lens posts:", err);
        setError(err.message);
        return { success: false, posts: [], error: err.message };
      } finally {
        setLoading(false);
      }
    },
    [sessionClient],
  );

  /**
   * Отримати один пост по ID з Lens
   */
  const getLensPost = useCallback(
    async (lensPostId) => {
      setLoading(true);
      setError("");

      try {
        const client = sessionClient || lensClient;

        const result = await fetchPost(client, { post: postId(lensPostId) });

        if (result.isErr()) {
          throw new Error(result.error.message);
        }

        if (!result.value) {
          return { success: false, error: "Post not found" };
        }

        return { success: true, post: normalizeLensPost(result.value) };
      } catch (err) {
        console.error("❌ Error fetching Lens post:", err);
        setError(err.message);
        return { success: false, error: err.message };
      } finally {
        setLoading(false);
      }
    },
    [sessionClient],
  );

  /**
   * Отримати сповіщення автентифікованого Lens-акаунту
   */
  const getNotifications = useCallback(
    async (cursor = null) => {
      setLoading(true);
      setError("");

      try {
        const activeSessionClient = requireSessionClient();

        const result = await fetchNotifications(activeSessionClient, {
          // ФІКС (справжня причина "нуль сповіщень"): Lens API має
          // вбудований анти-спам скоринг і за замовчуванням
          // (includeLowScore: false) МОВЧКИ ховає сповіщення від
          // акаунтів з низьким "score" — під це підпадають типові
          // свіжостворені/малоактивні тестові акаунти на testnet, без
          // репутації, фоловерів чи історії. Запит без цього фільтра
          // завжди повертав success:true, notifications:[] — жодної
          // помилки, просто порожньо. Джерело: інтроспекція реальної
          // GraphQL-схеми з @lens-protocol/graphql (NotificationFilter),
          // це відсутнє в публічній документації.
          // ФІКС (сповіщення "розпрочитуються" самі через 45с): Lens за
          // замовчуванням (timeBasedAggregation: true) динамічно
          // перегруповує події в часові "пачки" — id такої пачки
          // перераховується щоразу, коли до вікна агрегації потрапляє
          // нова подія. Локальний read/deleted стан (localStorage)
          // прив'язаний саме до id — щойно Lens перерахував пачку й
          // видав їй новий id, старий "прочитано"-запис більше не
          // збігається з жодним поточним id, і сповіщення знову
          // виглядає непрочитаним при наступному поллінгу. З
          // timeBasedAggregation: false кожна подія отримує один
          // стабільний, незмінний id.
          filter: { includeLowScore: true, timeBasedAggregation: false },
          ...(cursor ? { cursor } : {}),
        });

        if (result.isErr()) {
          throw new Error(result.error.message);
        }

        const { items, pageInfo } = result.value;

        const normalized = items.map(normalizeLensNotification);

        // ФІКС: "Encountered two children with the same key" — Lens
        // час від часу повертає ДУБЛІ одного й того ж запису (той самий
        // id, напр. при toggle реакції off→on, чи перекриття курсорів
        // пагінації). React-ключ у списку — notification.id, тож дублі
        // з однаковим id ламають рендер. Дедуплікуємо за id, лишаючи
        // перше входження.
        const seenIds = new Set();
        const deduped = normalized.filter((n) => {
          if (seenIds.has(n.id)) return false;
          seenIds.add(n.id);
          return true;
        });

        // ФІКС: скарги на коментар (ReportModal.jsx) і лог дій
        // модерації публікуються як звичайний Lens Post/коментар з
        // службовою міткою в content (REPORT_TAG / MOD_ACTION_TAG) —
        // навмисно, щоб не змінювати смартконтракт. useLensComments.js
        // вже ховає їх зі звичайного треду коментарів; тут та сама
        // перевірка ховає їх і зі стрічки сповіщень (інакше CommentNotification
        // показує користувачу сирий JSON скарги замість людського тексту).
        const visible = deduped.filter((n) => {
          if (n.type === "comment" || n.type === "quote") {
            const content = n.post?.content || "";
            if (isReportComment(content) || isModActionComment(content)) {
              return false;
            }
          }
          return true;
        });

        return {
          success: true,
          notifications: visible,
          nextCursor: pageInfo?.next || null,
          hasMore: !!pageInfo?.next,
        };
      } catch (err) {
        console.error("❌ Error fetching Lens notifications:", err);
        setError(err.message);
        return { success: false, notifications: [], error: err.message };
      } finally {
        setLoading(false);
      }
    },
    [requireSessionClient],
  );

  /**
   * Отримати список закладок автентифікованого акаунту
   */
  const getBookmarkedPosts = useCallback(
    async (cursor = null) => {
      setLoading(true);
      setError("");

      try {
        const activeSessionClient = requireSessionClient();

        const result = await fetchPostBookmarks(activeSessionClient, {
          ...(cursor ? { cursor } : {}),
        });

        if (result.isErr()) {
          throw new Error(result.error.message);
        }

        const { items, pageInfo } = result.value;

        const normalPostsOnly = items.filter(
          (item) => item.__typename === "Post",
        );

        return {
          success: true,
          posts: normalPostsOnly.map(normalizeLensPost),
          nextCursor: pageInfo?.next || null,
          hasMore: !!pageInfo?.next,
        };
      } catch (err) {
        console.error("❌ Error fetching Lens bookmarks:", err);
        setError(err.message);
        return { success: false, posts: [], error: err.message };
      } finally {
        setLoading(false);
      }
    },
    [requireSessionClient],
  );

  /**
   * Видалити пост або коментар з Lens блокчейну
   */
  const deleteLensPost = useCallback(
    async (lensId) => {
      setLoading(true);
      try {
        const resolvedClient = getWalletClient ? await getWalletClient() : null;
        const walletClient = await getViemWalletClient(resolvedClient);
        const activeSessionClient = requireSessionClient();

        const result = await deletePost(activeSessionClient, {
          post: lensId,
        }).andThen(handleOperationWith(walletClient));

        if (result.isErr()) {
          throw new Error(result.error.message);
        }

        return { success: true };
      } catch (err) {
        console.error("❌ Error deleting Lens post:", err);
        setError(err.message);
        return { success: false, error: err.message };
      } finally {
        setLoading(false);
      }
    },
    [requireSessionClient, getWalletClient],
  );

  /**
   * Додати пост до закладок
   */
  const bookmarkLensPost = useCallback(
    async (lensPostId) => {
      try {
        const activeSessionClient = requireSessionClient();
        const result = await bookmarkPost(activeSessionClient, {
          post: postId(lensPostId),
        });
        if (result.isErr()) throw new Error(result.error.message);
        return { success: true, bookmarked: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    [requireSessionClient],
  );

  /**
   * Видалити пост із закладок
   */
  const undoBookmarkLensPost = useCallback(
    async (lensPostId) => {
      try {
        const activeSessionClient = requireSessionClient();
        const result = await undoBookmarkPost(activeSessionClient, {
          post: postId(lensPostId),
        });
        if (result.isErr()) throw new Error(result.error.message);
        return { success: true, bookmarked: false };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    [requireSessionClient],
  );

  /**
   * Репостнути пост
   */
  const repostLensPost = useCallback(
    async (lensPostId) => {
      try {
        const resolvedClient = getWalletClient ? await getWalletClient() : null;
        const walletClient = await getViemWalletClient(resolvedClient);
        const activeSessionClient = requireSessionClient();
        const result = await repost(activeSessionClient, {
          post: postId(lensPostId),
        }).andThen(handleOperationWith(walletClient));
        if (result.isErr()) throw new Error(result.error.message);

        // ADDED: NIP-18 repost cross-post — only possible if the
        // original post was itself cross-posted from this browser
        // (see getNostrEventForLensPost's own limitations comment).
        // Best-effort, isolated — never affects the Lens repost above,
        // which has already succeeded regardless.
        try {
          const parentNostr = getNostrEventForLensPost(lensPostId);
          if (parentNostr) {
            const repostEvent = await signNostrEvent({
              kind: 6,
              content: "",
              tags: [
                ["e", parentNostr.eventId],
                ...(parentNostr.authorPubkey
                  ? [["p", parentNostr.authorPubkey]]
                  : []),
              ],
            });
            if (repostEvent) await publishToNostr(repostEvent);
          }
        } catch (nostrErr) {
          console.warn(
            "⚠️ Nostr repost cross-post failed (Lens repost is unaffected):",
            nostrErr.message,
          );
        }

        return { success: true };
      } catch (err) {
        return { success: false, error: err.message };
      }
    },
    [requireSessionClient, getWalletClient, signNostrEvent, publishToNostr],
  );

  /**
   * Додати реакцію — "Правда" (UPVOTE) або "Неправда" (DOWNVOTE)
   */
  const addLensReaction = useCallback(
    async (lensPostId, reactionType) => {
      try {
        const activeSessionClient = requireSessionClient();
        const lensReaction = reactionType === "truth" ? "UPVOTE" : "DOWNVOTE";

        const result = await addReaction(activeSessionClient, {
          post: postId(lensPostId),
          reaction: lensReaction,
        });

        if (result.isErr()) throw new Error(result.error.message);

        // ADDED: NIP-25 reaction cross-post ("+"/"-" content is the
        // NIP-25 convention for like/dislike) — same local-map
        // limitation as repost above.
        try {
          const parentNostr = getNostrEventForLensPost(lensPostId);
          if (parentNostr) {
            const reactionEvent = await signNostrEvent({
              kind: 7,
              content: reactionType === "truth" ? "+" : "-",
              tags: [
                ["e", parentNostr.eventId],
                ...(parentNostr.authorPubkey
                  ? [["p", parentNostr.authorPubkey]]
                  : []),
              ],
            });
            if (reactionEvent) await publishToNostr(reactionEvent);
          }
        } catch (nostrErr) {
          console.warn(
            "⚠️ Nostr reaction cross-post failed (Lens reaction is unaffected):",
            nostrErr.message,
          );
        }

        return { success: true, reaction: reactionType };
      } catch (err) {
        console.error("❌ Error adding Lens reaction:", err);
        return { success: false, error: err.message };
      }
    },
    [requireSessionClient, signNostrEvent, publishToNostr],
  );

  /**
   * Скасувати раніше поставлену реакцію (toggle off)
   */
  const removeLensReaction = useCallback(
    async (lensPostId, reactionType) => {
      try {
        const activeSessionClient = requireSessionClient();
        const lensReaction = reactionType === "truth" ? "UPVOTE" : "DOWNVOTE";

        const result = await undoReaction(activeSessionClient, {
          post: postId(lensPostId),
          reaction: lensReaction,
        });

        if (result.isErr()) throw new Error(result.error.message);
        return { success: true };
      } catch (err) {
        console.error("❌ Error removing Lens reaction:", err);
        return { success: false, error: err.message };
      }
    },
    [requireSessionClient],
  );

  return {
    // Стан
    loading,
    error,

    // Методи
    createLensPost,
    createLensComment,
    getCountryPosts,
    getUserPosts,
    getLensPost,
    getNotifications,
    getBookmarkedPosts,
    deleteLensPost,
    bookmarkLensPost,
    undoBookmarkLensPost,
    repostLensPost,
    addLensReaction,
    removeLensReaction,

    // Утиліти
    normalizeLensPost,
    normalizeLensNotification,
  };
}
