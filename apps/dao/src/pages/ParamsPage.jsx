import { useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Coins } from "lucide-react";
import { fmtNum, truncAddr } from "../lib/format";

const ADDR_LABELS = {
  rightsRegistry: "RightsRegistry",
  shieldSBT: "ShieldSBT",
  councilSBT: "CouncilSBT",
  daoGovernor: "DaoGovernor",
  daoTimelock: "DaoTimelock",
  disciplineModule: "DisciplineModule",
  humanityGate: "HumanityGate",
  tipJar: "TipJar",
  treasury: "Treasury",
};

export default function ParamsPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();

  useEffect(() => {
    dao.loadGovParams();
    dao.refreshTokenStatus?.();
    // Same fix as in ProposalsPage.jsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.account]);

  const p = dao.govParams;

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.params.governance")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-8">
        {t("dao.params.title")}
      </h1>

      {/* ── Influence token ────────────────────────────── */}
      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-4">
        <div className="flex items-center gap-2 mb-2">
          <Coins size={16} className="text-gold" />
          <span className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim">
            {t("dao.params.yourBalance")}
          </span>
        </div>
        <div className="font-display font-semibold text-4xl text-parchment num-tabular">
          {dao.isConnected ? fmtNum(dao.rights) : "—"}
        </div>
        <p className="font-mono text-xs text-parchmentDim mt-2">
          {t("dao.params.balanceNote")}
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 mb-8">
        <ParamCard label={t("dao.params.shieldThreshold")} value={t("dao.params.influenceUnit", { n: 200 })} accent="text-verdigrisBright" />
        <ParamCard label={t("dao.params.councilThreshold")} value={t("dao.params.influenceUnit", { n: 500 })} accent="text-gold" />
      </div>

      {/* ── Governance parameters ─────────────────────────── */}
      {!p ? (
        <p className="font-mono text-sm text-parchmentDim">{t("dao.params.loading")}</p>
      ) : (
        <>
          <div className="grid sm:grid-cols-2 gap-4 mb-8">
            <ParamCard label={t("dao.params.votingDelay")} value={t("dao.params.minutes", { n: p.votingDelayMinutes })} />
            <ParamCard label={t("dao.params.votingPeriod")} value={t("dao.params.minutes", { n: p.votingPeriodMinutes })} />
            <ParamCard label={t("dao.params.proposalThreshold")} value={fmtNum(p.proposalThreshold)} />
            <ParamCard label={t("dao.params.quorum")} value={`${p.quorumPct}% (${fmtNum(p.quorumNow)})`} />
          </div>

          <h2 className="font-display text-sm uppercase tracking-widest text-parchmentDim mb-3 border-t border-hairline pt-6">
            {t("dao.params.contractAddresses")}
          </h2>
          <div className="rounded-2xl border border-hairline overflow-hidden">
            {Object.entries(p.addresses || {})
              .filter(([k]) => ADDR_LABELS[k])
              .map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-center justify-between px-4 py-3 border-b border-hairline last:border-b-0"
                >
                  <span className="text-sm text-parchment">{ADDR_LABELS[k]}</span>
                  <span className="font-mono text-xs text-parchmentDim">{truncAddr(v)}</span>
                </div>
              ))}
          </div>

          <p className="mt-6 font-mono text-xs text-parchmentDim leading-relaxed">
            {t("dao.params.footerNote")}
          </p>
        </>
      )}
    </div>
  );
}

function ParamCard({ label, value, accent }) {
  return (
    <div className="rounded-2xl border border-hairline p-5">
      <div className="font-mono text-[11px] uppercase tracking-widest text-parchmentDim mb-1.5">
        {label}
      </div>
      <div
        className={`font-display font-semibold text-xl num-tabular ${accent || "text-parchment"}`}
      >
        {value}
      </div>
    </div>
  );
}
