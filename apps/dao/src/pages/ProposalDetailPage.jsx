import { useEffect, useState } from "react";
import { useParams, useOutletContext, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import StatusStamp from "../components/StatusStamp";
import VoteBar from "../components/VoteBar";
import { fmtRelative } from "../lib/format";
import Identity from "../components/Identity";
import { tDaoMessage } from "../lib/daoMessages";

const LIFECYCLE = ["Pending", "Active", "Succeeded", "Queued", "Executed"];
const STAGE_KEYS = {
  Pending: "stagePending", Active: "stageVoting", Succeeded: "stageSucceeded",
  Queued: "stageQueued", Executed: "stageExecuted",
};

export default function ProposalDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const dao = useOutletContext();
  const [busy, setBusy] = useState(null); // "for" | "against" | "abstain" | "queue" | "execute"
  const [actionMsg, setActionMsg] = useState(null);

  useEffect(() => {
    if (dao.proposals.length === 0) dao.loadProposals();
    // Same fix as in ProposalsPage.jsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.account]);

  useEffect(() => {
    if (id) dao.refreshProposalState(id);
  }, [id]);

  const p = dao.proposals.find((x) => String(x.id) === String(id));

  if (!p) {
    return (
      <div className="py-16 text-center font-mono text-sm text-parchmentDim">
        {dao.loadingProposals ? t("dao.proposalDetail.loading") : t("dao.proposalDetail.caseNotFound")}
      </div>
    );
  }

  const lifecycleIdx = LIFECYCLE.indexOf(p.stateName);
  const isDeadEnd = p.stateName === "Defeated" || p.stateName === "Canceled" || p.stateName === "Expired";

  async function handleVote(support) {
    setBusy(support);
    setActionMsg(null);
    const supportNum = { for: 1, against: 0, abstain: 2 }[support];
    const res = await dao.castVote(p.id, supportNum);
    setActionMsg(res.success ? t("dao.proposalDetail.voteRecorded") : tDaoMessage(t, res.error));
    setBusy(null);
  }

  async function handleQueue() {
    setBusy("queue");
    const res = await dao.queueProposal(p.id);
    setActionMsg(res.success ? t("dao.proposalDetail.caseQueued") : tDaoMessage(t, res.error));
    setBusy(null);
  }

  async function handleExecute() {
    setBusy("execute");
    const res = await dao.executeProposal(p.id);
    setActionMsg(res.success ? t("dao.proposalDetail.decisionExecuted") : tDaoMessage(t, res.error));
    setBusy(null);
  }

  return (
    <div className="fade-rise max-w-2xl">
      <Link to="/proposals" className="font-mono text-xs text-parchmentDim hover:text-verdigris">
        {t("dao.proposalDetail.backToDocket")}
      </Link>

      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <div className="font-mono text-xs text-verdigris uppercase tracking-widest mb-1">
            {t("dao.proposalDetail.caseNo", { n: String(p.id).slice(-4).padStart(4, "0") })}
          </div>
          <h1 className="font-display text-3xl text-parchment leading-snug">{p.title}</h1>
        </div>
        <StatusStamp state={p.stateName} />
      </div>

      <div className="mt-3 font-mono text-xs text-parchmentDim flex items-center gap-1.5 flex-wrap">
        {t("dao.proposalDetail.submittedBy")} <Identity address={p.proposer} size={32} /> · {fmtRelative(p.voteStart)}
      </div>

      {/* ── The lifecycle is a real sequence, so a numbered timeline
          fits here (unlike decorative 01/02/03) */}
      {!isDeadEnd && (
        <div className="mt-8 flex items-center">
          {LIFECYCLE.map((stage, i) => (
            <div key={stage} className="flex items-center flex-1 last:flex-initial">
              <div
                className={`w-2 h-2 rounded-full shrink-0 ${
                  i <= lifecycleIdx ? "bg-verdigris" : "bg-hairline"
                }`}
              />
              {i < LIFECYCLE.length - 1 && (
                <div
                  className={`h-px flex-1 ${i < lifecycleIdx ? "bg-verdigris" : "bg-hairline"}`}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {!isDeadEnd && (
        <div className="flex justify-between font-mono text-[11px] text-parchmentDim mt-1.5 uppercase tracking-wide">
          {LIFECYCLE.map((s) => (
            <span key={s}>{t(`dao.proposalDetail.${STAGE_KEYS[s]}`)}</span>
          ))}
        </div>
      )}

      <div className="mt-8 border-t border-hairline pt-6">
        <h2 className="font-display text-sm uppercase tracking-widest text-parchmentDim mb-3">
          {t("dao.proposalDetail.description")}
        </h2>
        <p className="text-parchment leading-relaxed whitespace-pre-wrap">{p.desc || p.description}</p>
      </div>

      <div className="mt-8 border-t border-hairline pt-6">
        <h2 className="font-display text-sm uppercase tracking-widest text-parchmentDim mb-3">
          {t("dao.proposalDetail.voteSummary")}
        </h2>
        <VoteBar
          forVotes={p.votes?.for || 0}
          againstVotes={p.votes?.against || 0}
          abstainVotes={p.votes?.abstain || 0}
        />
      </div>

      {p.stateName === "Active" && (
        <div className="mt-8 border-t border-hairline pt-6">
          <h2 className="font-display text-sm uppercase tracking-widest text-parchmentDim mb-3">
            {t("dao.proposalDetail.yourVote")}
          </h2>
          {!dao.isConnected ? (
            <p className="font-mono text-xs text-parchmentDim">
              {t("dao.proposalDetail.connectToVote")}
            </p>
          ) : p.userVoted ? (
            <p className="font-mono text-xs text-verdigrisBright">{t("dao.proposalDetail.alreadyVoted")}</p>
          ) : (
            <div className="flex flex-wrap gap-3">
              <VoteButton label={t("dao.common.for")} color="verdigris" busy={busy === "for"} onClick={() => handleVote("for")} />
              <VoteButton label={t("dao.common.against")} color="seal" busy={busy === "against"} onClick={() => handleVote("against")} />
              <VoteButton label={t("dao.common.abstain")} color="parchmentDim" busy={busy === "abstain"} onClick={() => handleVote("abstain")} />
            </div>
          )}
        </div>
      )}

      {p.stateName === "Succeeded" && (
        <div className="mt-8 border-t border-hairline pt-6">
          <button
            onClick={handleQueue}
            disabled={busy === "queue"}
            className="font-mono text-xs px-4 py-2 border border-gold text-gold rounded-sm hover:bg-gold/10 disabled:opacity-50"
          >
            {busy === "queue" ? t("dao.proposalDetail.queuing") : t("dao.proposalDetail.queueForExecution")}
          </button>
        </div>
      )}

      {p.stateName === "Queued" && (
        <div className="mt-8 border-t border-hairline pt-6">
          <button
            onClick={handleExecute}
            disabled={busy === "execute"}
            className="font-mono text-xs px-4 py-2 border border-verdigris text-verdigrisBright rounded-sm hover:bg-verdigris/10 disabled:opacity-50"
          >
            {busy === "execute" ? t("dao.proposalDetail.executing") : t("dao.proposalDetail.executeDecision")}
          </button>
        </div>
      )}

      {actionMsg && (
        <div className="mt-4 font-mono text-xs text-parchmentDim border-t border-hairline pt-4">
          {actionMsg}
        </div>
      )}
    </div>
  );
}

function VoteButton({ label, color, busy, onClick }) {
  const cls =
    color === "verdigris"
      ? "border-verdigris text-verdigrisBright hover:bg-verdigris/10"
      : color === "seal"
        ? "border-seal text-seal hover:bg-seal/10"
        : "border-hairline text-parchmentDim hover:bg-surface";
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={`font-mono text-xs px-4 py-2 border rounded-sm transition-colors disabled:opacity-50 ${cls}`}
    >
      {busy ? "…" : label}
    </button>
  );
}
