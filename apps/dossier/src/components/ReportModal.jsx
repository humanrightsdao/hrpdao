// src/components/ReportModal.jsx
//
// Report on a post:
//   - A regular user (without Shield): creates a structured Lens
//     comment (REPORT_TAG marker) - goes into the moderation queue, is
//     NOT shown in the regular comment thread.
//   - A Shield/Council holder: IMMEDIATELY creates an on-chain sanction
//     proposal (DisciplineModule.proposeSanction) - no intermediate
//     queue. The description of the violation still goes through the
//     same structured comment (the contract has no field for text),
//     just with onchainProposalId already filled in for traceability.

import React, { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  Image as ImageIcon,
  Video as VideoIcon,
  File as FileIcon,
  AlertTriangle,
} from "lucide-react";
import {
  REPORT_CATEGORIES,
  buildReportContent,
  reportPostToLensNative,
} from "../utils/postReports";

export default function ReportModal({
  post,
  authorAddress,
  authorCandidates,
  createLensComment,
  sessionClient,
  countryCode,
  dao, // the result of useLensDAO()
  onClose,
  onSubmitted, // (result) => void - called after success
}) {
  const { t } = useTranslation();
  const {
    hasShield,
    hasCouncil,
    proposeSanction,
    canProposeSanction,
    resolveSanctionTarget,
  } = dao;
  const reporterEligible = hasShield || hasCouncil;

  // ⚠️ DisciplineModule.proposeSanction() requires that the TARGET (the
  // post's author) themselves hold a Shield/Council SBT - the sanction
  // acts ON the token itself, no token means nothing to restrict/burn.
  // Posts store SEVERAL possible author addresses (the Lens Account
  // smart contract ≠ the EOA wallet that actually minted the SBT) - we
  // check the WHOLE list of candidates, not just the first one by
  // priority (this is exactly what caused the false "no membership" before).
  const [resolvedTarget, setResolvedTarget] = useState(undefined); // undefined = still checking, null = no one found
  useEffect(() => {
    let cancelled = false;
    const candidates =
      authorCandidates?.length > 0 ? authorCandidates : [authorAddress];
    resolveSanctionTarget(candidates).then((result) => {
      if (!cancelled) setResolvedTarget(result);
    });
    return () => {
      cancelled = true;
    };
  }, [authorAddress, authorCandidates, resolveSanctionTarget]);

  const targetIsMember =
    resolvedTarget === undefined ? null : resolvedTarget !== null;
  const canSanctionDirectly = reporterEligible && targetIsMember === true;
  // proposeSanction() needs the EXACT SAME address that actually passed
  // the isMember/isCouncilMember check - not the "default" authorAddress.
  const sanctionTargetAddress = resolvedTarget || authorAddress;

  const [category, setCategory] = useState(REPORT_CATEGORIES[0].value);
  const [description, setDescription] = useState("");
  const [sanctionType, setSanctionType] = useState(0); // 0=Warning
  const [restrictionPeriod, setRestrictionPeriod] = useState(0);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const elig = canSanctionDirectly ? canProposeSanction() : { eligible: true };

  const handleSubmit = async () => {
    if (!description.trim()) {
      setError(t("report_describe_required"));
      return;
    }
    if (canSanctionDirectly && !elig.eligible) {
      setError(elig.reason);
      return;
    }

    setLoading(true);
    setError("");

    try {
      let onchainProposalId = null;

      if (canSanctionDirectly) {
        // ── Shield/Council: immediately on-chain ────────────────────
        setProgress(t("report_creating_sanction"));
        const res = await proposeSanction(
          sanctionTargetAddress,
          post.lens_post_id || post.id,
          sanctionType,
          restrictionPeriod,
          (msg) => setProgress(msg),
        );
        if (!res.success) {
          setError(res.error || t("report_proposal_failed"));
          setLoading(false);
          return;
        }
        onchainProposalId = res.proposalId;
      }

      // ── Both cases: a structured comment with a description ───
      setProgress(t("report_saving_description"));
      const content = buildReportContent({
        category,
        description: description.trim(),
        onchainProposalId,
      });
      const commentRes = await createLensComment({
        content,
        commentOn: post.lens_post_id || post.id,
        countryCode: countryCode || "EARTH",
      });
      if (!commentRes.success) {
        // The on-chain proposal (if there was one) has already been
        // created and remains valid even if the description comment
        // couldn't be published - we don't roll it back, we just warn.
        setError(
          (onchainProposalId
            ? t("report_proposal_created_desc_failed", {
                id: onchainProposalId,
              })
            : t("report_save_failed_prefix")) +
            (commentRes.error || t("report_unknown_error")),
        );
        setLoading(false);
        return;
      }

      setDone(true);

      // In parallel (best-effort, non-blocking) - the native Lens report.
      // The category is kept in sync via REPORT_CATEGORIES[].lensReason.
      if (sessionClient) {
        const cat = REPORT_CATEGORIES.find((c) => c.value === category);
        reportPostToLensNative(
          sessionClient,
          post.lens_post_id || post.id,
          cat?.lensReason || "SOMETHING_ELSE",
        ).then((r) => {
          if (!r.success) {
            console.warn(
              "[ReportModal] native Lens report failed (not critical):",
              r.error,
            );
          }
        });
      }

      onSubmitted?.({ onchainProposalId });
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const mediaCount = post.media_urls?.length || 0;

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white dark:bg-[#000d1f] border border-slate-200 dark:border-white/[0.1]
          rounded-2xl shadow-xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-slate-100 dark:border-white/[0.06]">
          <h3 className="text-[16px] font-semibold text-slate-800 dark:text-white/85 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500" />
            {t("report_modal_title")}
          </h3>
          <button
            onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.06]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Preview of the post being reported */}
          <div className="p-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.07] rounded-xl">
            <p className="text-[11px] text-slate-400 dark:text-white/25 uppercase tracking-[0.06em] mb-1">
              {t("report_post_being_reported")}
            </p>
            <p className="text-[13px] text-slate-600 dark:text-white/60 line-clamp-3">
              {post.content?.substring(0, 200) || t("report_no_text")}
              {post.content?.length > 200 && "..."}
            </p>
            {mediaCount > 0 && (
              <div className="flex items-center gap-1 mt-2 text-[11px] text-slate-400 dark:text-white/30">
                {post.media_types?.[0] === "image" && (
                  <ImageIcon className="w-3.5 h-3.5" />
                )}
                {post.media_types?.[0] === "video" && (
                  <VideoIcon className="w-3.5 h-3.5" />
                )}
                {!["image", "video"].includes(post.media_types?.[0]) && (
                  <FileIcon className="w-3.5 h-3.5" />
                )}
                {t("report_media_attached", { count: mediaCount })}
              </div>
            )}
            <a
              href={`${window.location.origin}/post/${post.lens_post_id || post.id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block mt-2 text-[11px] underline text-blue-400/70 hover:text-blue-400"
            >
              {t("report_view_full_post")}
            </a>
          </div>

          {done ? (
            <div className="text-center py-4">
              <p className="text-[14px] text-emerald-500 font-medium">
                ✓{" "}
                {canSanctionDirectly
                  ? t("report_sanction_submitted")
                  : t("report_complaint_submitted")}
              </p>
              <button
                onClick={onClose}
                className="mt-3 px-4 py-2 text-[13px] bg-slate-100 dark:bg-white/[0.06] rounded-lg"
              >
                {t("report_close")}
              </button>
            </div>
          ) : (
            <>
              {/* Category */}
              <div>
                <label className="block text-[11px] text-slate-400 dark:text-white/25 uppercase tracking-[0.06em] mb-1">
                  {t("report_violation_category")}
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.1]
                    text-[13px] text-slate-700 dark:text-white/70"
                >
                  {REPORT_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {t(c.labelKey) || c.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Description */}
              <div>
                <label className="block text-[11px] text-slate-400 dark:text-white/25 uppercase tracking-[0.06em] mb-1">
                  {t("report_what_violates")}
                </label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  rows={3}
                  placeholder={t("report_describe_placeholder")}
                  className="w-full px-3 py-2 rounded-lg bg-slate-50 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.1]
                    text-[13px] text-slate-700 dark:text-white/70 resize-none"
                />
              </div>

              {/* Shield/Council: choose the sanction right away (only if the TARGET also has an SBT) */}
              {targetIsMember === null && reporterEligible && (
                <p className="text-[11px] text-slate-400 dark:text-white/30">
                  {t("report_checking_membership")}
                </p>
              )}
              {reporterEligible && targetIsMember === false && (
                <div className="p-3 bg-slate-100 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.08] rounded-xl">
                  <p className="text-[12px] text-slate-500 dark:text-white/40 leading-relaxed">
                    {t("report_author_no_sbt")}
                  </p>
                </div>
              )}
              {canSanctionDirectly ? (
                <div className="p-3 bg-amber-500/[0.06] border border-amber-500/20 rounded-xl space-y-3">
                  <p className="text-[12px] text-amber-600 dark:text-amber-400/80 font-medium">
                    {t("report_shield_owner_notice")}
                  </p>
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
                      <option value={2}>
                        {t("sanction_type_full_slash")}
                      </option>
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
                </div>
              ) : (
                <p className="text-[11px] text-slate-400 dark:text-white/30 leading-relaxed">
                  {t("report_will_queue_notice")}
                </p>
              )}

              {error && (
                <p className="text-[12px] text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                  {error}
                </p>
              )}
              {progress && !error && (
                <p className="text-[12px] text-blue-400">{progress}</p>
              )}

              <button
                onClick={handleSubmit}
                disabled={
                  loading ||
                  !description.trim() ||
                  (reporterEligible && targetIsMember === null)
                }
                className="w-full py-2.5 rounded-xl text-[14px] font-medium
                  bg-[#8B1A2A] border border-[#8B1A2A]/30 text-white/95
                  hover:bg-[#9B2232] dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/80 dark:hover:bg-[#3d0012]
                  transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {loading
                  ? t("report_sending")
                  : canSanctionDirectly
                    ? t("report_create_sanction_proposal")
                    : t("report_send_complaint")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
