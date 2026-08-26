// src/utils/postReports.js
//
// "Report" format — a regular Lens comment with a special prefix marker
// in its content, so that (a) it's easy to filter out from normal comments
// when rendering a thread, (b) it can be parsed back into structured data
// for the moderation queue / display when voting on a sanction.
//
// ⚠️ This is NOT privacy: Lens comments are public by protocol design,
// anyone with access to the Lens API can technically read the content.
// The marker only hides the report from the UI of the normal feed/thread —
// intentionally, as agreed.

import { evmAddress, postId as toPostId } from "@lens-protocol/client";
import { fetchPosts, fetchPost } from "@lens-protocol/client/actions";
import { lensClient } from "../lib/lens";

const APP_ADDRESS = import.meta.env.VITE_LENS_APP_ADDRESS;

export const REPORT_TAG = "[HRDAO_REPORT]";

// A special "system" category for the link-entry that ModerationQueue.jsx
// publishes IMMEDIATELY AFTER successfully escalating a report into an
// on-chain sanction (dao.proposeSanction()). Previously onchainProposalId
// was only filled in ReportModal.jsx (when a Shield/Council owner creates
// a sanction themselves right away while filing the report) — but when a
// MODERATOR creates the sanction later, from the ModerationQueue, for an
// already-existing report comment, that comment has already been published
// without an onchainProposalId, and Lens comments cannot be edited after
// the fact. So a SECOND, separate "link" comment is needed, carrying the
// same onchainProposalId, published at the moment of escalation. We mark
// it with a special category to distinguish it from real user reports
// when rendering the report list.
export const ESCALATION_LINK_CATEGORY = "__escalation_link__";

export const REPORT_CATEGORIES = [
  {
    value: "hate_speech",
    label: "Hate speech",
    labelKey: "report_category_hate_speech",
    lensReason: "HATE_SPEECH",
  },
  {
    value: "violence_incitement",
    label: "Incitement to violence",
    labelKey: "report_category_violence_incitement",
    lensReason: "VIOLENCE",
  },
  {
    value: "harassment",
    label: "Harassment/bullying",
    labelKey: "report_category_harassment",
    lensReason: "HARASSMENT",
  },
  // ⚠️ No direct equivalent in the Lens enum — do NOT rely on the Lens
  // report for this category, escalate directly to the relevant
  // authorities/agencies.
  {
    value: "csam_or_minors",
    label: "Harm to children",
    labelKey: "report_category_csam_or_minors",
    lensReason: "OFFENSIVE",
  },
  {
    value: "misinformation",
    label: "Misinformation",
    labelKey: "report_category_misinformation",
    lensReason: "MISLEADING",
  },
  {
    value: "spam",
    label: "Spam",
    labelKey: "report_category_spam",
    lensReason: "REPETITIVE",
  },
  {
    value: "other",
    label: "Other",
    labelKey: "report_category_other",
    lensReason: "SOMETHING_ELSE",
  },
];

/**
 * Best-effort parallel submission of a native Lens report (reportPost,
 * renamed from reportPublication during the V2→V3 transition - confirmed
 * by the official Migration Guide: lens.xyz/docs/protocol/migration/api).
 *
 * ⚠️ IMPORTANT: the exact current signature (name of the GraphQL mutation/
 * action helper, name of the reason enum type itself) could NOT be
 * confirmed via documentation at the time of writing — below is the MOST
 * LIKELY variant by analogy with other actions (`post`, `execute...Action`
 * etc. from `@lens-protocol/client/actions`). BEFORE relying on this
 * function in production - verify the `report` name and the request shape
 * against your own TypeScript types (editor autocomplete on
 * `@lens-protocol/client/actions` will show the exact signature installed
 * in your specific SDK version).
 *
 * Intentionally does NOT block the primary (internal DAO) report on
 * failure - this is just a "bonus", parallel signal to Lens/App moderators
 * themselves.
 */
export async function reportPostToLensNative(
  sessionClient,
  lensPostId,
  lensReason,
) {
  try {
    const { report } = await import("@lens-protocol/client/actions");
    const { postId } = await import("@lens-protocol/client");
    const result = await report(sessionClient, {
      post: postId(String(lensPostId)),
      reason: { [lensReason.toLowerCase()]: true }, // ⚠️ union field shape - verify against actual types
    });
    if (result.isErr()) {
      console.warn(
        "[reportPostToLensNative] Lens API returned an error:",
        result.error,
      );
      return {
        success: false,
        error: result.error?.message || "lens_report_failed",
      };
    }
    return { success: true };
  } catch (e) {
    // Do not rethrow - the native Lens report is a "bonus", not a critical path.
    console.warn(
      "[reportPostToLensNative] failed to send (sessionClient may be unauthorized, or the SDK signature differs):",
      e,
    );
    return { success: false, error: e.message || String(e) };
  }
}

