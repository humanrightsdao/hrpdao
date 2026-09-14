// src/components/SanctionProposalCard.jsx
//
// One DisciplineModule sanction case: Pending (Shield voting) →
// VetoWindow (Council veto) → Executed | Cancelled.
//
// Ported from hrpdaolens/dossier's ProposalsSection.jsx
// (SanctionProposalCard) — same contract, same state machine, same
// thresholds. The one thing deliberately NOT ported: the Lens
// post-lookup (fetchAllReportComments/fetchPostsByAuthor) used there to
// show a preview of the reported post. This app has no Lens
// integration and shouldn't grow one just to render a preview — the
// content lives in Dossier, so we link out to it there instead
// (VITE_DOSSIER_APP_URL/governance?case=<id>) — Dossier has no
// standalone "/moderation" route, ModerationQueue is mounted on its
// "/governance" page (see GovernancePage.jsx), the same handoff
// pattern Dossier's own GovernanceRedirect uses in reverse.

import { useTranslation } from "react-i18next";
import { tDaoMessage } from "../lib/daoMessages";
import { fmtDateTime, truncAddr } from "../lib/format";
import Identity from "./Identity";

const DOSSIER_APP_URL =
  import.meta.env.VITE_DOSSIER_APP_URL || "http://localhost:5173";

const SANCTION_STATUS_COLOR = {
  0: "#C9A227", // Pending — Shield voting
  1: "#3B7DFF", // VetoWindow — Council
  2: "#6FA0FF", // Executed
  3: "#8B8F99", // Cancelled
};

