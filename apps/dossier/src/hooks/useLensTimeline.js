// src/hooks/useLensTimeline.js
import { useState, useEffect, useCallback } from "react";
import { fetchTimeline } from "@lens-protocol/client/actions";

// ДОДАНО: той самий резолвер картинок, що в useLensProfile.js /
// useLensFollowing.js — дублюється свідомо (див. пояснення в
// useLensProfile.js про незалежність хук-файлів одне від одного).
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

// ДОДАНО: резолвер медіа з Lens metadata. Post — union кількох типів
// (ImageMetadata, VideoMetadata, AudioMetadata, TextOnlyMetadata тощо),
// кожен зі СВОЄЮ формою: ImageMetadata.image = {item, type}, VideoMetadata.
// video = {item, type}, а мультимедійні пости часто додатково несуть
// metadata.attachments = [{item, type}, ...]. Раніше mapPostToFeedItem
// не читав жодне з цих полів — тому getMediaItems() у FollowingPage.jsx
// завжди отримував пости без media/media_urls, і картки рендерились без
// медіафайлів. resolveLensPicture тут теж підходить: значення item — це
// такий самий lens://|ar://|ipfs:// URI, як і в аватарках.
const resolveLensMedia = (metadata) => {
  if (!metadata) return [];

  const items = [];
  const pushItem = (raw, fallbackType) => {
    if (!raw) return;
    const url = resolveLensPicture(raw.item || raw);
    if (!url) return;
    const mime = raw.type || "";
    const type = mime.startsWith("video")
      ? "video"
      : mime.startsWith("image")
        ? "image"
        : fallbackType;
    items.push({ url, type });
  };

  // Основне медіа поста — форма залежить від __typename metadata.
  if (metadata.image) pushItem(metadata.image, "image");
  if (metadata.video) pushItem(metadata.video, "video");
  if (metadata.audio) pushItem(metadata.audio, "document");

  // Додаткові вкладення (мультимедійні пости можуть мати кілька файлів).
  if (Array.isArray(metadata.attachments)) {
    metadata.attachments.forEach((a) => pushItem(a, "document"));
  }

  return items;
};

// ДОДАНО: мапінг сирого Post (повертається в primary кожного
// TimelineItem) у плоский об'єкт для рендеру картки поста.
//
// УВАГА: Post у Lens SDK — це union кількох типів метадані (TextOnly,
// Image, Video, Article тощо), кожен з яких має своє поле з контентом
// під SPECIFIC shape (наприклад TextOnlyMetadata.content,
// ImageMetadata.content + ImageMetadata.image). Якщо у вашому
// useLensPosts.js вже є власна, повніша логіка розбору metadata за
// типом mainContentFocus — варто перевикористати саме її замість цього
// спрощеного мапера (тут узято лише найпоширеніший випадок —
// metadata.content як текст, з фолбеком на порожній рядок).
// ДОДАНО: той самий список "нефідових" тегів, що й у useLensPosts.js
// (NON_FEED_TAGS/isNonFeedPost) — дублюється тут свідомо, за тим самим
// принципом незалежності хук-файлів, що й resolveLensPicture вище.
// Без цього фільтра службові пости (голос за бан акаунту через
// moderationActions.js, скарги, запити на допомогу, пости з рейтингом
// країни) пролазили в стрічку підписок як звичайний контент — адже
// fetchTimeline(), на відміну від getCountryPosts(), не фільтрує ані по
// apps, ані по тегах взагалі.
//
// ВИПРАВЛЕНО: "country_rating" — точне значення RATING_TAG з
// src/lib/countryRatings.js (раніше тут стояла заглушка "rating").
const NON_FEED_TAGS = [
  "violation", // ВИПРАВЛЕНО: раніше "complaint" — стара назва тегу,
  // порушення тепер публікуються з тегом "violation"
  // (див. filter у useLensViolations.js)
  "help_request",
  "country_rating",
  "mod_action",
];

const isNonFeedTimelineItem = (post) =>
  (post.metadata?.tags || []).some((tag) => NON_FEED_TAGS.includes(tag));

const mapPostToFeedItem = (post) => {
  if (!post) return null;

  // ДОДАНО: захисна перевірка на клієнті, НЕЗАЛЕЖНО від
  // filter.eventType на запиті. commentOn/quoteOf заповнені — означає,
  // що це коментар чи цитата (тобто primary все одно міг прийти "не
  // тим" постом), а не оригінальний пост того, на кого ви підписані.
  // Пропускаємо такі елементи повністю, а не намагаємось їх показати
  // з неправильним автором.
  if (post.commentOn || post.quoteOf) return null;

  // ДОДАНО: пропускаємо технічні/службові пости за тегом (див. коментар
  // до NON_FEED_TAGS вище) — вони не призначені для показу в стрічці.
  if (isNonFeedTimelineItem(post)) return null;

  return {
    id: post.id,
    slug: post.slug,
    createdAt: post.timestamp || null,
    content: post.metadata?.content || "",
    media: resolveLensMedia(post.metadata),
    author: {
      address: post.author?.address || null,
      // ДОДАНО: owner (реальна EOA-адреса, якою мінтили Shield/Senate
      // SBT) — БЕЗ цього computeBanState() у FollowingPage.jsx звіряв
      // голоси за бан з адресою Lens Account (смартконтракт), а не з
      // owner, і бан акаунту фактично ніколи не спрацьовував у стрічці
      // підписок. Той самий фікс, що вже застосований у
      // useLensViolations.js/useLensHelpRequests.js (owner_address).
      owner: post.author?.owner || null,
      name: post.author?.metadata?.name || null,
      handle: post.author?.username?.localName
        ? `@${post.author.username.localName}`
        : null,
      avatar: resolveLensPicture(post.author?.metadata?.picture) || null,
    },
    stats: {
      upvotes: post.stats?.upvotes ?? 0,
      downvotes: post.stats?.downvotes ?? 0,
      comments: post.stats?.comments ?? 0,
      reposts: post.stats?.reposts ?? 0,
      collects: post.stats?.collects ?? 0,
    },
    // ADDED: same fix as normalizeLensPost (useLensPosts.js) — the real,
    // authoritative reaction state for the logged-in user, straight from
    // Lens's LoggedInPostOperations. Previously not exposed here at all,
    // which is why FollowingPage.jsx's getMyReaction()/getReactionCounts()
    // had nothing to read except localStorage — see the fix there for why
    // that caused "Правда" to duplicate onto "Неправда".
    operations: {
      hasUpvoted: post.operations?.hasUpvoted ?? false,
      hasDownvoted: post.operations?.hasDownvoted ?? false,
    },
  };
};

