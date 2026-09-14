// src/lib/countryRatings.js
//
// Shared logic for "country rating as a Lens post" — 100% decentralized,
// with no external backend at all. Each user has at most ONE such post:
// the first rating — post(), every subsequent one (for the same or a new
// country) — editPost() on that same post. This is exactly the mechanism
// that guarantees "only the current rating counts" — old versions simply
// don't exist separately, there's one live, editable entity.
//
// When a user changes their country of residence, call deleteMyRatingPost()
// (see ProfileEditModal.jsx) — this way the old rating stops counting
// toward the average for the country the person "left".
//
// 🛑 CRITICAL: a country tag MUST NOT contain a colon ":". The Lens
// indexer searches tags via Postgres full-text search (tsquery), and in
// tsquery ":" is the "lexeme weight" operator (e.g. word:A). The format
// "country:US" broke the BACKEND with a "syntax error in tsquery" on ANY
// attempt to filter posts by this tag (even if there were no matching
// posts at all — it fails already at the query-parsing stage). So the
// country is encoded as "country_<ISO>" (underscore) — not "country:<ISO>".
// If another composite tag is ever needed — avoid the ":" character (and,
// just in case, quotes/parentheses) in tag values.
//
// ✅ VERIFIED (against @lens-protocol/graphql types
// 0.0.0-canary-20250430134539): filter.metadata.tags supports { oneOf }
// and { all }. fetchMyRatingPost below uses { oneOf: [RATING_TAG] } —
// a single tag, the same verified pattern as getCountryPosts in
// useLensPosts.js (there, AND-combining tags server-side was found to be
// unreliable on this testnet indexer, so everywhere it's one tag per
// query + client-side filtering wherever AND is needed).

import { lensClient } from "./lens";

export const RATING_TAG = "country_rating";

const RATING_ATTR_KEYS = [
  "human_rights",
  "economic_freedom",
  "political_freedom",
  "freedom_of_speech",
];

// Builds the metadata for a rating post. content is deliberately short
// and neutral — this post is NOT meant to be shown in the regular feed
// (CountryFeed.jsx should filter out posts tagged RATING_TAG if the feed
// reads "all of the user's/country's posts" indiscriminately — see the
// caveat in the accompanying explanation).
export function buildRatingMetadata(countryCode, ratings) {
  // Dynamic import, so this file doesn't pull @lens-protocol/metadata
  // into bundles where ratings aren't used at all.
  return import("@lens-protocol/metadata").then(
    ({ textOnly, MetadataAttributeType }) =>
      textOnly({
        content: `Country rating: ${countryCode}`,
        tags: [RATING_TAG, `country_${countryCode}`],
        attributes: [
          {
            type: MetadataAttributeType.STRING,
            key: "countryCode",
            value: countryCode,
          },
          ...RATING_ATTR_KEYS.map((key) => ({
            type: MetadataAttributeType.NUMBER,
            key,
            value: String(ratings[key] ?? 0),
          })),
        ],
      }),
  );
}

// Extracts the rating from a post, if it matches our format.
// Returns null for any "foreign" post (missing the required attributes)
// — callers should account for this (skip it, rather than fail).
export function parseRatingAttributes(post) {
  const attrs = post?.metadata?.attributes;
  if (!Array.isArray(attrs)) return null;

  const get = (key) => {
    const attr = attrs.find((a) => a.key === key);
    return attr ? Number(attr.value) : null;
  };

  const human_rights = get("human_rights");
  if (human_rights === null) return null; // not a rating format

  return {
    postId: post.id,
    countryCode: attrs.find((a) => a.key === "countryCode")?.value || null,
    human_rights,
    economic_freedom: get("economic_freedom") || 0,
    political_freedom: get("political_freedom") || 0,
    freedom_of_speech: get("freedom_of_speech") || 0,
  };
}

