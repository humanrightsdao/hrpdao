// src/utils/exportUserData.js
//
// Collects a user's extended Lens data (posts, comments, help requests,
// violation reports, follows, reactions) for the "Export Data" feature on
// SettingsPage. Extracted into a separate utility rather than living
// directly in SettingsPage.jsx, so as not to bloat the component and so
// the pagination logic can be covered by tests separately.
//
// IMPORTANT: this does NOT use React hooks (useLensComments,
// useLensViolations, useLensFollowingList, etc.) directly — they are
// either tied to a specific lensPostId (useLensComments), or are
// themselves hooks with internal useState/useEffect
// (useLensFollowingList/useLensFollowersList) and therefore CANNOT be
// called conditionally from a click handler (violates the Rules of
// Hooks). Instead, the same underlying Lens SDK actions
// (fetchPosts/fetchFollowing) are called directly here, following the
// same filtering pattern already used in the corresponding hooks
// (authors/apps/metadata.tags — as in useLensPosts.getUserPosts and
// useLensViolations.fetchViolations).
//
// NEEDS VERIFYING AGAINST YOUR SDK VERSION BEFORE PRODUCTION:
// - postTypes: ["COMMENT"] for the "all my comments" query — by analogy
//   with postTypes: ["ROOT"] in useLensHelpRequests.js, but this specific
//   variant hasn't been used elsewhere in the project before.
// - The exact shape of post.operations.hasUpvoted/hasDownvoted (a boolean
//   value, or { value, isFinalisedOnchain }, as with other *ByMe fields
//   in the project) — extractOperationReaction() below handles both
//   variants defensively, but verify against the
//   node_modules/@lens-protocol/client types.

import { fetchPosts, fetchFollowing } from "@lens-protocol/client/actions";
import { lensClient } from "../lib/lens";
import { isModActionComment } from "./moderationActions";
import { isReportComment } from "./postReports";
// CHECK THE PATHS: if moderationActions.js / postReports.js don't live in
// src/utils/ (the same directory as this file) — fix the imports above.
// In useLensComments.js (src/hooks/) both modules are imported as
// "../utils/..." which confirms the src/utils/*.js location.

const APP_ID = import.meta.env.VITE_LENS_APP_ADDRESS;

// Protection against infinite pagination — if an account has thousands of
// posts, data collection stops at this many pages instead of hanging
// forever. At Lens's typical page size (~10-50) that's a few hundred
// items per category, which is enough for a personal export; for outlier
// accounts this number can be raised.
const MAX_PAGES = 20;

const attrVal = (attributes, key) =>
  attributes?.find((a) => a.key === key)?.value ?? "";

