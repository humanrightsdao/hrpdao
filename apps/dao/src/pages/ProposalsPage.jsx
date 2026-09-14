import { useEffect, useState } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { FilePlus2 } from "lucide-react";
import ProposalCard from "../components/ProposalCard";

const FILTERS = ["All", "Active", "Pending", "Succeeded", "Queued", "Executed", "Defeated"];
const FILTER_KEYS = {
  All: "filterAll",
  Active: "filterVoting",
  Pending: "filterPending",
  Succeeded: "filterSucceeded",
  Queued: "filterQueued",
  Executed: "filterExecuted",
  Defeated: "filterDefeated",
};

export default function ProposalsPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const [filter, setFilter] = useState("All");

  useEffect(() => {
    dao.loadProposals();
    // Race condition: silentConnect() in Layout.jsx initializes the
    // contracts (readRef.current) ASYNCHRONOUSLY (there's even a
    // deliberate 800ms delay after switching networks) — on a hard
    // page reload this effect used to fire BEFORE readRef.current was
    // ready, and loadProposals() would silently fail with "Please
    // connect MetaMask first", never to be called again (empty
    // dependency array). On SPA navigation from another page the
    // contracts were already initialized earlier in the session, so
    // it worked. Depending on dao.account (which only becomes
    // non-empty AFTER _initContracts() inside silentConnect())
    // guarantees a re-call once the contracts are actually ready —
    // the same pattern already used correctly on other pages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.account]);

  const filtered =
    filter === "All" ? dao.proposals : dao.proposals.filter((p) => p.stateName === filter);

  return (
    <div className="fade-rise">
      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-[0.2em] text-verdigris uppercase mb-2">
            {t("dao.proposals.docket")}
          </div>
          <h1 className="font-display text-3xl text-parchment">{t("dao.proposals.title")}</h1>
        </div>
        <Link
          to="/proposals/new"
          className="flex items-center gap-1.5 px-4 py-2.5 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white text-sm font-medium hover:opacity-90 transition-opacity shrink-0"
        >
          <FilePlus2 size={15} />
          {t("dao.proposals.newProposal")}
        </Link>
      </div>

      <div className="flex flex-wrap gap-2 mb-6 border-b border-hairline pb-6">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`font-mono text-xs px-3 py-1.5 rounded-sm border transition-colors ${
              filter === f
                ? "border-verdigris text-verdigrisBright bg-surface2"
                : "border-hairline text-parchmentDim hover:text-parchment"
            }`}
          >
            {t(`dao.proposals.${FILTER_KEYS[f]}`)}
          </button>
        ))}
      </div>

      {dao.loadingProposals && (
        <div className="py-10 text-center text-parchmentDim font-mono text-sm">
          {t("dao.proposals.loadingDocket")}
        </div>
      )}

      {!dao.loadingProposals && filtered.length === 0 && (
        <div className="py-10 text-center text-parchmentDim font-mono text-sm">
          {t("dao.proposals.noCases")}
        </div>
      )}

      <div>
        {filtered.map((p) => (
          <ProposalCard key={p.id} proposal={p} />
        ))}
      </div>
    </div>
  );
}