/**
 * ВИПРАВЛЕНО: попередня версія викликала fetchTimeline через
 * публічний lensClient — і отримувала
 * "[GraphQL] Unauthenticated - Authentication is required to access
 * 'timeline'". Хоча типи SDK формально дозволяють передати AnyClient,
 * сам бекенд Lens усе одно вимагає авторизовану сесію для поля
 * `timeline` (на відміну від fetchFollowing/fetchFollowers, які
 * справді публічні й працюють без сесії) — Lens-у потрібно знати,
 * ВІД ІМЕНІ КОГО саме формується персональна стрічка, а це можна
 * перевірити лише по токену сесії, не просто по адресі в request.
 *
 * Тому хук тепер приймає sessionClient ЗОВНІ — той самий, що вже
 * є в проєкті через useLensAuth() (LensAuthContext), яким
 * користується CountryFeed.jsx, а не намагається сам відновлювати
 * сесію через PublicClient.resumeSession(). Поки sessionClient ще не
 * готовий (sessionRestoring=true в контексті) — просто не робимо запит.
 */
export function useLensTimeline(accountAddress, sessionClient) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!accountAddress || !sessionClient) {
      setPosts([]);
      setHasMore(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    console.log("🔍 useLensTimeline: запит", {
      account: accountAddress,
      hasSession: !!sessionClient,
    });

    // ВИПРАВЛЕНО (двічі): TimelineItem.primary — НЕ завжди пост саме
    // того, на кого ви підписані.
    // 1) Для REPOST: primary — ОРИГІНАЛЬНИЙ пост ОРИГІНАЛЬНОГО автора
    //    (якого могли й не фоловити); хто репостнув — окремо в
    //    item.reposts[].
    // 2) Для COMMENT: primary — КОРЕНЕВИЙ/оригінальний пост, до якого
    //    писали коментар (теж могли не фоловити); сам коментар вашого
    //    фоловіну — окремо в item.comments[], а не в primary.
    // Тобто і "COMMENT", і "QUOTE" в попередній версії фільтра все одно
    // пропускали чужих авторів через primary. Єдиний тип події, де
    // primary.author гарантовано = той, на кого ви підписані — це POST.
    fetchTimeline(sessionClient, {
      account: accountAddress,
      filter: { eventType: ["POST"] },
    })
      .then((result) => {
        if (cancelled) return;
        if (result.isErr()) {
          console.error("❌ Lens fetchTimeline error:", result.error.message);
          setError(result.error.message);
          return;
        }
        // ДОДАНО: сирий результат у консоль — якщо rawItemsCount > 0,
        // але posts.length === 0 після мапінгу — проблема в
        // mapPostToFeedItem (наприклад, інша структура metadata для
        // постів не-TextOnly типу). Якщо rawItemsCount === 0 одразу —
        // або індексація ще не підхопила нові пости/підписки, або
        // timeline враховує лише пости, опубліковані ПІСЛЯ моменту
        // підписки (а не весь історичний бек-кетлог автора).
        console.log("🔍 useLensTimeline: відповідь", {
          rawItemsCount: result.value.items.length,
          rawItems: result.value.items,
        });
        const mapped = result.value.items
          .map((item) => mapPostToFeedItem(item.primary))
          .filter(Boolean);
        setPosts(mapped);
        setCursor(result.value.pageInfo?.next || null);
        setHasMore(Boolean(result.value.pageInfo?.next));
      })
      .catch((e) => {
        if (!cancelled) {
          console.error("❌ useLensTimeline exception:", e);
          setError(e.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountAddress, sessionClient]);

  const loadMore = useCallback(async () => {
    if (!accountAddress || !sessionClient || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchTimeline(sessionClient, {
        account: accountAddress,
        cursor,
        filter: { eventType: ["POST"] },
      });
      if (result.isErr()) {
        console.error(
          "❌ Lens fetchTimeline loadMore error:",
          result.error.message,
        );
        setError(result.error.message);
        return;
      }
      const mapped = result.value.items
        .map((item) => mapPostToFeedItem(item.primary))
        .filter(Boolean);
      setPosts((prev) => [...prev, ...mapped]);
      setCursor(result.value.pageInfo?.next || null);
      setHasMore(Boolean(result.value.pageInfo?.next));
    } catch (e) {
      console.error("❌ useLensTimeline loadMore exception:", e);
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [accountAddress, sessionClient, cursor, loadingMore]);

  return { posts, loading, loadingMore, error, hasMore, loadMore };
}
