// src/lib/dossierFeed.js
//
// PORTED (read-only) from dossier-app's src/hooks/useLensPosts.js —
// specifically the "EARTH" branch of getCountryPosts() (no country/H3
// filter = the global feed), which is exactly dossier's own "Planet
// Earth" mode. This file only reads and normalizes posts for display —
// no post()/addReaction()/repost()/bookmarkPost()/comment mutations, by
// design: the DAO home page shows this feed for context only, with a
// link out to dossier for anyone who wants to actually interact with it.
import { lensClient } from "./lensLookup";
import { fetchPosts } from "@lens-protocol/client/actions";

const RATING_TAG = "country_rating";
const NON_FEED_TAGS = ["violation", "help_request", RATING_TAG, "mod_action"];
const isNonFeedPost = (item) =>
  (item.metadata?.tags || []).some((tag) => NON_FEED_TAGS.includes(tag));

const APP_ADDRESS = import.meta.env.VITE_LENS_APP_ADDRESS;

function resolveLensPicture(picture) {
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
}

function extractMediaUrls(metadata) {
  if (!metadata) return [];
  const urls = [];
  if (metadata.__typename === "ImageMetadata" && metadata.image) {
    urls.push({ type: "image", url: resolveLensPicture(metadata.image.item) });
  }
  if (metadata.__typename === "VideoMetadata" && metadata.video) {
    urls.push({ type: "video", url: resolveLensPicture(metadata.video.item) });
  }
  if (metadata.attachments) {
    metadata.attachments.forEach((a) => {
      if (a.item) {
        urls.push({
          type: a.__typename?.toLowerCase().includes("image")
            ? "image"
            : "file",
          url: resolveLensPicture(a.item),
        });
      }
    });
  }
  return urls;
}

function normalizeLensPost(lensPost) {
  const metadata = lensPost.metadata || {};
  const countryAttr = (metadata.attributes || []).find(
    (a) => a.key === "countryCode",
  );
  return {
    id: lensPost.id,
    content: metadata.content || "",
    createdAt: lensPost.timestamp,
    author: {
      address: lensPost.author?.address,
      name:
        lensPost.author?.metadata?.name ||
        lensPost.author?.username?.localName ||
        lensPost.author?.address?.slice(0, 8),
      handle:
        lensPost.author?.username?.localName ||
        lensPost.author?.address?.slice(0, 8),
      avatar: resolveLensPicture(lensPost.author?.metadata?.picture),
      ownerAddress: lensPost.author?.owner || null,
    },
    countryCode: countryAttr?.value || "EARTH",
    media: extractMediaUrls(metadata),
    commentCount: lensPost.stats?.comments || 0,
  };
}

// Mirrors dossier's CountryFeed.jsx calling getCountryPosts("EARTH", ...)
// — no country tag, no h3 tag — i.e. dossier's OWN "Planet Earth" / no-
// filter mode: filter.metadata.tags.oneOf falls through to the ["hrpdao"]
// branch, matching every regular (non-violation/help/rating/mod-action)
// post published through the app, from anywhere.
export async function fetchWorldPosts(cursor = null) {
  const filter = {
    apps: [APP_ADDRESS],
    metadata: { tags: { oneOf: ["hrpdao"] } },
  };

  const result = await fetchPosts(lensClient, {
    filter,
    ...(cursor ? { cursor } : {}),
  });
  if (result.isErr()) throw new Error(result.error.message);

  const { items, pageInfo } = result.value;
  const rootPostsOnly = items.filter((item) => !item.commentOn);
  const feedPosts = rootPostsOnly.filter((item) => !isNonFeedPost(item));

  return {
    posts: feedPosts.map(normalizeLensPost),
    nextCursor: pageInfo?.next || null,
    hasMore: !!pageInfo?.next,
  };
}