export default function SanctionProposalCard({
  p,
  hasShield,
  hasCouncil,
  actionLoading,
  onShieldVote,
  onFinalizeShieldVote,
  onVeto,
  onExecute,
  onRefresh,
}) {
  const { t } = useTranslation();

  const canVoteShield = hasShield && p.status === 0 && p.shieldVotingOpen;
  const canFinalize = p.status === 0 && p.canFinalizeShieldVote;
  const canVeto = hasCouncil && p.status === 1 && p.vetoWindowOpen;
  const canExecute = p.status === 1 && p.canExecute;
  const vetoPct = Math.min(100, p.vetoQuorumPct || 0);
  const statusColor = SANCTION_STATUS_COLOR[p.status] ?? "#8B8F99";
  const statusLabel = t(`dao.sanctionStatuses.${p.statusName}`, {
    defaultValue: p.statusName,
  });
  const typeLabel = t(`dao.sanctionTypes.${p.sTypeName}`, {
    defaultValue: p.sTypeName,
  });
  const periodLabel = t(`dao.restrictionPeriods.${p.periodName}`, {
    defaultValue: p.periodName,
  });

  const busy = (suffix) => actionLoading === p.id + suffix;

  return (
    <div className="rounded-2xl border border-hairline p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[12px] text-parchmentDim mb-1">
            {t("dao.moderation.caseId", { id: p.id })}
          </p>
          <h3 className="font-display text-lg text-parchment">
            {typeLabel}
            {p.sType === 1 && (
              <span className="text-parchmentDim font-body text-sm">
                {" "}
                ({periodLabel})
              </span>
            )}
          </h3>
          <p className="font-mono text-xs text-parchmentDim mt-1 flex items-center gap-1.5 flex-wrap">
            {/* showBadge=false: the moderation queue lists the target
                of a sanction case, not a post author — the "Social"
                source badge (Lens/Nostr) is meaningless noise here,
                unlike on ProposalsPage/Business Card where Identity
                shows who's actually posting/proposing. */}
            <Identity address={p.target} size={32} showBadge={false} />
          </p>
        </div>
        <span className="status-stamp" style={{ "--stamp-color": statusColor }}>
          {statusLabel}
        </span>
      </div>

      <a
        href={`${DOSSIER_APP_URL}/governance?case=${p.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 font-mono text-xs text-verdigrisBright hover:underline"
      >
        {t("dao.moderation.viewInDossier")}
      </a>
      <p className="font-mono text-[11px] text-parchmentDim/60 break-all">
        {t("dao.moderation.evidenceHash")}: {p.violationPostRef}
      </p>

      {/* Shield voting: two independent thresholds (turnout + approval),
          see DisciplineModule.sol / useDao.js getSanctionProposal(). */}
      <div className="space-y-2">
        <div>
          <div className="flex items-center justify-between text-[12px] mb-1">
            <span className="text-parchmentDim uppercase tracking-wide">
              {t("dao.moderation.participation")}
            </span>
            <span className="text-parchmentDim">
              {Math.min(100, p.participationPct ?? 0)}%
              {p.participationOk ? " ✓" : ""}
            </span>
          </div>
          <div className="h-[3px] rounded-full bg-hairline overflow-hidden">
            <div
              className={`h-full transition-all ${p.participationOk ? "bg-verdigris" : "bg-gold"}`}
              style={{ width: `${Math.min(100, p.participationPct ?? 0)}%` }}
            />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between text-[12px] mb-1">
            <span className="text-parchmentDim uppercase tracking-wide">
              {t("dao.moderation.approvalLabel")}
            </span>
            <span className="text-parchmentDim">
              {t("dao.moderation.approval", {
                pct: p.approvalPct ?? 0,
                required: p.approvalRequiredPct ?? "?",
              })}
            </span>
          </div>
          <div className="h-[3px] rounded-full bg-hairline overflow-hidden">
            <div
              className={`h-full transition-all ${p.approvalOk ? "bg-verdigris" : "bg-seal"}`}
              style={{ width: `${Math.min(100, p.approvalPct ?? 0)}%` }}
            />
          </div>
        </div>
        <p className="font-mono text-[12px] text-parchmentDim">
          {t("dao.moderation.shieldVoteSummary", {
            forVotes: p.shieldForVotes,
            against: p.shieldAgainstVotes,
            abstain: p.shieldAbstainVotes,
            deadline: fmtDateTime(p.shieldVoteDeadline),
          })}
        </p>
      </div>

      {/* Council veto window — only shown once it has actually opened. */}
      {p.vetoWindowOpenedAt > 0 && (
        <div>
          <div className="flex items-center justify-between text-[12px] mb-1">
            <span className="text-parchmentDim uppercase tracking-wide">
              {t("dao.moderation.councilVeto")}
            </span>
            <span className="text-parchmentDim">
              {t("dao.moderation.vetoProgress", {
                pct: vetoPct,
                required: p.vetoQuorumRequiredPct ?? 50,
              })}
            </span>
          </div>
          <div className="h-[3px] rounded-full bg-hairline overflow-hidden">
            <div
              className="h-full bg-seal transition-all"
              style={{ width: `${vetoPct}%` }}
            />
          </div>
          <p className="font-mono text-[12px] text-parchmentDim mt-1">
            {t("dao.moderation.vetoSummary", {
              votes: p.vetoForVotes,
              deadline: fmtDateTime(p.vetoDeadline),
            })}
          </p>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        {canVoteShield && (
          <>
            <VoteBtn
              label={t("dao.common.for")}
              color="verdigris"
              busy={busy("-shield-vote")}
              onClick={() => onShieldVote(0)}
            />
            <VoteBtn
              label={t("dao.common.against")}
              color="seal"
              busy={busy("-shield-vote")}
              onClick={() => onShieldVote(1)}
            />
            <VoteBtn
              label={t("dao.common.abstain")}
              color="parchmentDim"
              busy={busy("-shield-vote")}
              onClick={() => onShieldVote(2)}
            />
          </>
        )}
        {canFinalize && (
          <VoteBtn
            label={t("dao.moderation.finalizeShieldVote")}
            color="verdigris"
            busy={busy("-finalize")}
            onClick={onFinalizeShieldVote}
          />
        )}
        {canVeto && (
          <VoteBtn
            label={t("dao.moderation.castVeto")}
            color="seal"
            busy={busy("-veto")}
            onClick={onVeto}
          />
        )}
        {canExecute && (
          <VoteBtn
            label={t("dao.moderation.executeSanction")}
            color="gold"
            busy={busy("-execute-sanction")}
            onClick={onExecute}
          />
        )}
        {!canVoteShield && !canFinalize && !canVeto && !canExecute && (
          <span className="font-mono text-xs text-parchmentDim">
            {p.status === 2
              ? t("dao.moderation.sanctionExecuted")
              : p.status === 3
                ? t("dao.moderation.sanctionCancelled")
                : t("dao.moderation.noActionsAvailable")}
          </span>
        )}
        <button
          onClick={onRefresh}
          className="ml-auto font-mono text-xs text-parchmentDim hover:text-verdigrisBright transition-colors"
        >
          {t("dao.moderation.refresh")}
        </button>
      </div>
    </div>
  );
}

function VoteBtn({ label, color, busy, onClick }) {
  const cls =
    color === "verdigris"
      ? "border-verdigris text-verdigrisBright hover:bg-verdigris/10"
      : color === "seal"
        ? "border-seal text-sealBright hover:bg-seal/10"
        : color === "gold"
          ? "border-gold text-gold hover:bg-gold/10"
          : "border-hairline text-parchmentDim hover:bg-surface";
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`font-mono text-xs px-3 py-1.5 border rounded-sm transition-colors disabled:opacity-50 ${cls}`}
    >
      {busy ? "…" : label}
    </button>
  );
}

export { truncAddr };
