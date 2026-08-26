import { useEffect } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { fmtNum } from "../lib/format";
import ViolationsMap from "../components/ViolationsMap";
import DossierFeed from "../components/DossierFeed";

export default function HomePage() {
  const { t } = useTranslation();
  const dao = useOutletContext();

  useEffect(() => {
    dao.loadGovParams();
    dao.loadProposals();
    // Same fix as in ProposalsPage.jsx — readRef.current initializes
    // asynchronously in silentConnect(), so on a hard reload an empty
    // dependency array would fire this BEFORE the contracts are
    // ready. dao.account only becomes non-empty AFTER _initContracts().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.account]);

  const activeCount = dao.proposals.filter((p) => p.stateName === "Active").length;

  return (
    <div className="fade-rise">
      {/* ── Hero — in the style of the references (Sky/Uniswap/Optimism):
          dark background, blurred gradient orbs, a large bold headline ── */}
      <div className="relative rounded-3xl overflow-hidden border border-hairline bg-gradient-to-br from-surface via-ink to-surface p-8 sm:p-14 mb-10">
        <div
          className="gradient-orb w-72 h-72 bg-verdigris/25 -top-20 -left-10"
          aria-hidden
        />
        <div
          className="gradient-orb w-80 h-80 bg-seal/20 -bottom-24 right-0"
          aria-hidden
        />

        <div className="relative">
          <div className="inline-flex items-center gap-2 font-mono text-[12px] tracking-widest text-verdigrisBright uppercase bg-verdigris/10 border border-verdigris/25 rounded-full px-3 py-1 mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-verdigris animate-pulse" />
            {t("dao.home.sessionOpen")}
          </div>

          <h1 className="font-display font-semibold text-4xl sm:text-6xl leading-[1.05] text-parchment max-w-3xl">
            {t("dao.home.title")}
          </h1>
          <p className="mt-5 text-parchmentDim text-base sm:text-lg max-w-xl leading-relaxed">
            {t("dao.home.subtitle")}
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/proposals"
              className="px-5 py-2.5 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity"
            >
              {t("dao.home.viewProposals")}
            </Link>
            <Link
              to="/proposals/new"
              className="px-5 py-2.5 rounded-full border border-hairlineStrong text-parchment font-medium text-sm hover:border-verdigris hover:text-verdigrisBright transition-colors"
            >
              {t("dao.home.submitProposal")}
            </Link>
          </div>

          <div className="mt-10 flex flex-wrap gap-x-10 gap-y-5">
            <Stat label={t("dao.home.activeCases")} value={activeCount} />
            <Stat
              label={t("dao.home.quorum")}
              value={dao.govParams ? `${dao.govParams.quorumPct}%` : "—"}
            />
            <Stat
              label={t("dao.home.yourInfluence")}
              value={dao.isConnected ? fmtNum(dao.rights) : "—"}
              accent
            />
          </div>
        </div>
      </div>

      {/* ── Violations map — read-only, world view, sourced live from
          dossier's own Lens data (see src/lib/dossierViolations.js) ── */}
      <div className="mb-10">
        <ViolationsMap />
      </div>

      {/* ── Unified community feed — read-only, sourced live from
          dossier's "Planet Earth" feed (src/lib/dossierFeed.js) ── */}
      <DossierFeed />
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div className="font-mono text-[11px] uppercase tracking-widest text-parchmentDim mb-1">
        {label}
      </div>
      <div
        className={`font-display font-semibold text-2xl num-tabular ${accent ? "text-verdigrisBright" : "text-parchment"}`}
      >
        {value}
      </div>
    </div>
  );
}
