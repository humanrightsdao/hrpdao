import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import StatusStamp from "./StatusStamp";
import VoteBar from "./VoteBar";
import { fmtRelative } from "../lib/format";

export default function ProposalCard({ proposal }) {
  const { t } = useTranslation();
  const p = proposal;
  const docketNo = String(p.id).slice(-4).padStart(4, "0");

  return (
    <Link
      to={`/proposals/${p.id}`}
      className="group flex gap-4 sm:gap-6 py-5 border-b border-hairline hover:bg-surface/60 transition-colors px-2 -mx-2 rounded-sm"
    >
      <div className="shrink-0 w-16 sm:w-20 font-mono text-parchmentDim text-xs pt-1">
        <div className="text-[11px] uppercase tracking-widest mb-0.5">
          {t("dao.proposals.case")}
        </div>
        <div className="text-verdigris text-sm">№ {docketNo}</div>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-3 mb-2">
          <h3 className="font-display text-lg text-parchment leading-snug group-hover:text-verdigrisBright transition-colors">
            {p.title || t("dao.proposals.untitled")}
          </h3>
          <StatusStamp state={p.stateName} />
        </div>

        {p.votes && (
          <VoteBar
            forVotes={p.votes.for}
            againstVotes={p.votes.against}
            abstainVotes={p.votes.abstain}
            compact
          />
        )}

        <div className="mt-2 font-mono text-[12px] text-parchmentDim">
          {p.stateName === "Active"
            ? t("dao.proposals.votingEnds", { time: fmtRelative(p.voteEnd) })
            : p.stateName === "Pending"
              ? t("dao.proposals.votingStarts", { time: fmtRelative(p.voteStart) })
              : t("dao.proposals.submitted", { time: fmtRelative(p.voteStart) })}
        </div>
      </div>
    </Link>
  );
}