// The same lens:// / ar:// / ipfs:// resolver used in the project's other
// hooks (useLensPosts.js, useLensFollowing.js) — duplicated intentionally
// to keep this utility independent from the rest of the hooks.
const resolveLensPicture = (picture) => {
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

// Reads the user's own reaction to a post from the operations field,
// which Lens returns ONLY when the request is made via an authorized
// sessionClient (the same reason useLensFollow.js requires sessionClient
// for fetchFollowStatus). Defensively handles both the boolean and the
// object variant of the field — see the TODO at the top of the file.
const extractOperationReaction = (post) => {
  const ops = post?.operations;
  if (!ops) return null;
  const upvoted =
    typeof ops.hasUpvoted === "object" ? ops.hasUpvoted?.value : ops.hasUpvoted;
  const downvoted =
    typeof ops.hasDownvoted === "object"
      ? ops.hasDownvoted?.value
      : ops.hasDownvoted;
  if (upvoted) return "truth";
  if (downvoted) return "false";
  return null;
};

// ── Generic paginated collector for fetchPosts-based categories ────────────
// onChainReactions: Map<postId, reaction> — accumulated as a side effect
// while walking the pages, to be merged later with localStorage reactions.
// This is not a complete list of ALL of the user's reactions (see the
// explanation in chat), only those relating to posts already loaded in
// this export.
async function fetchAllPosts(
  client,
  filter,
  normalize,
  onChainReactions,
  onPage,
) {
  const results = [];
  let cursor = null;
  let page = 0;

  do {
    const result = await fetchPosts(client, {
      filter,
      ...(cursor ? { cursor } : {}),
    });

    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const { items, pageInfo } = result.value;

    // FIX: service entries are published as regular Lens Posts and used
    // to leak into the personal export as raw JSON:
    //   - mod_action (ban votes, etc.) — the same check that hides them
    //     from the comment thread in useLensComments.js;
    //   - report (reports via ReportModal.jsx) — contain someone else's
    //     description of a report against a post/comment, also service
    //     data, not the author's own content.
    // Applied to ALL categories (not just posts), because the comments
    // code (useLensComments.js) shows that a report is indeed published
    // as a comment, and mod_action has also been seen as a standalone
    // ROOT post — meaning both types could theoretically show up in any
    // query.
    const visibleItems = items.filter(
      (post) =>
        !isModActionComment(post.metadata?.content) &&
        !isReportComment(post.metadata?.content),
    );

    visibleItems.forEach((post) => {
      const reaction = extractOperationReaction(post);
      if (reaction) onChainReactions.set(post.id, reaction);
    });

    results.push(...visibleItems.map(normalize));
    cursor = pageInfo?.next || null;
    page += 1;
    onPage?.(page, results.length);
  } while (cursor && page < MAX_PAGES);

  return results;
}

// ── Normalizers (lightweight versions — only fields that make sense in the export) ─────

const normalizePostForExport = (post) => {
  const metadata = post.metadata || {};
  return {
    id: post.id,
    content: metadata.content || "",
    tags: metadata.tags || [],
    created_at: post.timestamp,
    stats: {
      upvotes: post.stats?.upvotes || 0,
      downvotes: post.stats?.downvotes || 0,
      comments: post.stats?.comments || 0,
      collects: post.stats?.collects || 0,
    },
  };
};

const normalizeCommentForExport = (post) => {
  const metadata = post.metadata || {};
  return {
    id: post.id,
    content: metadata.content || "",
    commentOn: post.commentOn?.id || null,
    created_at: post.timestamp,
  };
};

const normalizeHelpRequestForExport = (post) => {
  const metadata = post.metadata || {};
  const attributes = metadata.attributes || [];
  return {
    id: post.id,
    description: metadata.content || "",
    country_code:
      attrVal(attributes, "country_code") || attrVal(attributes, "countryCode"),
    status: attrVal(attributes, "status") || "active",
    created_at: post.timestamp,
  };
};

const normalizeViolationForExport = (post) => {
  const metadata = post.metadata || {};
  const attributes = metadata.attributes || [];
  return {
    id: post.id,
    description: metadata.content || "",
    country_code: attrVal(attributes, "countryCode"),
    address: attrVal(attributes, "address"),
    violation_date: attrVal(attributes, "violationDate"),
    severity_level: attrVal(attributes, "severityLevel"),
    created_at: post.timestamp,
  };
};

// ── Following — separate pagination, since it isn't fetchPosts ───────────
async function fetchAllFollowing(client, accountAddress, onPage) {
  const results = [];
  let cursor = null;
  let page = 0;

  do {
    const result = await fetchFollowing(client, {
      account: accountAddress,
      ...(cursor ? { cursor } : {}),
    });

    if (result.isErr()) {
      throw new Error(result.error.message);
    }

    const { items, pageInfo } = result.value;
    items.forEach((item) => {
      // FIXED (as in useLensFollowing.js): fetchFollowing returns
      // items[].following as the Account itself directly, without a
      // nested .account.
      const account = item.following;
      if (!account) return;
      results.push({
        address: account.address,
        name: account.metadata?.name || null,
        handle: account.username?.localName
          ? `@${account.username.localName}`
          : null,
        avatar: resolveLensPicture(account.metadata?.picture) || null,
      });
    });
    cursor = pageInfo?.next || null;
    page += 1;
    onPage?.(page, results.length);
  } while (cursor && page < MAX_PAGES);

  return results;
}

// ── Reactions — from already-loaded posts/comments/reports ───────────────────
// Lens's API doesn't provide a complete on-chain source of "all of this
// user's reactions" (there's no reverse index "posts account X reacted
// to" — only an operations field on a SPECIFIC post), so this only
// covers reactions on posts/comments/reports that already ended up in
// this export. Reactions on other people's posts elsewhere in the feed
// that weren't loaded here won't appear.
function collectReactions(onChainReactions) {
  return Array.from(onChainReactions.entries()).map(([postId, reaction]) => ({
    postId,
    reaction,
    source: "onchain",
  }));
}

/**
 * Collects the selected categories of a user's Lens data for export.
 *
 * @param {object} params
 * @param {object|null} params.sessionClient - active Lens session (if any); falls back to the public lensClient
 * @param {string} params.accountAddress - Lens account address (userInfo.lensAccountAddress)
 * @param {object} params.categories - { posts, comments, helpRequests, violations, following, reactions } (each a boolean)
 * @param {(step: string) => void} [params.onProgress] - callback for showing progress in the UI
 * @returns {Promise<object>} object with keys only for the enabled categories
 */
export async function collectUserExportData({
  sessionClient,
  accountAddress,
  categories,
  onProgress,
}) {
  const client = sessionClient || lensClient;
  const data = {};
  // Accumulates postId -> reaction found in operations while walking any
  // of the fetchPosts-based categories below (posts/comments/helpRequests/
  // violations) — only used if categories.reactions === true.
  const onChainReactions = new Map();

  if (categories.posts && accountAddress) {
    onProgress?.("Loading posts...");
    data.posts = await fetchAllPosts(
      client,
      { authors: [accountAddress], apps: [APP_ID], postTypes: ["ROOT"] },
      normalizePostForExport,
      onChainReactions,
      (page, count) => onProgress?.(`Posts: page ${page} (${count})`),
    );
  }

  if (categories.comments && accountAddress) {
    onProgress?.("Loading comments...");
    data.comments = await fetchAllPosts(
      client,
      { authors: [accountAddress], apps: [APP_ID], postTypes: ["COMMENT"] },
      normalizeCommentForExport,
      onChainReactions,
      (page, count) => onProgress?.(`Comments: page ${page} (${count})`),
    );
  }

  if (categories.helpRequests && accountAddress) {
    onProgress?.("Loading help requests...");
    data.helpRequests = await fetchAllPosts(
      client,
      {
        authors: [accountAddress],
        apps: [APP_ID],
        metadata: { tags: { oneOf: ["help_request"] } },
      },
      normalizeHelpRequestForExport,
      onChainReactions,
      (page, count) =>
        onProgress?.(`Help requests: page ${page} (${count})`),
    );
  }

  if (categories.violations && accountAddress) {
    onProgress?.("Loading violation reports...");
    data.violations = await fetchAllPosts(
      client,
      {
        authors: [accountAddress],
        apps: [APP_ID],
        metadata: { tags: { oneOf: ["violation"] } },
      },
      normalizeViolationForExport,
      onChainReactions,
      (page, count) =>
        onProgress?.(`Violation reports: page ${page} (${count})`),
    );
  }

  if (categories.following && accountAddress) {
    onProgress?.("Loading follows...");
    data.following = await fetchAllFollowing(
      client,
      accountAddress,
      (page, count) => onProgress?.(`Follows: page ${page} (${count})`),
    );
  }

  if (categories.reactions) {
    onProgress?.("Collecting reactions...");
    // If none of the posts/comments/helpRequests/violations categories
    // was enabled, onChainReactions stays an empty map — in that case
    // this is effectively the same as before (localStorage only).
    data.reactions = collectReactions(onChainReactions);
  }

  return data;
}
