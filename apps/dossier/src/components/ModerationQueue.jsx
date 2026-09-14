// src/components/ModerationQueue.jsx
//
// The report queue for Shield/Council moderators.
//
// ── Discovery (Step A) ──────────────────────────────────────────
// fetchPosts() with an apps filter returns ALL of the app's posts and
// comments in one paginated request (a comment is also a Post in Lens
// v3, with a commentOn field). The client-side filter isReportComment()
// picks out hidden reports (REPORT_TAG) among regular comments. This
// requires no smart-contract changes and costs the reporter no gas.
//
// ── Linking post+comment (Step B) ────────────────────────────
// item.commentOn.id — the id of the post being reported. We group
// reports by it and fetch the post itself separately for the preview
// (there can be several reports on one post — we show all of them under
// a single post).
//
// ── Action ──────────────────────────────────────────────────────────
// Escalation into a sanction proposal via dao.proposeSanction() — the
// logic is already implemented in useLensDAO.js, here we just wire up
// the UI, repeating the pattern from ReportModal.jsx (checking
// checkTargetMembership BEFORE showing the sanction form).

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ShieldCheck,
} from "lucide-react";
import {
  isReportComment,
  parseReportComment,
  REPORT_CATEGORIES,
  // ADDED: fetchAllReportComments/fetchParentPost have been moved into
  // postReports.js - now shared with GovernancePage.jsx (looking up a
  // post directly by proposalId, without a keccak256 brute-force search).
  // buildEscalationLinkContent/isEscalationLinkReport - new: publishing
  // and filtering the system "link" comment when escalating a report
  // into a sanction below.
  fetchAllReportComments,
  fetchParentPost,
  buildEscalationLinkContent,
  isEscalationLinkReport,
} from "../utils/postReports";
import {
  // ADDED: blur/hide/critical hide/ban votes - the same Lens-native
  // pattern as the reports above, just a different marker.
  MOD_ACTIONS,
  CRITICAL_CONFIRM_REQUIRED,
  BAN_QUORUM_PCT,
  buildModActionContent,
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";

// The separate DAO app now owns all sanction voting/veto/execution UI
// (see GovernanceRedirect.jsx for the same pattern used the other
// direction). Escalating a report here only CREATES the sanction case
// on-chain — moderators go here to actually vote on it.
const DAO_APP_URL = import.meta.env.VITE_DAO_APP_URL || "http://localhost:5175";

const APP_ADDRESS = import.meta.env.VITE_LENS_APP_ADDRESS;

// ─────────────────────────────────────────────────────────────
//  Data fetching
// ─────────────────────────────────────────────────────────────

// Groups a flat list of reports into a Map<parentPostId, Report[]>,
// discarding reports not tied to a post (shouldn't normally happen, but
// we guard against corrupted data).
function groupByParentPost(reports) {
  const map = new Map();
  for (const r of reports) {
    if (!r.parentPostId) continue;
    if (!map.has(r.parentPostId)) map.set(r.parentPostId, []);
    map.get(r.parentPostId).push(r);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────
//  UI helpers
// ─────────────────────────────────────────────────────────────

function categoryLabel(value, t) {
  const cat = REPORT_CATEGORIES.find((c) => c.value === value);
  if (!cat) return value;
  return (t && t(cat.labelKey)) || cat.label;
}

function timeAgo(iso, t) {
  if (!iso) return "—";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t("moderation_just_now") || "just now";
  if (mins < 60) return t("moderation_mins_ago", { mins }) || `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("moderation_hours_ago", { hours }) || `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return t("moderation_days_ago", { days }) || `${days}d ago`;
}

function CategoryPill({ value }) {
  const { t } = useTranslation();
  const isSevere = ["csam_or_minors", "violence_incitement"].includes(value);
  return (
    <span
      className={`text-[11px] font-medium px-2 py-0.5 rounded-[5px] border
        ${
          isSevere
            ? "bg-red-500/10 border-red-500/25 text-red-400/85"
            : "bg-slate-100 dark:bg-white/[0.05] border-slate-200 dark:border-white/[0.1] text-slate-500 dark:text-white/45"
        }`}
    >
      {categoryLabel(value, t)}
    </span>
  );
}

// REDESIGNED: the moderation-actions block used to repeat, 3 times,
// the same "status line -> caption paragraph -> button off to the
// side" pattern — each row a different width depending on its own
// text, so the 3 buttons never lined up with each other, and the
// always-visible explanatory paragraph under "Hide" and "Critical"
// made the whole card noticeably taller than it needed to be for
// something a moderator mostly just glances at. This single row
// component fixes both: a fixed-width icon column so every row's
// text starts at the same x position, the button pinned to a shared
// right edge via ml-auto instead of drifting with the label's length,
// and the explanation collapsed into a hover/focus tooltip (native
// `title`) on a small ⓘ instead of a permanent second line — still
// one click/hover away, but not competing for space by default.
function ModActionRow({ icon, status, hint, action }) {
  return (
    <div className="flex items-center gap-2.5 py-2 first:pt-0 last:pb-0">
      <span className="w-5 shrink-0 text-center text-[13px] leading-none">
        {icon}
      </span>
      <div className="min-w-0 flex-1 flex items-center gap-1.5">
        <span className="text-[12.5px] text-slate-600 dark:text-white/55 truncate">
          {status}
        </span>
        {hint && (
          <span
            title={hint}
            className="shrink-0 inline-flex items-center justify-center w-3.5 h-3.5 rounded-full
              text-[10px] leading-none text-slate-400 dark:text-white/30 border border-slate-300 dark:border-white/20
              cursor-help select-none"
          >
            i
          </span>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  Report-group card for a single post
// ─────────────────────────────────────────────────────────────

function ReportGroupCard({
  parentPostId,
  reports,
  dao,
  shieldTotalSupply,
  createLensComment,
  createLensPost,
  modActions,
  onModActionDone,
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [post, setPost] = useState(null);
  const [postLoading, setPostLoading] = useState(true);
  const [postError, setPostError] = useState("");

  const [targetIsMember, setTargetIsMember] = useState(null);
  const [sanctionType, setSanctionType] = useState(0);
  const [restrictionPeriod, setRestrictionPeriod] = useState(0);
  const [acting, setActing] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [proposalId, setProposalId] = useState(
    reports.find((r) => r.onchainProposalId)?.onchainProposalId || null,
  );

  // ADDED: blur/hide/critical hide/ban votes - computed from the full
  // moderation action log (moderationActions.js), the same way proposalId
  // above is computed from the reports.
  const [modActing, setModActing] = useState(null); // which specific action is currently in progress (disables buttons)
  const [modError, setModError] = useState("");
  // ADDED: reports here has already been filtered down to this EXACT
  // parentPostId (groupByParentPost above splits the flat list of
  // reports by post before handing it to the card) - so we pass it as
  // is, with no additional filtering.
  const modState = computeModerationState(modActions, parentPostId, {
    reports,
  });
  const banState = post?.author?.owner
    ? computeBanState(
        modActions,
        post.author.owner,
        // FIXED: shieldTotalSupply now comes from
        // fetchShieldTotalSupply() (directly from the blockchain), rather
        // than from dao.shieldInfo?.totalSupply — the latter is only
        // populated AFTER dao.connect(), and if the moderator hadn't
        // managed to do that by the time the queue rendered, the quorum
        // was always computed as 0%, meaning the ban effectively never triggered.
        shieldTotalSupply,
      )
    : null;
  const alreadyVotedBan = banState?.voters.includes(dao.account);

  // We fetch the post immediately (needed both for the preview and for
  // the author's address, without which membership can't be checked /
  // a sanction proposed).
  useEffect(() => {
    let cancelled = false;
    setPostLoading(true);
    setPostError("");
    fetchParentPost(parentPostId)
      .then((p) => {
        if (cancelled) return;
        if (!p) {
          setPostError(t("moderation_post_not_found"));
          return;
        }
        setPost(p);
      })
      .catch(() => {
        if (!cancelled) setPostError(t("moderation_post_load_failed"));
      })
      .finally(() => {
        if (!cancelled) setPostLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [parentPostId]);

  // We check the target's membership only once the moderator has
  // expanded the card and actually intends to do something - no point
  // hitting the whole queue with extra requests right at load time.
  //
  // ⚠️ FIXED: post.author.address is the Lens Account (smart contract)
  // address, NOT the EOA wallet that actually minted the Shield/Council
  // SBT (mint() is called with msg.sender = EOA). The Lens V3 Account
  // has a separate `owner` field specifically for this EOA (confirmed by
  // the official documentation: "Profile Guardian in v3, the Account has
  // an owner in more typical smart wallet fashion" -
  // lens.xyz/docs/protocol/migration). Without this, isMember()/
  // isCouncilMember() always returned false even for genuine SBT holders.
  useEffect(() => {
    if (!expanded || !post?.author?.owner || targetIsMember !== null) return;
    dao.checkTargetMembership(post.author.owner).then(setTargetIsMember);
  }, [expanded, post, targetIsMember, dao]);

  const canModerate = dao.hasShield || dao.hasCouncil;
  const canEscalate = canModerate && !proposalId && targetIsMember === true;
  const elig = canEscalate ? dao.canProposeSanction() : { eligible: true };

  const handlePropose = async () => {
    if (!post?.author?.owner) return;
    setActing(true);
    setError("");
    const res = await dao.proposeSanction(
      post.author.owner,
      parentPostId,
      sanctionType,
      restrictionPeriod,
      (msg) => setProgress(msg),
    );
    if (!res.success) {
      setActing(false);
      setError(res.error || t("moderation_proposal_failed"));
      return;
    }
    setProposalId(res.proposalId);

    // ADDED: publish a system link comment with onchainProposalId
    // immediately after successful escalation - otherwise the Proposals
    // tab would never be able to tell WHICH post this sanction vote is
    // for (violationPostRef on the contract - a one-way keccak256 hash,
    // not reversible). The sanction is already valid even if this
    // comment fails to publish - we just warn, we don't roll back the
    // created proposal.
    if (createLensComment) {
      setProgress(t("moderation_saving_link"));
      const linkRes = await createLensComment({
        content: buildEscalationLinkContent(res.proposalId),
        commentOn: parentPostId,
      });
      if (!linkRes.success) {
        setError(
          t("moderation_link_save_failed", {
            id: res.proposalId,
            error: linkRes.error || "unknown error",
          }),
        );
      }
    }
    setActing(false);
  };

  // ADDED: publishing a moderation action (blur/hide/critical/confirm)
  // as a comment ON this same post - the same createLensComment used to
  // publish the link comment above, just a different marker
  // (moderationActions.js instead of postReports.js).
  const publishModAction = async (action) => {
    setModActing(action);
    setModError("");
    try {
      const content = buildModActionContent({
        action,
        targetPostId: parentPostId,
      });
      const res = await createLensComment({ content, commentOn: parentPostId });
      if (!res.success) {
        setModError(res.error || t("moderation_action_publish_failed"));
      } else {
        await onModActionDone?.();
      }
    } catch (err) {
      setModError(err.message);
    } finally {
      setModActing(null);
    }
  };

  // ADDED: a ban vote for an account WITHOUT a Shield/Council SBT -
  // published as a REGULAR Lens post (createLensPost), not a comment:
  // this concerns the account as a whole, not a specific post, so
  // "commentOn" makes no sense here.
  const handleBanVote = async () => {
    if (!post?.author?.owner) return;
    setModActing(MOD_ACTIONS.BAN_VOTE);
    setModError("");
    try {
      const content = buildModActionContent({
        action: MOD_ACTIONS.BAN_VOTE,
        targetAccount: post.author.owner,
      });
      const res = await createLensPost({
        content,
        countryCode: "EARTH",
        category: "mod_action",
      });
      if (!res.success) {
        setModError(res.error || t("moderation_ban_vote_failed"));
      } else {
        await onModActionDone?.();
      }
    } catch (err) {
      setModError(err.message);
    } finally {
      setModActing(null);
    }
  };

  const author =
    post?.author?.username?.localName || post?.author?.address?.slice(0, 10);
  const content = post?.metadata?.content || "";
  // CHANGED: previously anything not a repost/comment was simply
  // labeled "Post" — even if the report was actually filed on a help
  // request or a violation. Both are published via the same Lens Post,
  // just with different metadata tags (useLensHelpRequests.js: tags
  // include "help_request"; useLensViolations.js: tags include
  // "violation" — the same tag its list is filtered by). post.commentOn
  // still takes priority: if it's a comment, it doesn't matter what it
  // was written on, we simply label it "Comment" (details are visible in
  // the preview below via the link).
  const isTargetComment = !!post?.commentOn;
  const postTags = post?.metadata?.tags || [];
  const targetKind = isTargetComment
    ? "comment"
    : postTags.includes("violation")
      ? "violation"
      : postTags.includes("help_request")
        ? "help_request"
        : "post";
  const TARGET_META = {
    comment: {
      label: t("moderation_target_comment"),
      previewTitle: t("moderation_preview_comment"),
    },
    violation: {
      label: t("moderation_target_violation"),
      previewTitle: t("moderation_preview_violation"),
    },
    help_request: {
      label: t("moderation_target_help_request"),
      previewTitle: t("moderation_preview_help_request"),
    },
    post: {
      label: t("moderation_target_post"),
      previewTitle: t("moderation_preview_post"),
    },
  };
  const targetLabel = TARGET_META[targetKind].label;
  const targetPreviewTitle = TARGET_META[targetKind].previewTitle;
  // ADDED: help requests and violations have their own pages
  // (HelpRequestPage at /help/:id, ViolationDetailsPage at
  // /violations/:id — the same paths used in shareData.url on those
  // pages) — previously the view button always went to /post/:id
  // (PostPage), even when the target was actually a help request or a
  // violation, so the wrong page/layout was shown. Comments and regular
  // posts still go through /post/:id — there's no separate page for a
  // comment (there it shows a banner linking to the parent entry), and
  // for a regular post /post/:id is the correct page anyway.
  const targetPath =
    targetKind === "help_request"
      ? `/help/${parentPostId}`
      : targetKind === "violation"
        ? `/violations/${parentPostId}`
        : `/post/${parentPostId}`;

  return (
    <div className="bg-white dark:bg-[#000d1f] border border-slate-200 dark:border-white/[0.07] rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
          <span className="text-[14px] font-medium text-slate-700 dark:text-white/75 truncate">
            {postLoading
              ? t("moderation_loading")
              : postError
                ? postError
                : `${targetLabel} @${author}`}
          </span>
          <span className="text-[11px] text-slate-400 dark:text-white/25 flex-shrink-0">
            · {t("moderation_reports_count", { count: reports.length })}
          </span>
          {/* ADDED: if computeModerationState() determined that the post
              was AUTOMATICALLY blurred (a spike in reports not yet
              manually reviewed) - explicitly show this to the moderator
              via a separate badge, otherwise "blurred" alone doesn't show
              whether this was a manual action or automation awaiting
              review. */}
          {modState.autoQuarantined && (
            <span
              className="text-[11px] font-medium px-1.5 py-0.5 rounded-[5px] flex-shrink-0
                bg-amber-500/10 border border-amber-500/25 text-amber-500"
              title={t("moderation_auto_quarantine_title", {
                count: modState.autoQuarantineDistinctReporters,
              })}
            >
              {t("moderation_auto_quarantine_badge")}
            </span>
          )}
          {proposalId && (
            <span className="text-[11px] text-emerald-500 flex-shrink-0">
              · {t("moderation_proposal_ref", { id: proposalId })}
            </span>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-slate-400 flex-shrink-0" />
        ) : (
          <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-100 dark:border-white/[0.06] pt-3">
          {/* Preview of the offending post */}
          {post && (
            <div className="p-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.07] rounded-xl">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[11px] text-slate-400 dark:text-white/25 uppercase tracking-[0.06em]">
                  {targetPreviewTitle}
                </p>
                {/* SPA navigation, consistent with CountryFeed.jsx:
                    navigate(`/post/${postId}`) */}
                <button
                  onClick={() => navigate(targetPath)}
                  className="text-slate-400 dark:text-white/25 hover:text-slate-600 dark:hover:text-white/50"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </button>
              </div>
              <p className="text-[13px] text-slate-600 dark:text-white/60 line-clamp-4">
                {content.substring(0, 300) || t("moderation_no_text")}
                {content.length > 300 && "..."}
              </p>
            </div>
          )}

          {/* ADDED: content moderation actions - blur/hide/critical.
              Unlike the sanction below (which only applies to SBT
              holders), these actions apply to ANY author - regardless
              of status, Shield, or Council. Accountability: Shield/Council
              members are themselves SBT holders, so abusing this right is
              grounds for a sanction AGAINST THEM via the regular
              proposeSanction() below.
              REDESIGNED (compact): see ModActionRow above for why —
              same 3 actions, but now a fixed-width icon column keeps
              every row's text aligned, buttons sit on one shared
              right edge instead of drifting with label length, and
              the long explanatory paragraphs collapsed into a hover
              ⓘ tooltip so the card doesn't spend most of its height
              on text nobody reads twice. */}
          {canModerate && (
            <div className="p-3 bg-slate-50 dark:bg-white/[0.02] border border-slate-200 dark:border-white/[0.06] rounded-xl">
              <p className="text-[11px] text-slate-400 dark:text-white/25 uppercase tracking-[0.06em] mb-1">
                {t("moderation_content_actions")}
              </p>

              {modError && (
                <p className="text-[12px] text-red-400/80 pb-1">{modError}</p>
              )}

              <div className="divide-y divide-slate-200/70 dark:divide-white/[0.06]">
                {/* Blur - low stakes, 1 vote, anyone can remove it */}
                <ModActionRow
                  icon="🌫"
                  status={
                    modState.blurred
                      ? t("moderation_blurred_yes")
                      : t("moderation_blurred_no")
                  }
                  action={
                    <button
                      onClick={() =>
                        publishModAction(
                          modState.blurred
                            ? MOD_ACTIONS.UNBLUR
                            : MOD_ACTIONS.BLUR,
                        )
                      }
                      disabled={!!modActing}
                      className="px-2.5 py-1 text-[12px] font-medium rounded-lg
                        bg-slate-200/60 dark:bg-white/[0.06] text-slate-600 dark:text-white/60
                        hover:bg-slate-300/60 dark:hover:bg-white/[0.1] transition-colors
                        disabled:opacity-40"
                    >
                      {modState.blurred
                        ? t("moderation_unblur")
                        : t("moderation_blur")}
                    </button>
                  }
                />

                {/* Urgent hide - 1 vote hides it, a DIFFERENT moderator
                    (not the same one) can restore it - deliberate peer
                    review. The distinction from "Critical" below is now
                    explained via the row's ⓘ tooltip instead of a
                    permanent caption line. */}
                <ModActionRow
                  icon="⛔"
                  status={
                    modState.hidden && modState.hiddenReason === "hide"
                      ? t("moderation_hidden_by", {
                          addr: modState.hiddenBy?.slice(0, 6),
                        })
                      : t("moderation_visible_in_feed")
                  }
                  hint={t("moderation_hide_now_description")}
                  action={
                    modState.hidden && modState.hiddenReason === "hide"
                      ? modState.hiddenBy !== dao.account && (
                          <button
                            onClick={() => publishModAction(MOD_ACTIONS.UNHIDE)}
                            disabled={!!modActing}
                            className="px-2.5 py-1 text-[12px] font-medium rounded-lg
                              bg-slate-200/60 dark:bg-white/[0.06] text-slate-600 dark:text-white/60
                              hover:bg-slate-300/60 dark:hover:bg-white/[0.1] transition-colors
                              disabled:opacity-40"
                          >
                            {t("moderation_restore")}
                          </button>
                        )
                      : !modState.hidden && (
                          <button
                            onClick={() => publishModAction(MOD_ACTIONS.HIDE)}
                            disabled={!!modActing}
                            className="px-2.5 py-1 text-[12px] font-medium rounded-lg
                              bg-red-500/10 border border-red-500/20 text-red-400/80
                              hover:bg-red-500/18 transition-colors disabled:opacity-40"
                          >
                            {t("moderation_hide_now")}
                          </button>
                        )
                  }
                />

                {/* Critical (extremism/CSAM) - 1 vote hides it
                    IMMEDIATELY, but requires CRITICAL_CONFIRM_REQUIRED
                    confirmations from OTHER moderators within 48h,
                    otherwise it auto-reverts. Deadline (when active)
                    stays visible in the status text since it's
                    time-sensitive; the general explanation moved to
                    the ⓘ tooltip. */}
                <ModActionRow
                  icon="🚨"
                  status={
                    modState.hidden && modState.hiddenReason === "critical"
                      ? t("moderation_critical_hidden", {
                          confirmed: modState.criticalConfirmations.length,
                          required: CRITICAL_CONFIRM_REQUIRED,
                        })
                      : t("moderation_not_critical")
                  }
                  hint={
                    modState.hidden && modState.hiddenReason === "critical"
                      ? t("moderation_critical_deadline_note", {
                          required: CRITICAL_CONFIRM_REQUIRED,
                          deadline: new Date(
                            modState.criticalDeadline,
                          ).toLocaleString(
                            i18n.language === "uk" ? "uk-UA" : "en-US",
                            {
                              day: "2-digit",
                              month: "2-digit",
                              year: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            },
                          ),
                        })
                      : t("moderation_critical_general_note")
                  }
                  action={
                    modState.hidden && modState.hiddenReason === "critical"
                      ? modState.criticalHideBy !== dao.account &&
                        !modState.criticalConfirmations.includes(
                          dao.account,
                        ) &&
                        !modState.criticalConfirmed && (
                          <button
                            onClick={() =>
                              publishModAction(MOD_ACTIONS.CRITICAL_CONFIRM)
                            }
                            disabled={!!modActing}
                            className="px-2.5 py-1 text-[12px] font-medium rounded-lg
                              bg-purple-500/10 border border-purple-500/25 text-purple-400/80
                              hover:bg-purple-500/18 transition-colors disabled:opacity-40"
                          >
                            {t("moderation_confirm")}
                          </button>
                        )
                      : !modState.hidden && (
                          <button
                            onClick={() =>
                              publishModAction(MOD_ACTIONS.CRITICAL_HIDE)
                            }
                            disabled={!!modActing}
                            className="px-2.5 py-1 text-[12px] font-medium rounded-lg
                              bg-purple-500/10 border border-purple-500/25 text-purple-400/80
                              hover:bg-purple-500/18 transition-colors disabled:opacity-40"
                          >
                            {t("moderation_critical_button")}
                          </button>
                        )
                  }
                />
              </div>
            </div>
          )}

          {/* List of reports on this post.
              FILTERED OUT: the system link entry (isEscalationLinkReport) -
              it isn't meant to be read by humans, only for programmatic
              lookup of "post by proposalId" in GovernancePage.jsx.
              proposalId above still takes its value from reports.find(...)
              on the UNfiltered list - this doesn't break anything. */}
          <div className="space-y-2">
            {reports
              .filter((r) => !isEscalationLinkReport(r))
              .map((r) => (
                <div
                  key={r.commentId}
                  className="p-3 bg-slate-50 dark:bg-white/[0.02] border border-slate-200 dark:border-white/[0.06] rounded-xl space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <CategoryPill value={r.category} />
                    <span className="text-[11px] text-slate-400 dark:text-white/25">
                      {t("moderation_from_reporter", {
                        handle:
                          r.reporterHandle || r.reporterAddress?.slice(0, 10),
                      })}{" "}
                      · {timeAgo(r.createdAt, t)}
                    </span>
                  </div>
                  <p className="text-[13px] text-slate-600 dark:text-white/55 leading-relaxed">
                    {r.description}
                  </p>
                </div>
              ))}
          </div>

          {/* Action: escalation into a sanction proposal.
              Voting/veto/execution now lives exclusively in the
              separate DAO app (see GovernanceRedirect.jsx /
              DAO_APP_URL) — this app only creates the case
              (dao.proposeSanction, above) and links out to it. */}
          {!canModerate ? null : proposalId ? (
            <p className="text-[12px] text-emerald-500/85 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" />
              {t("moderation_proposal_already_created", { id: proposalId })}{" "}
              <a
                href={`${DAO_APP_URL}/moderation?case=${proposalId}${
                  dao.account ? `&wallet=${dao.account}` : ""
                }`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-emerald-400"
              >
                DAO app ↗
              </a>
            </p>
          ) : targetIsMember === null ? (
            <p className="text-[11px] text-slate-400 dark:text-white/30">
              {t("moderation_checking_membership")}
            </p>
          ) : targetIsMember === false ? (
            <div className="p-3 bg-slate-100 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.08] rounded-xl space-y-2">
              <p className="text-[12px] text-slate-500 dark:text-white/40 leading-relaxed">
                {t("moderation_author_no_sbt")}
              </p>

              {/* ADDED: ban voting for accounts without an SBT - since
                  DisciplineModule doesn't apply here (no token to
                  restrict), the only way to respond to a systematically
                  harmful author without status is a collective "ban" vote
                  with a quorum, entirely off the smart contract (Lens
                  comments, moderationActions.js). "Ban" here means only
                  "hidden and blocked within this app" - it's technically
                  impossible to delete someone else's Lens Account or wallet. */}
              {banState && (
                <div className="pt-2 border-t border-slate-200 dark:border-white/[0.06] space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-slate-400 dark:text-white/25">
                      {t("moderation_ban_votes_label")}
                    </span>
                    <span className="text-slate-400 dark:text-white/25">
                      {t("moderation_ban_votes_progress", {
                        count: banState.voters.length,
                        pct: banState.quorumPct.toFixed(0),
                        required: (BAN_QUORUM_PCT * 100).toFixed(0),
                      })}
                    </span>
                  </div>
                  <div className="h-[3px] rounded-full bg-slate-200 dark:bg-white/[0.07] overflow-hidden">
                    <div
                      className="h-full bg-red-500/80 transition-all"
                      style={{
                        width: `${Math.min(100, banState.quorumPct)}%`,
                      }}
                    />
                  </div>
                  {banState.banned ? (
                    <p className="text-[12px] text-red-400/85 font-medium">
                      {t("moderation_ban_quorum_reached")}
                    </p>
                  ) : banState.expired ? (
                    <p className="text-[12px] text-slate-400 dark:text-white/30">
                      {t("moderation_ban_vote_ended")}
                    </p>
                  ) : (
                    <button
                      onClick={handleBanVote}
                      disabled={!!modActing || alreadyVotedBan}
                      className="px-2.5 py-1 text-[12px] font-medium rounded-lg
                        bg-red-500/10 border border-red-500/22 text-red-400/80
                        hover:bg-red-500/18 transition-colors disabled:opacity-40"
                    >
                      {alreadyVotedBan
                        ? t("moderation_already_voted")
                        : t("moderation_vote_ban")}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="p-3 bg-amber-500/[0.06] border border-amber-500/20 rounded-xl space-y-3">
              <div>
                <label className="block text-[11px] text-slate-400 dark:text-white/25 uppercase tracking-[0.06em] mb-1">
                  {t("sanction_type_label")}
                </label>
                <select
                  value={sanctionType}
                  onChange={(e) => setSanctionType(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-lg bg-white dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.1]
                    text-[13px] text-slate-700 dark:text-white/70"
                >
                  <option value={0}>{t("sanction_type_warning")}</option>
                  <option value={1}>
                    {t("sanction_type_partial_restriction")}
                  </option>
                  <option value={2}>{t("sanction_type_full_slash")}</option>
                </select>
              </div>

              {sanctionType === 1 && (
                <div>
                  <label className="block text-[11px] text-slate-400 dark:text-white/25 uppercase tracking-[0.06em] mb-1">
                    {t("restriction_period_label")}
                  </label>
                  <select
                    value={restrictionPeriod}
                    onChange={(e) =>
                      setRestrictionPeriod(Number(e.target.value))
                    }
                    className="w-full px-3 py-2 rounded-lg bg-white dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.1]
                      text-[13px] text-slate-700 dark:text-white/70"
                  >
                    <option value={0}>{t("restriction_period_quarter")}</option>
                    <option value={1}>{t("restriction_period_year")}</option>
                    <option value={2}>{t("restriction_period_5years")}</option>
                    <option value={3}>{t("restriction_period_forever")}</option>
                  </select>
                </div>
              )}

              {!elig.eligible && (
                <p className="text-[11px] text-red-400">{elig.reason}</p>
              )}
              {error && <p className="text-[11px] text-red-400">{error}</p>}
              {progress && !error && (
                <p className="text-[11px] text-blue-400">{progress}</p>
              )}

              <button
                onClick={handlePropose}
                disabled={acting || !elig.eligible}
                className="w-full py-2 rounded-lg text-[13px] font-medium
                  bg-[#8B1A2A] border border-[#8B1A2A]/30 text-white/95
                  hover:bg-[#9B2232] dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/80 dark:hover:bg-[#3d0012]
                  transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {acting
                  ? t("moderation_creating")
                  : t("moderation_create_sanction_proposal")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
//  Main component
// ─────────────────────────────────────────────────────────────

export default function ModerationQueue({
  dao,
  createLensComment,
  createLensPost,
}) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState(null); // null = not loaded yet
  const [modActions, setModActions] = useState([]);
  // ADDED: totalSupply() of the Shield SBT directly from the blockchain
  // — doesn't depend on whether the moderator has already called
  // dao.connect() on this page.
  const [shieldTotalSupply, setShieldTotalSupply] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // ADDED: modActions is loaded in parallel with the reports - it's
      // needed for computeModerationState/computeBanState below
      // (blur/hide/ban votes, moderationActions.js). Both are the same
      // scan of the app's posts by tag, just with different marker prefixes.
      const [reports, actions, supply] = await Promise.all([
        fetchAllReportComments(),
        fetchAllModActions(),
        fetchShieldTotalSupply(),
      ]);
      setGroups(groupByParentPost(reports));
      setModActions(actions);
      setShieldTotalSupply(supply);
    } catch (err) {
      setError(err.message || t("moderation_queue_load_failed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const entries = groups ? Array.from(groups.entries()) : [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-slate-400 dark:text-white/30">
          {groups
            ? t("moderation_entries_count", { count: entries.length })
            : t("moderation_loading")}
        </p>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-1 text-[13px] text-slate-400 dark:text-white/30
            hover:text-slate-600 dark:hover:text-white/50 border border-slate-200
            dark:border-white/[0.08] rounded-lg transition-colors disabled:opacity-30"
        >
          {loading ? "..." : `↻ ${t("refresh") || "Refresh"}`}
        </button>
      </div>

      {error && (
        <div className="bg-red-500/[0.07] border border-red-500/22 rounded-xl px-4 py-3 text-[14px] text-red-400/75">
          ✗ {error}
        </div>
      )}

      {loading && !groups && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-14 rounded-xl bg-slate-100 dark:bg-white/[0.03] animate-pulse"
            />
          ))}
        </div>
      )}

      {groups && entries.length === 0 && !loading && (
        <div className="flex flex-col items-center justify-center text-center gap-2 py-16">
          <div className="text-4xl opacity-30">🛡</div>
          <p className="text-[14px] text-slate-400 dark:text-white/30">
            {t("moderation_no_reports")}
          </p>
        </div>
      )}

      {entries.map(([parentPostId, reports]) => (
        <ReportGroupCard
          key={parentPostId}
          parentPostId={parentPostId}
          reports={reports}
          dao={dao}
          shieldTotalSupply={shieldTotalSupply}
          createLensComment={createLensComment}
          createLensPost={createLensPost}
          modActions={modActions}
          onModActionDone={load}
        />
      ))}
    </div>
  );
}
