import { useEffect, useState } from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Flag, Loader2, ShieldAlert, ExternalLink } from "lucide-react";
import { pool, RELAYS } from "../lib/nostrLookup";
import {
  fetchAllForumReports,
  fetchAllForumModActions,
  publishModAction,
  computeModerationState,
  MOD_ACTIONS,
  CRITICAL_CONFIRM_REQUIRED,
} from "../lib/forumModeration";
import { useNostrIdentity } from "../hooks/useNostrIdentity";
import { tDaoMessage } from "../lib/daoMessages";
import { fmtRelative, truncAddr } from "../lib/format";

const CATEGORY_LABEL_KEYS = {
  hate_speech: "categoryHateSpeech",
  violence_incitement: "categoryViolenceIncitement",
  harassment: "categoryHarassment",
  csam_or_minors: "categoryCsamOrMinors",
  misinformation: "categoryMisinformation",
  spam: "categorySpam",
  other: "categoryOther",
};

// The forum's own moderation queue — see src/lib/forumModeration.js for
// the underlying read/write logic (ported from dossier-app's
// moderationActions.js, adapted to Nostr events instead of Lens
// comments). Visible to everyone (transparency — same as
// ModerationPage.jsx's list of sanction cases), but the action buttons
// only work for Shield/Council holders, same rule as posting itself
// (see useDao.js's canPostToForum/canProposeSanction).
export default function ForumModerationPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const navigate = useNavigate();
  const { getSignerPubkey, signEvent } = useNostrIdentity();

  const [reports, setReports] = useState([]);
  const [actions, setActions] = useState([]);
  const [targets, setTargets] = useState({}); // eventId -> { body, address, pubkey } | "not_found"
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null); // `${eventId}-${action}`
  const [actionError, setActionError] = useState(null);

  const canModerate = dao.hasShield || dao.hasCouncil;

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [rpts, acts] = await Promise.all([fetchAllForumReports(), fetchAllForumModActions()]);
      setReports(rpts);
      setActions(acts);

      const ids = [...new Set(rpts.map((r) => r.targetEventId))];
      const found = await pool.querySync(RELAYS, { ids });
      const byId = {};
      for (const id of ids) {
        const ev = found.find((e) => e.id === id);
        byId[id] = ev
          ? {
              body: ev.content,
              address: ev.tags.find((t) => t[0] === "address")?.[1] || null,
              pubkey: ev.pubkey,
            }
          : "not_found";
      }
      setTargets(byId);
    } catch (e) {
      setError(e.message || "Failed to load the forum moderation queue.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // Group reports by the event they're reporting on.
  const grouped = {};
  for (const r of reports) {
    (grouped[r.targetEventId] ||= []).push(r);
  }
  const groups = Object.entries(grouped).sort(
    (a, b) => Math.max(...b[1].map((r) => r.createdAt)) - Math.max(...a[1].map((r) => r.createdAt)),
  );

  async function handleAction(targetEventId, action) {
    setBusyKey(`${targetEventId}-${action}`);
    setActionError(null);
    const res = await publishModAction({
      action,
      targetEventId,
      getSignerPubkey,
      signEvent,
      address: dao.account,
    });
    setBusyKey(null);
    if (!res.success) {
      setActionError(tDaoMessage(t, res.error));
      return;
    }
    // Optimistic local update so the button state flips immediately,
    // instead of waiting on relay propagation + a full reload.
    setActions((prev) => [
      ...prev,
      {
        id: res.id,
        moderatorAddress: dao.account?.toLowerCase(),
        createdAt: Math.floor(Date.now() / 1000),
        action,
        targetEventId,
      },
    ]);
  }

  function handleEscalate(targetEventId, targetAddress) {
    if (!targetAddress) return;
    navigate(`/moderation?target=${targetAddress}&evidence=${targetEventId}`);
  }

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.forumModeration.eyebrow")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-2 flex items-center gap-3">
        <Flag size={26} className="text-sealBright" />
        {t("dao.forumModeration.title")}
      </h1>
      <p className="text-parchmentDim text-sm mb-6">
        {t("dao.forumModeration.description")}
      </p>

      {!canModerate && (
        <p className="font-mono text-xs text-parchmentDim mb-6 rounded-xl border border-hairline p-3">
          {t("dao.forumModeration.readOnlyNotice")}
        </p>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-10 text-parchmentDim">
          <Loader2 size={18} className="animate-spin" />
          <span className="font-mono text-sm">{t("dao.forumModeration.loading")}</span>
        </div>
      )}

      {error && <p className="font-mono text-xs text-sealBright mb-4">{error}</p>}
      {actionError && <p className="font-mono text-xs text-sealBright mb-4">{actionError}</p>}

      {!loading && groups.length === 0 && (
        <div className="rounded-2xl border border-hairline p-8 text-center font-mono text-sm text-parchmentDim">
          {t("dao.forumModeration.noReports")}
        </div>
      )}

      <div className="space-y-4">
        {groups.map(([targetEventId, groupReports]) => {
          const target = targets[targetEventId];
          const state = computeModerationState(actions, targetEventId);
          const busyPrefix = `${targetEventId}-`;

          return (
            <div key={targetEventId} className="rounded-2xl border border-hairline p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="font-mono text-[11px] text-parchmentDim">
                  {t("dao.forumModeration.reportCount", { count: groupReports.length })}
                  {target && target !== "not_found" && target.address && (
                    <> · {truncAddr(target.address)}</>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {state.hidden && (
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border border-sealBright text-sealBright">
                      {state.hiddenReason === "critical"
                        ? t("dao.forumModeration.stateCriticalHidden")
                        : t("dao.forumModeration.stateHidden")}
                    </span>
                  )}
                  {!state.hidden && state.blurred && (
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border border-gold text-gold">
                      {t("dao.forumModeration.stateBlurred")}
                    </span>
                  )}
                </div>
              </div>

              {/* ── The reported content itself ─────────────────── */}
              <div className="rounded-xl bg-surface2 p-3 mb-3">
                {target === "not_found" && (
                  <p className="font-mono text-xs text-parchmentDim italic">
                    {t("dao.forumModeration.contentNotFound")}
                  </p>
                )}
                {target && target !== "not_found" && (
                  <p className="text-parchment text-sm whitespace-pre-wrap line-clamp-4">
                    {target.body}
                  </p>
                )}
              </div>

              {/* ── Individual reports ───────────────────────────── */}
              <div className="space-y-2 mb-4">
                {groupReports.map((r) => (
                  <div key={r.id} className="font-mono text-[11px] text-parchmentDim flex flex-wrap gap-x-2">
                    <span className="text-sealBright">{t(`dao.forumReport.${CATEGORY_LABEL_KEYS[r.category] || "categoryOther"}`)}</span>
                    {r.description && <span>— {r.description}</span>}
                    <span className="ml-auto">
                      {r.reporterAddress ? truncAddr(r.reporterAddress) : t("dao.forumModeration.anonymousReporter")} · {fmtRelative(r.createdAt)}
                    </span>
                  </div>
                ))}
              </div>

              {/* ── Critical-hide confirmation progress ──────────── */}
              {state.hiddenReason === "critical" && !state.criticalConfirmed && (
                <p className="font-mono text-[11px] text-gold mb-3">
                  {t("dao.forumModeration.criticalProgress", {
                    have: state.criticalConfirmations.length,
                    need: CRITICAL_CONFIRM_REQUIRED,
                  })}
                  {" · "}
                  {t("dao.forumModeration.criticalDeadline", {
                    time: new Date(state.criticalDeadline).toLocaleString(),
                  })}
                </p>
              )}

              {/* ── Actions ───────────────────────────────────────── */}
              <div className="flex flex-wrap gap-2">
                {canModerate && !state.hidden && (
                  <>
                    <button
                      onClick={() => handleAction(targetEventId, state.blurred ? MOD_ACTIONS.UNBLUR : MOD_ACTIONS.BLUR)}
                      disabled={busyKey === busyPrefix + (state.blurred ? MOD_ACTIONS.UNBLUR : MOD_ACTIONS.BLUR)}
                      className="font-mono text-xs px-3 py-1.5 rounded-full border border-gold text-gold hover:bg-gold/10 transition-colors disabled:opacity-40"
                    >
                      {state.blurred ? t("dao.forumModeration.unblur") : t("dao.forumModeration.blur")}
                    </button>
                    <button
                      onClick={() => handleAction(targetEventId, MOD_ACTIONS.HIDE)}
                      disabled={busyKey === busyPrefix + MOD_ACTIONS.HIDE}
                      className="font-mono text-xs px-3 py-1.5 rounded-full border border-sealBright text-sealBright hover:bg-sealBright/10 transition-colors disabled:opacity-40"
                    >
                      {t("dao.forumModeration.hide")}
                    </button>
                    <button
                      onClick={() => handleAction(targetEventId, MOD_ACTIONS.CRITICAL_HIDE)}
                      disabled={busyKey === busyPrefix + MOD_ACTIONS.CRITICAL_HIDE}
                      className="font-mono text-xs px-3 py-1.5 rounded-full bg-seal text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                    >
                      {t("dao.forumModeration.criticalHide")}
                    </button>
                  </>
                )}
                {canModerate && state.hidden && state.hiddenBy?.toLowerCase() !== dao.account?.toLowerCase() && (
                  <button
                    onClick={() => handleAction(targetEventId, MOD_ACTIONS.UNHIDE)}
                    disabled={busyKey === busyPrefix + MOD_ACTIONS.UNHIDE}
                    className="font-mono text-xs px-3 py-1.5 rounded-full border border-verdigris text-verdigrisBright hover:bg-verdigris/10 transition-colors disabled:opacity-40"
                  >
                    {t("dao.forumModeration.unhide")}
                  </button>
                )}
                {canModerate &&
                  state.hiddenReason === "critical" &&
                  !state.criticalConfirmed &&
                  state.criticalHideBy?.toLowerCase() !== dao.account?.toLowerCase() &&
                  !state.criticalConfirmations.some((a) => a?.toLowerCase() === dao.account?.toLowerCase()) && (
                    <button
                      onClick={() => handleAction(targetEventId, MOD_ACTIONS.CRITICAL_CONFIRM)}
                      disabled={busyKey === busyPrefix + MOD_ACTIONS.CRITICAL_CONFIRM}
                      className="font-mono text-xs px-3 py-1.5 rounded-full bg-gradient-to-r from-seal to-sealDeep text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                    >
                      {t("dao.forumModeration.confirmCritical")}
                    </button>
                  )}
                {canModerate && target && target !== "not_found" && target.address && (
                  <button
                    onClick={() => handleEscalate(targetEventId, target.address)}
                    className="font-mono text-xs px-3 py-1.5 rounded-full border border-hairline text-parchmentDim hover:text-parchment transition-colors flex items-center gap-1 ml-auto"
                  >
                    <ShieldAlert size={12} />
                    {t("dao.forumModeration.escalate")}
                    <ExternalLink size={10} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