// Finds the SINGLE (by design) rating post of a specific account.
// A public call — can be made even without an active session.
// ⚠️ If, due to a race condition (see the comment near saveCountryRating),
// SEVERAL rating posts already exist for one account, this function
// returns only items[0] (the order from the API is not guaranteed!) — for
// diagnosing/cleaning up duplicates, use fetchAllMyRatingPosts below.
export async function fetchMyRatingPost(accountAddress) {
  if (!accountAddress) return null;

  const { fetchPosts } = await import("@lens-protocol/client/actions");

  const result = await fetchPosts(lensClient, {
    filter: {
      authors: [accountAddress],
      metadata: { tags: { oneOf: [RATING_TAG] } },
    },
  });

  if (result.isErr()) {
    console.error("⚠️ fetchMyRatingPost error:", result.error.message);
    return null;
  }

  return result.value.items[0] || null;
}

// ADDED: returns ALL of an account's rating posts (not just the first).
// By design there should be 0 or 1 — if it returns more, a race
// condition happened somewhere (see the comment below) and "ghost posts"
// with stale values have accumulated, skewing the country average.
export async function fetchAllMyRatingPosts(accountAddress) {
  if (!accountAddress) return [];

  const { fetchPosts } = await import("@lens-protocol/client/actions");

  const all = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const result = await fetchPosts(lensClient, {
      filter: {
        authors: [accountAddress],
        metadata: { tags: { oneOf: [RATING_TAG] } },
      },
      ...(cursor ? { cursor } : {}),
    });

    if (result.isErr()) {
      console.error("⚠️ fetchAllMyRatingPosts error:", result.error.message);
      break;
    }

    const { items, pageInfo } = result.value;
    all.push(...items);

    if (!pageInfo?.next) break;
    cursor = pageInfo.next;
  }

  return all;
}

// Creates or (if one already exists) edits the user's rating post.
// sessionClient/walletClient — the same ones already used in
// ProfileEditModal.jsx (getWalletClient from useLensAuth + sessionClient
// from useLensAuth). ratings — { human_rights, economic_freedom,
// political_freedom, freedom_of_speech }, each a number 1-10.
//
// 🛑 RACE CONDITION (found in a real-world example — see the explanation
// in chat): if saveCountryRating() is called several times almost
// simultaneously (e.g. the user quickly clicks all 4 rating sliders in
// ProfilePage.jsx), each call independently runs fetchMyRatingPost()
// BEFORE the previous call has managed to create the post and have it
// indexed. As a result, several calls simultaneously see "there's no
// post yet" and each creates ITS OWN post() — instead of a single
// editPost(). This leaves behind several "ghost posts" with different
// historical values, which then all get counted in the country average
// (getAverageRatings), skewing the result.
//
// FIX (two layers of protection):
// 1. Here: an optional knownPostId parameter — if the caller (e.g.
//    ProfilePage.jsx) already knows its post's ID (from a previous load
//    or a previous successful saveCountryRating), it passes it directly,
//    and this function immediately does editPost() without a repeated
//    (racy) lookup via fetchMyRatingPost().
// 2. On the caller's side (ProfilePage.jsx): calls are serialized
//    through a promise queue, so that parallel clicks NEVER execute
//    saveCountryRating() simultaneously — see saveQueueRef.current in
//    ProfilePage.jsx. This is the main safeguard; knownPostId is an
//    additional guarantee even if the queue is somehow bypassed somewhere.
export async function saveCountryRating({
  sessionClient,
  walletClient,
  accountAddress,
  countryCode,
  ratings,
  knownPostId = null,
}) {
  if (!sessionClient) return { success: false, error: "No active Lens session" };
  if (!walletClient) return { success: false, error: "Wallet not connected" };

  try {
    const [{ post, editPost }, { handleOperationWith }, { storageClient }] =
      await Promise.all([
        import("@lens-protocol/client/actions"),
        import("@lens-protocol/client/viem"),
        import("../lib/grove"),
      ]);

    // If the caller already knows the ID — don't do a repeated (racy) lookup.
    const existingId =
      knownPostId || (await fetchMyRatingPost(accountAddress))?.id || null;

    const metadata = await buildRatingMetadata(countryCode, ratings);
    const { uri } = await storageClient.uploadAsJson(metadata);

    const operation = existingId
      ? editPost(sessionClient, { post: existingId, contentUri: uri })
      : post(sessionClient, { contentUri: uri });

    const result = await operation.andThen(handleOperationWith(walletClient));

    if (result.isErr()) {
      return { success: false, error: result.error.message };
    }
    if (result.value && typeof result.value === "string") {
      await sessionClient.waitForTransaction(result.value);
    }

    // If this was a NEW post (post(), not editPost()) — result.value is
    // usually the transaction/post ID depending on the SDK. It's more
    // reliable to explicitly re-fetch the created post's ID anyway, so
    // the caller can cache it for subsequent editPost() calls.
    const finalPostId =
      existingId ||
      (typeof result.value === "object" && result.value?.id) ||
      (await fetchMyRatingPost(accountAddress))?.id ||
      null;

    return { success: true, postId: finalPostId };
  } catch (err) {
    console.error("⚠️ saveCountryRating error:", err);
    return { success: false, error: err.message };
  }
}