/**
 * Builds the content for a report comment.
 * @param {object} params
 * @param {string} params.category - one of REPORT_CATEGORIES[].value
 * @param {string} params.description - free text describing what's wrong
 * @param {string|null} params.onchainProposalId - filled in if the Shield owner
 *        immediately created a sanction proposal (proposeSanction)
 */
export function buildReportContent({
  category,
  description,
  onchainProposalId = null,
}) {
  const payload = {
    app: "hrdao-report",
    v: 1,
    category,
    description,
    onchainProposalId,
  };
  return `${REPORT_TAG}${JSON.stringify(payload)}`;
}

export function isReportComment(content) {
  return typeof content === "string" && content.startsWith(REPORT_TAG);
}

/**
 * Parses the content of a report comment back into an object.
 * Returns null if it's not a report or the JSON is malformed.
 */
export function parseReportComment(content) {
  if (!isReportComment(content)) return null;
  try {
    const json = content.slice(REPORT_TAG.length);
    const data = JSON.parse(json);
    if (data.app !== "hrdao-report") return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Filter for rendering a comment thread: keeps only "normal" comments,
 * removing reports. Use on any page that shows the full list of comments
 * under a post (e.g. PostPage.jsx).
 *
 * Example:
 *   const visibleComments = allComments.filter((c) => !isReportComment(c.content));
 */
export function filterOutReports(comments) {
  return (comments || []).filter((c) => !isReportComment(c?.content));
}

/**
 * Builds the content for the system "link" comment — published
 * IMMEDIATELY after dao.proposeSanction() in ModerationQueue.jsx, when a
 * moderator escalates a sanction for an ALREADY EXISTING report (rather
 * than at the time the report was first filed, as in ReportModal.jsx). It
 * uses the same format/tag as a regular report (buildReportContent) — this
 * is intentional: fetchAllReportComments() below already scans all
 * REPORT_TAG comments in one pass, so a separate tag/schema would mean a
 * second full app scan just to do the same thing.
 */
export function buildEscalationLinkContent(onchainProposalId) {
  return buildReportContent({
    category: ESCALATION_LINK_CATEGORY,
    description: "",
    onchainProposalId: String(onchainProposalId),
  });
}

/**
 * True if the parsed comment is a system link entry
 * (buildEscalationLinkContent) rather than a real user report.
 * Used to remove this entry from the visible report list in
 * ModerationQueue.jsx (it isn't meant to be read by humans), leaving it
 * accessible only for programmatic lookup of "post by proposalId".
 */
export function isEscalationLinkReport(parsed) {
  return parsed?.category === ESCALATION_LINK_CATEGORY;
}

/**
 * (Moved from ModerationQueue.jsx): walks through all pages of the app's
 * posts and extracts the ones marked with REPORT_TAG. Returns a flat list
 * of reports (including link entries, distinguished by
 * isEscalationLinkReport()). Moved here from its original location because
 * this same logic is now also needed by GovernancePage.jsx
 * (SanctionProposalCard) - to look up the proof post directly by
 * onchainProposalId, without matching keccak256 hashes.
 */
export async function fetchAllReportComments() {
  const reports = [];
  let cursor;

  do {
    const result = await fetchPosts(lensClient, {
      filter: { apps: [evmAddress(APP_ADDRESS)] },
      cursor,
    });

    if (result.isErr()) {
      throw new Error(
        result.error?.message || "Failed to load comments from Lens",
      );
    }

    const { items, pageInfo } = result.value;
    for (const item of items) {
      const content = item.metadata?.content;
      if (!isReportComment(content)) continue;

      const parsed = parseReportComment(content);
      if (!parsed) continue; // malformed JSON - skip, don't fail the whole queue

      reports.push({
        commentId: item.id,
        parentPostId: item.commentOn?.id || null,
        reporterAddress: item.author?.address || null,
        reporterHandle: item.author?.username?.localName || null,
        createdAt: item.timestamp,
        ...parsed, // category, description, onchainProposalId
      });
    }

    cursor = pageInfo?.next || undefined;
  } while (cursor);

  reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return reports;
}

/**
 * (Moved from ModerationQueue.jsx): no logic changes, just a new
 * location - shared between ModerationQueue.jsx and GovernancePage.jsx.
 */
export async function fetchParentPost(id) {
  if (!id) return null;
  const result = await fetchPost(lensClient, { post: toPostId(id) });
  if (result.isErr()) return null;
  return result.value;
}