// Deletes the user's rating post entirely. Call this when the user
// changes their country of residence (ProfileEditModal.jsx) — so the old
// rating immediately stops counting toward the old country's average. If
// there's no post — that's not an error (skipped: true).
//
// ⚠️ Deletes only ONE (the first one found) post. If the account has
// duplicates due to a race condition (see above) — use
// cleanupDuplicateRatingPosts to remove ALL the extras.
export async function deleteMyRatingPost({
  sessionClient,
  walletClient,
  accountAddress,
}) {
  if (!sessionClient) return { success: false, error: "No active Lens session" };

  const existing = await fetchMyRatingPost(accountAddress);
  if (!existing) return { success: true, skipped: true };

  try {
    const [{ deletePost }, { handleOperationWith }] = await Promise.all([
      import("@lens-protocol/client/actions"),
      import("@lens-protocol/client/viem"),
    ]);

    const result = await deletePost(sessionClient, {
      post: existing.id,
    }).andThen(handleOperationWith(walletClient));

    if (result.isErr()) {
      return { success: false, error: result.error.message };
    }
    return { success: true };
  } catch (err) {
    console.error("⚠️ deleteMyRatingPost error:", err);
    return { success: false, error: err.message };
  }
}

// ADDED: diagnostics/cleanup for "ghost posts" caused by the race
// condition (see the comment near saveCountryRating). Finds ALL of an
// account's rating posts; if there's more than one — keeps ONE (the
// newest by timestamp, i.e. the most recently edited/created) and
// deletes the rest. Returns { success, kept, deletedCount, deletedIds }.
//
// Usage (e.g. a temporary button in ProfilePage.jsx):
//   const result = await cleanupDuplicateRatingPosts({
//     sessionClient, walletClient, accountAddress: userInfo.lensAccountAddress,
//   });
export async function cleanupDuplicateRatingPosts({
  sessionClient,
  walletClient,
  accountAddress,
}) {
  if (!sessionClient) return { success: false, error: "No active Lens session" };
  if (!accountAddress) return { success: false, error: "No account address" };

  const allPosts = await fetchAllMyRatingPosts(accountAddress);
  if (allPosts.length <= 1) {
    return {
      success: true,
      kept: allPosts[0]?.id || null,
      deletedCount: 0,
      deletedIds: [],
    };
  }

  // Keep the newest one (largest timestamp) — this is usually the
  // last value that was actually applied.
  const sorted = [...allPosts].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
  const keep = sorted[0];
  const toDelete = sorted.slice(1);

  const { deletePost } = await import("@lens-protocol/client/actions");
  const { handleOperationWith } = await import("@lens-protocol/client/viem");

  const deletedIds = [];
  for (const p of toDelete) {
    try {
      const result = await deletePost(sessionClient, { post: p.id }).andThen(
        handleOperationWith(walletClient),
      );
      if (!result.isErr()) deletedIds.push(p.id);
      else
        console.error(
          `⚠️ cleanupDuplicateRatingPosts: failed to delete ${p.id}:`,
          result.error.message,
        );
    } catch (err) {
      console.error(`⚠️ cleanupDuplicateRatingPosts: error on ${p.id}:`, err);
    }
  }

  return {
    success: true,
    kept: keep.id,
    deletedCount: deletedIds.length,
    deletedIds,
  };
}
